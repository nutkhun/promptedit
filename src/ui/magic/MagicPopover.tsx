// The Magic popover (docs/spec/03-mcp-magic.md §3.2): a switch picks Claude, ChatGPT or Local. An AI
// that's ready shows the prompt; one that isn't walks through connecting it right here.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, inTauri } from "../../api";
import { useStore } from "../../store";
import { PillButton, Spinner } from "../buttons";
import { Glyph } from "../icons";
import { magicApi, effortBlurb, effortName, type AiKind, type Tab } from "./magicApi";
import { chosenEffort, chosenModel, useMagic } from "./magicStore";
import { hasEdit as projectHasEdit, pointersOf } from "./mentions";
import { PromptBox } from "./PromptBox";

const NAMES: Record<AiKind, string> = { claude: "Claude", chatgpt: "ChatGPT" };
const NONE: never[] = [];

type Idea = [name: string, symbol: string, prompt: string];
const AI_IDEAS: Record<"improve" | "create" | "sound", Idea[]> = {
  improve: [
    ["Tighten it", "scissors", "Make this shorter so people keep watching: open on the strongest moment, cut the slow starts and ends of shots, and drop weak or repeated shots."],
    ["Cut to the beat", "music.note", "Recut this to the beat of the music: cuts on beats, the biggest moments on bar starts, and end on a bar."],
    ["Smooth it out", "sparkles", "Smooth this out: fix jumpy cuts, add a dissolve only where the scene changes, even out the sound, and fade in and out."],
    ["One look", "camera.filters", "Give it one consistent look: the same warm film grade on every shot, matched in brightness so it feels like one film."],
  ],
  create: [
    ["Story", "text.bubble", "Make the best story you can from this footage: a clear beginning, middle and end, the strongest moments where they land hardest, and shots left to breathe where it matters."],
    ["Highlight reel", "wand.and.stars", "Make a 30 to 60 second highlight reel of the best moments, cut to the beat of the music, opening on the strongest shot and ending on a bar."],
    ["Timelapse", "clock", "Make a timelapse over the music: speed the footage up, cut out the dead space where nothing changes, keep the moments where something happens, and end on the strongest shot."],
    ["Vlog", "person.wave.2", "Make an engaging vlog, up to 8 minutes: hook in the first few seconds, keep the parts where someone is talking or something happens, cut pauses, retakes and repeats, and add short titles to mark each part."],
    ["Vertical reel", "rectangle", "Make a fast, punchy 15 to 30 second vertical video for Reels and TikTok: 1080 by 1920, a hook in the first second, quick cuts on the beat."],
  ],
  sound: [
    ["Find music", "magnifyingglass", "Find music that suits this video and add it to the timeline. Make sure the music is royalty free and does not require attribution."],
    ["Music and levels", "music.note", "Pick the best music in my Media for this edit, cut so the music and pictures land together, keep voices clear over it, and fade in and out."],
  ],
};
const LOCAL_IDEAS: Record<"improve" | "create" | "sound", Idea[]> = {
  improve: [
    ["Tighten it", "scissors", "Make it shorter and faster."],
    ["Cut to the beat", "music.note", "Cut it to the beat of the music."],
    ["One look", "camera.filters", "Give every shot the Film print look."],
    ["Clean it up", "sparkles", "Take out repeats and weak shots, and trim long shots."],
  ],
  create: [
    ["Quick cut", "wand.and.stars", "Make a new quick cut of the best moments, to the beat."],
    ["30-second highlight", "sparkles", "Make a fast 30 second highlight cut to the beat."],
    ["Vertical reel", "rectangle", "Make a 20 second vertical video, fast."],
    ["Timelapse", "clock", "Speed every shot up 8x, over the music."],
    ["Slow and calm", "circle.dotted", "Make a calm 60 second cut."],
  ],
  sound: [["Even out levels", "slider.horizontal.3", "Make all audio clips the same output level."]],
};

