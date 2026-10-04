fn main() {
    println!("cargo:rerun-if-changed=../dist/inject.js");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bootstrap",
            "open_external",
            "log_service_worker_inventory",
            "get_settings",
            "update_setting",
            "panel_action",
            "report_unread",
            "collect_notification",
        ]),
    ))
    .expect("failed to build Caprine's Tauri context");
}
