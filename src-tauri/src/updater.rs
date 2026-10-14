//! Self-update via tauri-plugin-updater.
//!
//! The app fetches `latest.json` from the endpoint in tauri.conf.json, compares versions,
//! and installs the matching archive only if its signature verifies against the public
//! key embedded in the app (the private key never leaves the release machine/CI).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Update found by the last check, kept until the user installs it.
#[derive(Default)]
pub struct Pending(pub Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn check_update(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
        date: u.date.map(|d| d.date().to_string()),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

/// Download, verify and install the pending update, then relaunch.
#[tauri::command]
pub async fn install_update(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("no update to install — check again")?;
    install(&app, update).await?;
    app.restart();
}

async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    let emitter = app.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// Debug bundles only: `GITTYGIT_TEST_AUTO_UPDATE=1` checks and installs on launch without
/// UI interaction, so the full update path can be exercised end to end in tests.
#[cfg(debug_assertions)]
pub fn test_auto_update(app: &AppHandle) {
    if std::env::var_os("GITTYGIT_TEST_AUTO_UPDATE").is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
            match update {
                Some(u) => {
                    eprintln!("[update-test] installing {} -> {}", u.current_version, u.version);
                    install(&app, u).await.map(|_| true)
                }
                None => Ok(false),
            }
        }
        .await;
        eprintln!("[update-test] result: {result:?}");
        if let Ok(true) = result {
            app.restart();
        }
    });
}
