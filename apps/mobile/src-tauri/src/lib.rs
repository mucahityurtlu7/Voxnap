//! Voxnap mobile entry-point. The actual Tauri app is defined in
//! `voxnap-desktop`; here we just expose it under the macro names that
//! Tauri Mobile expects (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    voxnap_desktop_lib::run();
}
