use std::fs;
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent};

/// 保存启动时待打开的文件路径（Finder 双击 → app 冷启动时，前端可能还没准备好接收事件）
struct PendingFile(Mutex<Option<String>>);

// 读取文件内容
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

// 写入文件内容
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

// 前端启动后调用，取出并清空待打开的文件路径
#[tauri::command]
fn take_pending_file(state: tauri::State<PendingFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

// 最近打开列表存放路径：<app 配置目录>/recent.json
fn recent_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

// 读取最近打开列表（纯路径数组），读不到就返回空
#[tauri::command]
fn load_recent(app: tauri::AppHandle) -> Vec<String> {
    recent_path(&app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

// 保存最近打开列表
#[tauri::command]
fn save_recent(app: tauri::AppHandle, list: Vec<String>) -> Result<(), String> {
    let path = recent_path(&app).ok_or("无法定位配置目录")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string(&list).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            take_pending_file,
            load_recent,
            save_recent
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS：从 Finder 双击 .md 文件时，系统通过 Opened 事件把文件路径传进来
            if let RunEvent::Opened { urls } = event {
                if let Some(path) = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .next()
                {
                    // 存为待打开路径（应对冷启动），同时立即发事件（应对运行中打开）
                    if let Some(state) = app.try_state::<PendingFile>() {
                        *state.0.lock().unwrap() = Some(path.clone());
                    }
                    let _ = app.emit("open-file", path);
                }
            }
        });
}
