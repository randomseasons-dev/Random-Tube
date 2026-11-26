mod profile;
mod proxy;
mod yt;

use std::sync::Arc;
use tauri::{Manager, State};

use profile::{HistItem, Profile, Store};
use yt::{Card, Page, VideoInfo, Yt};

type St<'a> = State<'a, Arc<Yt>>;

/// Runs a YouTube call on its own task: RustyPipe can panic (e.g. no connection) and a
/// panic must come back as an error, not leave the page waiting forever.
async fn guard<T, F>(st: &St<'_>, f: impl FnOnce(Arc<Yt>) -> F) -> Result<T, String>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T, String>> + Send + 'static,
{
    tauri::async_runtime::spawn(f(st.inner().clone()))
        .await
        .map_err(|_| "Could not reach YouTube. Check the internet connection.".to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    profile: Profile,
    history: Vec<HistItem>,
}

#[tauri::command]
fn boot(st: St) -> Boot {
    Boot { profile: st.store.profile(), history: st.store.history() }
}

#[tauri::command]
fn save_prefs(st: St, prefs: serde_json::Value) {
    st.store.set_prefs(prefs);
}

#[tauri::command]
async fn suggest(st: St<'_>, text: String) -> Result<Vec<String>, String> {
    guard(&st, |yt| async move { Ok(yt.suggest(&text).await) }).await
}

#[tauri::command]
async fn search(st: St<'_>, text: String) -> Result<Page, String> {
    guard(&st, |yt| async move { yt.search(&text).await }).await
}

#[tauri::command]
async fn search_more(st: St<'_>) -> Result<Page, String> {
    guard(&st, |yt| async move { yt.search_more().await }).await
}

#[tauri::command]
async fn home(st: St<'_>) -> Result<Vec<Card>, String> {
    guard(&st, |yt| async move { yt.home().await }).await
}

#[tauri::command]
async fn video(st: St<'_>, id: String, ytdlp: bool) -> Result<VideoInfo, String> {
    guard(&st, |yt| async move { yt.video(&id, ytdlp).await }).await
}

#[tauri::command]
async fn is_music(st: St<'_>, id: String) -> Result<bool, String> {
    guard(&st, |yt| async move { Ok(yt.is_music(&id).await) }).await
}

#[tauri::command]
async fn subtitle(st: St<'_>, url: String) -> Result<String, String> {
    guard(&st, |yt| async move { yt.subtitle(&url).await }).await
}

#[tauri::command]
fn record_watch(st: St, card: Card, is_music: bool) {
    st.store.record(card, is_music);
}

#[tauri::command]
fn history(st: St) -> Vec<HistItem> {
    st.store.history()
}

#[tauri::command]
fn remove_history(st: St, id: String) {
    st.store.remove(&id);
}

#[tauri::command]
fn clear_history(st: St) {
    st.store.clear();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = Arc::new(Store::open(dir.clone()));
            let builder = rustypipe::client::RustyPipe::builder().storage_dir(dir.join("rustypipe"));
            #[cfg(mobile)]
            let builder = builder.no_botguard();
            let rp = builder.build().map_err(|e| e.to_string())?;
            let http = reqwest::Client::builder().build()?;
            let proxy = tauri::async_runtime::block_on(proxy::Proxy::start(http.clone()));
            app.manage(Arc::new(Yt::new(rp, http, proxy, store)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            boot,
            save_prefs,
            suggest,
            search,
            search_more,
            home,
            video,
            is_music,
            subtitle,
            record_watch,
            history,
            remove_history,
            clear_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