/** A small menu opened from an icon button (Ideas, History, the model and effort chips). */
function Menu({ trigger, children, width = 260, align = "right" }: { trigger: (open: () => void, on: boolean) => ReactNode; children: (close: () => void) => ReactNode; width?: number; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <div className="mg-menu-host" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && <div className={`mg-menu ${align}`} style={{ width }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

function IdeasMenu({ ideas, edit, use }: { ideas: typeof AI_IDEAS; edit: boolean; use: (s: string) => void }) {
  const sections: [string, Idea[]][] = [...(edit ? [["Improve", ideas.improve] as [string, Idea[]]] : []), ["Create", ideas.create], ["Sound", ideas.sound]];
  return (
    <Menu trigger={(open, on) => (
      <button type="button" className={`mg-menu-icon${on ? " on" : ""}`} title="Ideas" aria-label="Ideas" onClick={open}><Glyph symbol="lightbulb" size={11} weight="semibold" /></button>
    )} width={220}>
      {(close) => sections.map(([title, list], i) => (
        <div key={title}>
          {i > 0 && <div className="mg-menu-sep" />}
          <div className="mg-menu-header">{title}</div>
          {list.map(([name, symbol, prompt]) => (
            <button key={name} type="button" className="mg-menu-item" onClick={() => { use(prompt); close(); }}>
              <Glyph symbol={symbol} size={11} /> <span>{name}</span>
            </button>
          ))}
        </div>
      ))}
    </Menu>
  );
}

function HistoryMenu({ use }: { use: (s: string) => void }) {
  const history = useStore((s) => s.project.magicHistory) ?? [];
  return (
    <Menu trigger={(open, on) => (
      <button type="button" className={`mg-menu-icon${on ? " on" : ""}`} title="History" aria-label="History" onClick={open}><Glyph symbol="clock.arrow.circlepath" size={11} weight="semibold" /></button>
    )} width={270}>
      {(close) => (
        <>
          <div className="mg-menu-header">History</div>
          {history.length === 0 && <div className="mg-menu-item disabled">Prompts you send show up here.</div>}
          <div className="mg-history">
            {history.map((h) => (
              <button key={h.text} type="button" className="mg-menu-item history" onClick={() => { use(h.text); close(); }}>
                <span className="text">{h.text}</span>
                <span className="badge">{h.tab === "chatgpt" ? "ChatGPT" : h.tab === "claude" ? "Claude" : "Local"}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Menu>
  );
}

function Chip({ label, symbol, onClick, on }: { label: string; symbol?: string; onClick: () => void; on: boolean }) {
  return (
    <button type="button" className={`mg-chip${on ? " on" : ""}`} onClick={onClick}>
      {symbol && <Glyph symbol={symbol} size={10} weight="semibold" />}
      <span>{label}</span>
      <Glyph symbol="chevron.down" size={8} weight="bold" />
    </button>
  );
}

function ModelChips({ kind }: { kind: AiKind }) {
  // Re-render when the lists or the picks change.
  useMagic((s) => s.model);
  useMagic((s) => s.effort);
  const setModel = useMagic((s) => s.setModel);
  const models = useMagic((s) => s.models[kind]) ?? NONE;
  const model = chosenModel(kind);
  const effort = chosenEffort(kind);
  return (
    <div className="mg-chips">
      <Menu align="left" width={210} trigger={(open, on) => <Chip label={model?.name ?? "Default"} onClick={open} on={on} />}>
        {(close) => models.map((m) => (
          <button key={m.id} type="button" className={`mg-menu-item${m.id === model?.id ? " checked" : ""}`}
            onClick={() => { setModel(kind, m.id, m.efforts.includes(effort) ? effort : m.defaultEffort); close(); }}>
            <span className="check">{m.id === model?.id && <Glyph symbol="checkmark" size={9} weight="bold" />}</span>
            <span>{m.name}</span><span className="blurb">{m.blurb}</span>
          </button>
        ))}
      </Menu>
      {model && model.efforts.length > 0 && (
        <Menu align="left" width={170} trigger={(open, on) => <Chip label={effortName(effort)} onClick={open} on={on} />}>
          {(close) => model.efforts.map((e) => (
            <button key={e} type="button" className={`mg-menu-item${e === effort ? " checked" : ""}`} onClick={() => { setModel(kind, model.id, e); close(); }}>
              <span className="check">{e === effort && <Glyph symbol="checkmark" size={9} weight="bold" />}</span>
              <span>{effortName(e)}</span><span className="blurb">{effortBlurb(e)}</span>
            </button>
          ))}
        </Menu>
      )}
    </div>
  );
}

/** Claude's sparkle and the OpenAI knot as plain marks in their colours (no brand artwork). */
export function AgentLogo({ tab, size = 15 }: { tab: Tab | AiKind | null | undefined; size?: number }) {
  if (tab === "claude" || tab === "chatgpt") {
    return (
      <span className={`mg-logo ${tab}`} style={{ width: size, height: size, borderRadius: size * 0.24, fontSize: size * 0.55 }}>
        {tab === "claude" ? "✳" : "◎"}
      </span>
    );
  }
  return <span className="mg-logo local" style={{ width: size, height: size }}><Glyph symbol="wand.and.sparkles" size={size * 0.7} weight="semibold" /></span>;
}

function Tabs() {
  const tab = useMagic((s) => s.tab);
  const setTab = useMagic((s) => s.setTab);
  return (
    <div className="mg-tabs" role="tablist">
      {(["claude", "chatgpt", "local"] as Tab[]).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={t === tab} className={`mg-tab${t === tab ? " on" : ""}`} onClick={() => setTab(t)}>
          <AgentLogo tab={t} size={15} />
          <span>{t === "claude" ? "Claude" : t === "chatgpt" ? "ChatGPT" : "Local"}</span>
        </button>
      ))}
    </div>
  );
}

function Centered({ tab, title, text, children, error }: { tab: AiKind; title: string; text: string; children: ReactNode; error?: string }) {
  return (
    <div className="mg-centered">
      <AgentLogo tab={tab} size={36} />
      <div className="title">{title}</div>
      <div className="text">{text}</div>
      {children}
      {error && <div className="mg-error">{error}</div>}
    </div>
  );
}

const open = (url: string) => (inTauri ? void openUrl(url) : window.open(url, "_blank", "noopener"));

export function MagicPopover({ close }: { close: () => void }) {
  const tab = useMagic((s) => s.tab);
  const prompt = useMagic((s) => s.prompt);
  const set = useMagic((s) => s.set);
  const availability = useMagic((s) => s.availability);
  const localNote = useMagic((s) => s.localNote);
  const refresh = useMagic((s) => s.refresh);
  const edit = useStore((s) => projectHasEdit(s.project));
  const [justConnected, setJustConnected] = useState<AiKind | null>(null);
  const [working, setWorking] = useState<AiKind | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void refresh();
    // On opening: "@selected " when clips are selected and the box is empty (or only that).
    const sel = useStore.getState().selection.size;
    const p = useMagic.getState().prompt;
    if (p.trim() === "" || p.trim() === "@selected") set({ prompt: sel ? "@selected " : "" });
  }, [refresh, set]);

  // While Claude's install box is open, watch for it finishing.
  const waiting = availability?.claude.waiting;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [waiting, refresh]);

  const go = async () => {
    const s = useStore.getState();
    const kind = tab === "local" ? null : tab;
    const text = useMagic.getState().prompt.trim();
    close();
    set({ prompt: "" });
    try {
      await magicApi.start({
        tab, prompt: text, pointers: pointersOf(s.project, s.selection, s.playhead),
        model: kind ? chosenModel(kind)?.id ?? "" : "", effort: kind ? chosenEffort(kind) : "",
      });
      s.set({ playing: false });
      const run = await useMagic.getState().poll();
      // Already done (the dev server runs Local to the end before answering): show the result now.
      if (run && !run.running) useStore.getState().apply(await api.getProject());
    } catch (e) {
      set({ prompt: text });
      useStore.getState().set({ error: String(e) });
    }
  };

  const connect = async (kind: AiKind) => {
    const a = availability?.[kind];
    if (!a) return;
    setWorking(kind);
    setError(undefined);
    try {
      await magicApi.connect(a.connectApp);
      await refresh();
      const now = useMagic.getState().availability?.[kind];
      if (now?.connected) setJustConnected(kind);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
    }
  };

  const form = (kind: AiKind | null) => {
    const name = kind ? NAMES[kind] : "Local";
    const placeholder = kind
      ? edit
        ? `Describe what to change, or leave this empty and ${name} will make the best video it can from your Media.`
        : `Describe the video you want, or leave this empty and ${name} will make the best video it can from the clips and music in your Media.`
      : edit
        ? "Describe what to change (length, pace, look, music, vertical), or leave this empty to improve the edit."
        : "Describe the video you want (length, pace, look, music, vertical), or leave this empty for the best cut.";
    return (
      <div className="mg-form">
        <div className="mg-form-head">
          <div className="mg-heading">{edit ? "What should change?" : "What should it make?"}</div>
          <span style={{ flex: 1 }} />
          <IdeasMenu ideas={kind ? AI_IDEAS : LOCAL_IDEAS} edit={edit} use={(p) => set({ prompt: p })} />
          <HistoryMenu use={(p) => set({ prompt: p })} />
        </div>
        <PromptBox value={prompt} onChange={(v) => set({ prompt: v })} placeholder={placeholder} onSubmit={() => void go()} onEscape={close} />
        {!kind && localNote && <div className="mg-local-note">{localNote}</div>}
        <div className="mg-form-foot">
          <div className="mg-model">
            {kind ? <ModelChips kind={kind} /> : <LocalModelLabel />}
            <div className="mg-plan">{kind ? `Uses your ${name} plan` : onThisComputer()}</div>
          </div>
          <span style={{ flex: 1 }} />
          <PillButton prominent onClick={() => void go()}>Make it</PillButton>
        </div>
      </div>
    );
  };

  const content = () => {
    if (tab === "local") return form(null);
    const kind = tab;
    const name = NAMES[kind];
    const a = availability?.[kind];
    if (!a) return <div className="mg-loading"><Spinner /></div>;
    if (justConnected === kind) {
      return (
        <Centered tab={kind} title={`${name} is connected`} text={kind === "claude"
          ? "Tell it what to make. You can disconnect any time in AI Agents."
          : "Tell it what to make. To edit from the ChatGPT app as well, quit and reopen it once."}>
          <PillButton prominent onClick={() => setJustConnected(null)}>Continue</PillButton>
        </Centered>
      );
    }
    if (!a.installed) {
      return (
        <Centered tab={kind} title={`Get the ${name} app`} text={kind === "claude"
          ? `Claude edits for you through the Claude app ${onThisLower()}. Install it, then come back to connect.`
          : `ChatGPT edits for you through Codex in the ChatGPT app ${onThisLower()}. Install it, then come back to connect.`}>
          <PillButton prominent onClick={() => open(kind === "claude" ? "https://claude.ai/download" : "https://chatgpt.com/download")}>Download {name}</PillButton>
        </Centered>
      );
    }
    if (kind === "claude" && a.waiting) {
      return (
        <Centered tab={kind} title="Finish in the Claude app" text="Claude is asking whether to add PromptEdit. Click Install there and this updates by itself.">
          <div className="mg-row">
            <PillButton onClick={() => void magicApi.cancelWaiting().then(refresh)}>Cancel</PillButton>
            <PillButton onClick={() => void magicApi.reopenClaude()}>Open Claude again</PillButton>
          </div>
        </Centered>
      );
    }
    if (!a.connected) {
      return (
        <Centered tab={kind} error={error} title={`Connect ${name}`} text={kind === "claude"
          ? "Let Claude edit for you, with your Claude plan. Nothing is shared until you ask it to make an edit."
          : "Let ChatGPT edit for you, with your ChatGPT plan. It works through Codex in the ChatGPT app."}>
          <div className="mg-connect">
            <PillButton prominent disabled={working === kind} onClick={() => void connect(kind)}>
              {working === kind ? <Spinner size={12} /> : `Connect ${name}`}
            </PillButton>
            <div className="mg-faint">No API key needed</div>
          </div>
        </Centered>
      );
    }
    if (!a.runnable) {
      return (
        <Centered tab={kind} title={kind === "claude" ? "Open Claude Code once" : "Codex isn't here yet"} text={kind === "claude"
          ? "Magic uses Claude Code, which comes with the Claude app. Open the Claude app's Code tab once, then come back."
          : "Magic uses Codex, which comes with the ChatGPT app. Open the ChatGPT app's Codex once, then come back."}>
          <PillButton prominent onClick={() => void refresh()}>Check again</PillButton>
        </Centered>
      );
    }
    return form(kind);
  };

  return (
    <div className="mg-popover" role="dialog" aria-label="Magic">
      <Tabs />
      <div className="mg-content">{content()}</div>
    </div>
  );
}

function LocalModelLabel() {
  const model = useMagic((s) => s.localModel);
  return (
    <div className="mg-local-model">
      <Glyph symbol="wand.and.sparkles" size={10} weight="semibold" />
      <span>{model ? `Local model: ${model}` : "Keywords (no local model)"}</span>
    </div>
  );
}

const platform = typeof navigator !== "undefined" ? navigator.platform : "";
const onThisComputer = () => (/Mac/.test(platform) ? "On this Mac" : /Win/.test(platform) ? "On this PC" : "On this computer");
const onThisLower = () => (/Mac/.test(platform) ? "on this Mac" : /Win/.test(platform) ? "on this PC" : "on this computer");
