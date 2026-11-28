"""How labels.json's numbers were tuned (not shipped, not run by the app or tests).

Needs Python 3 with numpy, Pillow and onnxruntime, and the three model files (src/scenes/model.rs)
in MODEL_DIR. Reads the first 100-150 MB of nine PxHere shards (CC0 photos with their tags, from
the nyuuzyou/pxhere dataset on Hugging Face) into CACHE_DIR: about 360 photos.

  python3 -I calibrate.py MODEL_DIR CACHE_DIR

Prints:
- zscore slope/intercept: a logistic fit of "the label's word is among the photo's tags" on how
  far the label stands out from the photo's others (z over the label list). The tags are
  incomplete, so it's conservative: a fitted 0.35 keeps about 3 labels a photo.
- each category's offset: the 95th percentile of its contrast (best sentence minus the neutral
  sentences) over photos whose tags have none of the category's words, so a category is kept for
  about 1 in 20 photos it isn't in.

The shipped numbers came from these photos (the z-score fit on a 240-photo split, the offsets on
all of them, within ±0.0013 of what this prints); "laughter" and "smile" were then raised by hand
(0.011, 0.016) after they showed up on close-ups that weren't laughing or smiling. The person
categories' `notIf` rule came from the same photos: on the 56 photos of animals it removed all 14
times a person category was kept, and on the 70 photos of people it kept 72 of 80.
"""
import io, json, os, re, subprocess, sys, tarfile
import numpy as np, onnxruntime as ort
from PIL import Image

MODEL, CACHE = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
PX = "https://huggingface.co/datasets/nyuuzyou/pxhere/resolve/9a0820f476ea1ba00f6053e63bc81f24c5eb605f"
SHARDS = ["000000", "000050", "000100", "000200", "000300", "000400", "000500", "000600", "000700"]

# CLIP's tokenizer, as tokenizer.rs.
tok = json.load(open(os.path.join(MODEL, "tokenizer.json")))["model"]
vocab = tok["vocab"]
ranks = {tuple(m.split(" ") if isinstance(m, str) else m): i for i, m in enumerate(tok["merges"])}
bs = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
cs, n = bs[:], 0
for b in range(256):
    if b not in bs:
        bs.append(b); cs.append(256 + n); n += 1
b2u = dict(zip(bs, map(chr, cs)))
SPLIT = re.compile(r"'s|'t|'re|'ve|'m|'ll|'d|[^\W\d_]+|\d|[^\s\w]+|_+", re.I)

def bpe(word):
    s = list(word[:-1]) + [word[-1] + "</w>"]
    while len(s) > 1:
        r, i = min((ranks.get((s[i], s[i + 1]), 1e18), i) for i in range(len(s) - 1))
        if r == 1e18: break
        s = s[:i] + [s[i] + s[i + 1]] + s[i + 2:]
    return s

def encode(t):
    ids = [49406]
    for w in SPLIT.findall(" ".join(t.split()).lower()):
        ids += [vocab[p] for p in bpe("".join(b2u[b] for b in w.encode()))]
    return ids + [49407]

text = ort.InferenceSession(os.path.join(MODEL, "text_model_quantized.onnx"))
vision = ort.InferenceSession(os.path.join(MODEL, "vision_model_quantized.onnx"))

def embed_text(sentences):
    out = []
    for k in range(0, len(sentences), 64):
        ids = [encode(s) for s in sentences[k:k + 64]]; L = max(map(len, ids))
        out.append(text.run(None, {"input_ids": np.array([i + [49407] * (L - len(i)) for i in ids], np.int64)})[0])
    e = np.concatenate(out)
    return e / np.linalg.norm(e, axis=1, keepdims=True)

MEAN, STD = np.array([0.48145466, 0.4578275, 0.40821073]), np.array([0.26862954, 0.26130258, 0.27577711])

def embed_image(img):
    w, h = img.size; s = 224 / min(w, h)
    img = img.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
    w, h = img.size; l, t = (w - 224) // 2, (h - 224) // 2
    a = ((np.asarray(img.crop((l, t, l + 224, t + 224)), np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]
    e = vision.run(None, {"pixel_values": a.astype(np.float32)})[0][0]
    return e / np.linalg.norm(e)

os.makedirs(CACHE, exist_ok=True)
photos, tags = {}, {}
for sh in SHARDS:
    f = os.path.join(CACHE, sh + ".tar")
    if not os.path.exists(f):
        subprocess.run(["curl", "-sL", "-r", "0-104857599", "-o", f, f"{PX}/pxhere-{sh}.tar"], check=True)
    t = tarfile.open(f, ignore_zeros=True)
    try:
        for m in t:
            k = m.name.split(".")[0]
            if m.name.endswith(".json"):
                tags[k] = json.load(t.extractfile(m))["tags"]
            elif m.name.lower().endswith((".jpg", ".jpeg", ".png")):
                im = Image.open(io.BytesIO(t.extractfile(m).read())); im.draft("RGB", (448, 448))
                photos[k] = im.convert("RGB")
    except (tarfile.ReadError, EOFError, OSError):
        pass  # the cut-off end of the range
keys = [k for k in photos if k in tags]
I = np.stack([embed_image(photos[k]) for k in keys])
W = [set(re.findall(r"[a-z]+", " ".join(tags[k]).lower())) for k in keys]
print(len(keys), "photos")

d = json.load(open(os.path.join(HERE, "labels.json")))
names = [l.replace("_", " ") for l in d["labels"]]
C = I @ embed_text([d["prompt"].replace("{}", x) for x in names]).T
Z = (C - C.mean(1, keepdims=True)) / C.std(1, keepdims=True)
X, Y = [], []
for r in range(len(keys)):
    for i in np.argsort(-C[r])[:30]:
        X.append(Z[r, i]); Y.append(any(w in W[r] or w.rstrip("s") in W[r] for w in names[i].split()))
X, Y, w = np.array(X), np.array(Y, float), np.zeros(2)
for _ in range(4000):
    p = 1 / (1 + np.exp(-(w[0] * X + w[1]))); w -= 0.1 * np.array([((p - Y) * X).mean(), (p - Y).mean()])
print("zscore: slope %.3f intercept %.3f" % tuple(w))

# Words a category's photos have in their tags.
WORDS = {
    "people": "woman man person people girl boy child men women kid kids baby couple bride portrait model",
    "adult": "woman man men women bride model", "child": "child kid kids baby boy children",
    "animal": "dog cat bird animal animals horse insect butterfly fish mammal pet wildlife",
    "plant": "plant plants flower flowers tree leaf leaves grass flora",
    "food": "food dish meal dessert fruit vegetable cake bread",
    "vehicle": "car vehicle bus truck train boat motorcycle bicycle airplane",
    "structure": "building architecture house tower church bridge facade city",
    "water_body": "sea water lake river ocean pond", "sky": "sky cloud clouds sunset",
    "night": "night darkness dark midnight evening", "laughter": "laughing laugh laughter fun",
    "smile": "smile smiling happy happiness",
}
base = (I @ embed_text(d["neutral"]).T).mean(1)
for c, v in d["categories"].items():
    s = (I @ embed_text(v["prompts"]).T).max(1) - base
    y = np.array([bool(set(WORDS[c].split()) & w) for w in W])
    print("%-10s offset %.4f (now %.4f)" % (c, np.percentile(s[~y], 95), v["offset"]))
