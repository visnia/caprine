//! Engine downloads (attachments, blob URLs) save to the user's Downloads
//! folder without overwriting, and report completion as an app notice.
use std::path::{Path, PathBuf};

use crate::notifications::{self, Action, Event};

// Linux chooses destinations itself; WebView2 supplies a unique default.
/// Strip directory components and control characters from an engine-suggested
/// filename; never trust it as a path.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn safe_name(suggested: &str) -> String {
    let name: String = suggested
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_matches('.').to_string();
    if name.is_empty() {
        "download".into()
    } else {
        name.chars().take(200).collect()
    }
}

/// First non-existing `name`, `name (1)`, … in `directory`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn unique_path(directory: &Path, suggested: &str) -> PathBuf {
    let name = safe_name(suggested);
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_string(), format!(".{extension}")),
        _ => (name.clone(), String::new()),
    };
    let mut path = directory.join(&name);
    let mut counter = 1;
    while path.exists() {
        path = directory.join(format!("{stem} ({counter}){extension}"));
        counter += 1;
    }
    path
}

pub fn finished(app: &tauri::AppHandle, path: Option<PathBuf>, success: bool) {
    let name = path
        .as_deref()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Attachment".into());
    let (title, action) = match (success, path) {
        (true, Some(path)) => ("Download complete", Action::RevealFile(path)),
        _ => ("Download failed", Action::RestoreWindow),
    };
    notifications::log(
        app,
        serde_json::json!({"source":"download","decision":if success {"finished"} else {"failed"}}),
    );
    notifications::send(
        app,
        Event::System {
            title: title.into(),
            body: name,
            action,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn suggested_names_cannot_escape_or_overwrite() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name(r"C:\Windows\x.dll"), "x.dll");
        assert_eq!(safe_name("a<b>?.png"), "a_b__.png");
        assert_eq!(safe_name(".."), "download");
        assert_eq!(safe_name(""), "download");
        let directory = std::env::temp_dir().join(format!("caprine-dl-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("photo.jpg"), b"x").unwrap();
        std::fs::write(directory.join("photo (1).jpg"), b"x").unwrap();
        assert_eq!(
            unique_path(&directory, "photo.jpg"),
            directory.join("photo (2).jpg")
        );
        assert_eq!(unique_path(&directory, "notes"), directory.join("notes"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
