use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_LOG_BYTES: u64 = 1024 * 1024;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
    Startup,
    Hourly,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkerSample {
    Ok {
        trigger: Trigger,
        #[serde(rename = "registrationCount")]
        registration_count: u32,
        controlled: bool,
    },
    Unavailable {
        trigger: Trigger,
    },
    Error {
        trigger: Trigger,
    },
    Timeout {
        trigger: Trigger,
    },
}

pub struct Diagnostics {
    enabled: AtomicBool,
    log_path: PathBuf,
    writer: Mutex<()>,
}

impl Diagnostics {
    pub fn new(app: &tauri::AppHandle, enabled: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = app.path().app_data_dir()?;
        Ok(Self {
            enabled: AtomicBool::new(enabled),
            log_path: directory.join("notifications.jsonl"),
            writer: Mutex::new(()),
        })
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn record(&self, sample: WorkerSample) -> Result<(), String> {
        if !self.enabled.load(Ordering::Relaxed) {
            return Ok(());
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Record {
            timestamp: u128,
            source: &'static str,
            #[serde(flatten)]
            sample: WorkerSample,
        }
        let record = Record {
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis(),
            source: "serviceWorkerInventory",
            sample,
        };
        let mut line = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let _writer = self.writer.lock().map_err(|e| e.to_string())?;
        if self
            .log_path
            .metadata()
            .is_ok_and(|meta| meta.len() + line.len() as u64 > MAX_LOG_BYTES)
        {
            fs::copy(&self.log_path, self.log_path.with_extension("jsonl.1"))
                .map_err(|e| e.to_string())?;
            fs::write(&self.log_path, []).map_err(|e| e.to_string())?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)
            .and_then(|mut file| file.write_all(&line))
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_accepts_only_fixed_diagnostic_fields() {
        for value in [
            serde_json::json!({"trigger":"startup", "status":"ok", "registrationCount":0, "controlled":false}),
            serde_json::json!({"trigger":"hourly", "status":"error"}),
            serde_json::json!({"trigger":"hourly", "status":"timeout"}),
            serde_json::json!({"trigger":"startup", "status":"unavailable"}),
        ] {
            assert!(serde_json::from_value::<WorkerSample>(value).is_ok());
        }
        for value in [
            serde_json::json!({"trigger":"startup", "status":"ok", "registrationCount":-1, "controlled":false}),
            serde_json::json!({"trigger":"hourly", "status":"error", "body":"arbitrary text"}),
        ] {
            assert!(serde_json::from_value::<WorkerSample>(value).is_err());
        }
    }

    #[test]
    fn logging_requires_debug_and_rotates_bounded_records() {
        let path = std::env::temp_dir().join(format!(
            "caprine-diagnostics-{}-{}.jsonl",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let diagnostics = Diagnostics {
            enabled: AtomicBool::new(false),
            log_path: path.clone(),
            writer: Mutex::new(()),
        };
        let sample = || WorkerSample::Ok {
            trigger: Trigger::Startup,
            registration_count: 0,
            controlled: false,
        };
        diagnostics.record(sample()).unwrap();
        assert!(!path.exists());
        diagnostics.set_enabled(true);
        fs::write(&path, vec![b' '; MAX_LOG_BYTES as usize]).unwrap();
        diagnostics.record(sample()).unwrap();
        let log = fs::read_to_string(&path).unwrap();
        let record: serde_json::Value = serde_json::from_str(&log).unwrap();
        assert_eq!(record["source"], "serviceWorkerInventory");
        assert_eq!(record["registrationCount"], 0);
        assert_eq!(record["controlled"], false);
        assert_eq!(
            path.with_extension("jsonl.1").metadata().unwrap().len(),
            MAX_LOG_BYTES
        );
        fs::remove_file(path.with_extension("jsonl.1")).unwrap();
        fs::remove_file(path).unwrap();
    }
}
