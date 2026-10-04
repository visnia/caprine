fn main() {
    println!("cargo:rerun-if-changed=../dist/inject.js");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["bootstrap", "open_external"]),
        ),
    )
    .expect("failed to build Caprine's Tauri context");
}
