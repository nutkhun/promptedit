//! How times are shown and typed (Editroom/Model/Project.swift `Timecode`).

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimeStyle {
    /// "00:00:05:15"
    #[default]
    Timecode,
    /// "0:05.50"
    Simple,
}

pub fn string(t: f64, fps: f64, style: TimeStyle) -> String {
    match style {
        TimeStyle::Simple => simple(t),
        TimeStyle::Timecode => full(t, fps),
    }
}

/// Minutes, seconds and hundredths ("0:05.50"), with hours when there are any.
pub fn simple(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as i64;
    let (c, secs) = (cs % 100, cs / 100);
    let (s, m, h) = (secs % 60, (secs / 60) % 60, secs / 3600);
    if h > 0 { format!("{h}:{m:02}:{s:02}.{c:02}") } else { format!("{m}:{s:02}.{c:02}") }
}

pub fn full(t: f64, fps: f64) -> String {
    let f = (fps.round() as i64).max(1);
    let total = (t.max(0.0) * fps).round() as i64;
    let frames = total % f;
    let secs = total / f;
    let (s, m, h) = (secs % 60, (secs / 60) % 60, secs / 3600);
    format!("{h:02}:{m:02}:{s:02}:{frames:02}")
}

/// Reads a typed timecode. "1:02:03" counts from the right (frames, seconds, minutes, hours);
/// plain digits are read in pairs from the right, so "1000" is 10 seconds. With simple times,
/// "0:05.50" or "1:05" is minutes and seconds.
pub fn parse(s: &str, fps: f64, style: TimeStyle) -> Option<f64> {
    let f = (fps.round() as i64).max(1);
    let text = s.trim();
    if style == TimeStyle::Simple && is_simple(text) {
        let mut total = 0.0;
        for p in text.split(':') {
            total = total * 60.0 + p.parse::<f64>().unwrap_or(0.0);
        }
        return Some(total);
    }
    let mut parts: Vec<i64> = Vec::new();
    if text.contains([':', ';', '.']) {
        let comps: Vec<&str> = text.split([':', ';', '.']).filter(|c| !c.is_empty()).collect();
        if comps.is_empty() || comps.len() > 4 {
            return None;
        }
        for c in comps {
            parts.push(c.parse::<i64>().ok().filter(|v| *v >= 0)?);
        }
    } else {
        if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) || text.len() > 8 {
            return None;
        }
        let digits: Vec<char> = text.chars().collect();
        let mut end = digits.len();
        while end > 0 {
            let start = end.saturating_sub(2);
            parts.insert(0, digits[start..end].iter().collect::<String>().parse().unwrap_or(0));
            end = start;
        }
    }
    let mut r: Vec<i64> = parts.into_iter().rev().collect();
    r.extend([0, 0, 0, 0]);
    let frames = ((r[3] * 60 + r[2]) * 60 + r[1]) * f + r[0];
    Some(frames as f64 / fps)
}

/// `^\d+(:\d{1,2}){0,2}(\.\d+)?$`
fn is_simple(text: &str) -> bool {
    let (main, frac) = match text.split_once('.') {
        Some((m, f)) => (m, Some(f)),
        None => (text, None),
    };
    if let Some(f) = frac
        && (f.is_empty() || !f.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let parts: Vec<&str> = main.split(':').collect();
    if parts.len() > 3 || parts[0].is_empty() || !parts[0].chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    parts[1..].iter().all(|p| (1..=2).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn short(t: f64) -> String {
    let secs = t.max(0.0).round() as i64;
    let (s, m, h) = (secs % 60, (secs / 60) % 60, secs / 3600);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(full(5.5, 30.0), "00:00:05:15");
        assert_eq!(simple(5.5), "0:05.50");
        assert_eq!(simple(3725.5), "1:02:05.50");
        assert_eq!(short(65.0), "1:05");
    }

    #[test]
    fn parses() {
        assert_eq!(parse("1000", 30.0, TimeStyle::Timecode), Some(10.0));
        assert_eq!(parse("1:00", 30.0, TimeStyle::Timecode), Some(1.0));
        assert_eq!(parse("0:05.50", 30.0, TimeStyle::Simple), Some(5.5));
        assert_eq!(parse("x", 30.0, TimeStyle::Timecode), None);
    }
}
