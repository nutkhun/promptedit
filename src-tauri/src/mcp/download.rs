//! Fetches one audio file an agent found online (music for the edit) into a "Downloaded Music"
//! folder: next to the project when it's saved, otherwise in PromptEdit's own folder (Editroom's
//! `MediaDownload`). Only audio is kept, and where each file came from, and its licence, is written
//! down beside it in `Sources.txt`.

use futures_util::StreamExt;
use std::path::{Path, PathBuf};

pub const AUDIO_TYPES: [&str; 8] = ["mp3", "m4a", "aac", "wav", "aif", "aiff", "caf", "flac"];
pub const MAX_BYTES: u64 = 200 * 1024 * 1024;

pub fn folder(project: Option<&Path>) -> PathBuf {
    match project.and_then(Path::parent) {
        Some(dir) => dir.join("Downloaded Music"),
        None => super::data_dir().join("Downloaded Music"),
    }
}

/// A file name from what the agent called it: no path characters or control characters, ≤ 80 chars.
pub fn clean(s: &str) -> String {
    let t: String = s.chars().map(|c| if "/\\:?%*|\"<>".contains(c) || c.is_control() { ' ' } else { c }).collect();
    let t = t.trim();
    if t.is_empty() { "Music".into() } else { t.chars().take(80).collect() }
}

/// The file's type: from the link, the server's name for it, or the kind of data.
pub fn extension(url_path: &str, suggested: Option<&str>, mime: &str) -> String {
    let ext_of = |s: &str| Path::new(s).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let e = ext_of(url_path);
    if AUDIO_TYPES.contains(&e.as_str()) {
        return e;
    }
    if let Some(s) = suggested {
        let e = ext_of(s);
        if AUDIO_TYPES.contains(&e.as_str()) {
            return e;
        }
    }
    match mime {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => "m4a",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/flac" | "audio/x-flac" => "flac",
        _ => "mp3",
    }
    .into()
}

/// The name a server suggests in `Content-Disposition`.
fn suggested_name(h: &reqwest::header::HeaderMap) -> Option<String> {
    let v = h.get(reqwest::header::CONTENT_DISPOSITION)?.to_str().ok()?;
    let i = v.find("filename=")?;
    Some(v[i + 9..].trim_matches(|c| c == '"' || c == ';' || c == ' ').to_string())
}

/// Downloads `url` into `folder`, checks it's playable audio of a second or more, and notes its
/// source and licence. `allow_files` lets tests use `file://` links.
pub async fn fetch(
    url: &str,
    name: Option<&str>,
    source_page: Option<&str>,
    licence: Option<&str>,
    folder: &Path,
    allow_files: bool,
) -> Result<PathBuf, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "url is needed: the https link to the audio file.".to_string())?;
    let (bytes_path, suggested, mime): (PathBuf, Option<String>, String);
    let tmp = std::env::temp_dir().join(format!("promptedit-download-{}", promptedit_core::Id::new().0.simple()));
    match parsed.scheme() {
        "https" => {
            let client = reqwest::Client::builder()
                .user_agent(super::APP_NAME)
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| e.to_string())?;
            let resp = client.get(parsed.clone()).send().await.map_err(|e| format!("Couldn't download it: {e}"))?;
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("The site answered {}; that link didn't give a file.", status.as_u16()));
            }
            let m = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
            let m = m.split(';').next().unwrap_or("").trim().to_string();
            if m.starts_with("text/") || m.contains("html") || m.contains("json") {
                return Err("That link is a web page, not an audio file. Find the direct link to the file (it usually ends in .mp3 or .wav).".into());
            }
            suggested = suggested_name(resp.headers());
            mime = m;
            let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
            let mut size = 0u64;
            let mut stream = resp.bytes_stream();
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("Couldn't download it: {e}"))?;
                size += chunk.len() as u64;
                if size > MAX_BYTES {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    return Err("That file is over 200 MB, too big for a music track.".into());
                }
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            file.flush().await.map_err(|e| e.to_string())?;
            bytes_path = tmp.clone();
        }
        "file" if allow_files => {
            let src = parsed.to_file_path().map_err(|_| "Bad file link.".to_string())?;
            std::fs::copy(&src, &tmp).map_err(|e| format!("Couldn't download it: {e}"))?;
            suggested = None;
            mime = String::new();
            bytes_path = tmp.clone();
        }
        _ => return Err("Use an https link to the audio file.".into()),
    }
    let cleanup = |p: &Path| {
        let _ = std::fs::remove_file(p);
    };
    let size = std::fs::metadata(&bytes_path).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        cleanup(&bytes_path);
        return Err("The download was empty.".into());
    }
    if size > MAX_BYTES {
        cleanup(&bytes_path);
        return Err("That file is over 200 MB, too big for a music track.".into());
    }
    let ext = extension(parsed.path(), suggested.as_deref(), &mime);
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let url_base = Path::new(parsed.path()).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let base = clean(
        name.map(String::from)
            .or_else(|| suggested.as_deref().and_then(|s| Path::new(s).file_stem()).map(|s| s.to_string_lossy().into_owned()))
            .unwrap_or(url_base)
            .as_str(),
    );
    let mut dest = folder.join(format!("{base}.{ext}"));
    let mut n = 2;
    while dest.exists() {
        dest = folder.join(format!("{base} {n}.{ext}"));
        n += 1;
    }
    std::fs::copy(&bytes_path, &dest).map_err(|e| e.to_string())?;
    cleanup(&bytes_path);
    // Only keep it if it really is sound, at least a second long.
    let probe = crate::media::probe(&dest);
    let ok = probe.as_ref().is_ok_and(|p| (p.has_audio || p.kind == promptedit_core::MediaKind::Audio) && p.duration >= 1.0);
    if !ok {
        cleanup(&dest);
        return Err(format!("That file isn't audio {} can play. Find the direct link to an .mp3 or .wav.", super::APP_NAME));
    }
    // Where it came from, for the person (and anyone who asks later).
    let entry = format!(
        "{}\n  Downloaded: {}\n  File: {}\n  Found on: {}\n  Licence: {}\n\n",
        dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        iso8601_now(),
        parsed,
        source_page.filter(|s| !s.is_empty()).unwrap_or("not given"),
        licence.filter(|s| !s.is_empty()).unwrap_or("not given"),
    );
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(folder.join("Sources.txt")) {
        let _ = f.write_all(entry.as_bytes());
    }
    Ok(dest)
}

/// Now, as `2026-11-27T10:15:00Z`.
pub fn iso8601_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    iso8601(secs)
}

pub fn iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_types() {
        assert_eq!(clean("a/b:c?\n"), "a b c");
        assert_eq!(clean("  "), "Music");
        assert_eq!(extension("/x/song.MP3", None, ""), "mp3");
        assert_eq!(extension("/dl", Some("t.wav"), ""), "wav");
        assert_eq!(extension("/dl", None, "audio/x-m4a"), "m4a");
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_795_000_000), "2026-11-18T11:06:40Z");
    }
}
