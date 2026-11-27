//! File paths in projects. Editroom stores absolute paths plus a path relative to the
//! project's folder (always with `/`), so a project folder moved whole — or opened on the
//! other OS — finds its media again.

use crate::model::{MediaFolder, Project};
use std::path::{Component, Path, PathBuf};

/// Lexically normalised components (no filesystem access): `.` dropped, `..` applied.
fn components(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in p.components() {
        match c {
            Component::Prefix(x) => out.push(x.as_os_str().to_string_lossy().into_owned()),
            Component::RootDir => out.push(String::from("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                if out.last().is_some_and(|l| l != "/" && l != "..") {
                    out.pop();
                } else {
                    out.push("..".into());
                }
            }
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
        }
    }
    out
}

/// `file` as seen from `base`, joined with `/`.
pub fn relative(base: &Path, file: &Path) -> String {
    let b = components(base);
    let f = components(file);
    let shared = b.iter().zip(f.iter()).take_while(|(x, y)| x == y).count();
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), b.len() - shared).collect();
    parts.extend(f[shared..].iter().cloned());
    parts.join("/")
}

/// `rel` (with `/` separators) resolved against `base`, normalised.
pub fn resolve(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                p.pop();
            }
            x => p.push(x),
        }
    }
    p
}

/// Whether `path` is `folder` or inside it.
pub fn folder_contains(folder: &str, path: &str) -> bool {
    path == folder || path.starts_with(&format!("{}/", folder.trim_end_matches('/'))) || {
        let f = folder.trim_end_matches('\\');
        path.starts_with(&format!("{f}\\"))
    }
}

impl MediaFolder {
    pub fn name(&self) -> String {
        Path::new(&self.path).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

impl Project {
    /// Rewrites every path under `old` to sit under `new` instead.
    pub fn move_paths(&mut self, old: &str, new: &str) {
        if old == new {
            return;
        }
        let moved = |p: &str| folder_contains(old, p).then(|| format!("{new}{}", &p[old.len()..]));
        for a in self.assets.iter_mut() {
            if let Some(p) = moved(&a.path) {
                a.path = p;
            }
            if let Some(p) = a.playable_path.as_deref().and_then(moved) {
                a.playable_path = Some(p);
            }
        }
        for f in self.folders.iter_mut().flatten() {
            if let Some(p) = moved(&f.path) {
                f.path = p;
            }
        }
        if let Some(h) = self.hidden_media.as_mut() {
            for p in h.iter_mut() {
                if let Some(n) = moved(p) {
                    *p = n;
                }
            }
        }
    }

    /// Points assets whose file has gone at the same file relative to the project's folder.
    /// Returns how many were found that way.
    pub fn resolve_moved_media(&mut self, project_dir: &Path) -> usize {
        let folders = self.folders.clone().unwrap_or_default();
        for f in folders.iter().filter(|f| !Path::new(&f.path).exists()) {
            let Some(rel) = &f.relative_path else { continue };
            let candidate = resolve(project_dir, rel);
            if candidate.is_dir() {
                self.move_paths(&f.path, &candidate.to_string_lossy());
            }
        }
        let mut found = 0;
        for a in self.assets.iter_mut().filter(|a| !Path::new(&a.path).exists()) {
            let Some(rel) = &a.relative_path else { continue };
            let candidate = resolve(project_dir, rel);
            if candidate.exists() {
                a.path = candidate.to_string_lossy().into_owned();
                found += 1;
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_match_editroom() {
        assert_eq!(relative(Path::new("/Users/a/Projects/Trip"), Path::new("/Users/a/Movies/x.mov")), "../../Movies/x.mov");
        assert_eq!(relative(Path::new("/Users/a/Trip"), Path::new("/Users/a/Trip/Media/x.mov")), "Media/x.mov");
    }

    #[test]
    fn resolves_against_project_folder() {
        assert_eq!(resolve(Path::new("/p/Trip"), "../Media/x.mov"), PathBuf::from("/p/Media/x.mov"));
    }
}
