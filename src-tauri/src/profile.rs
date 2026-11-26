//! The anonymous user: a random profile id made on first start, the watch history the
//! recommendations are built from, the player choices (resolution, captions, music mode...)
//! and the "is this music?" answers already looked up. One JSON file in the app data folder.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::yt::Card;

const MAX_HISTORY: usize = 2000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistItem {
    #[serde(flatten)]
    pub card: Card,
    pub is_music: bool,
    /// unix seconds of the last time it was played
    pub last: u64,
    pub count: u32,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Data {
    id: String,
    created: u64,
    history: Vec<HistItem>,
    prefs: serde_json::Value,
    music: HashMap<String, bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub created: u64,
    pub prefs: serde_json::Value,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("profile.json");
        let mut data: Data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let fresh = data.id.is_empty();
        if fresh {
            data.id = format!("{:016x}", rand::random::<u64>());
            data.created = now();
        }
        if !data.prefs.is_object() {
            data.prefs = serde_json::json!({});
        }
        let store = Store { path, data: Mutex::new(data) };
        if fresh {
            store.save(&store.data.lock().unwrap());
        }
        store
    }

    fn save(&self, d: &Data) {
        let Ok(txt) = serde_json::to_string(d) else { return };
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, txt).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    pub fn profile(&self) -> Profile {
        let d = self.data.lock().unwrap();
        Profile { id: d.id.clone(), created: d.created, prefs: d.prefs.clone() }
    }

    pub fn set_prefs(&self, prefs: serde_json::Value) {
        let mut d = self.data.lock().unwrap();
        d.prefs = prefs;
        self.save(&d);
    }

    pub fn history(&self) -> Vec<HistItem> {
        self.data.lock().unwrap().history.clone()
    }

    pub fn record(&self, card: Card, is_music: bool) {
        let mut d = self.data.lock().unwrap();
        let count = match d.history.iter().position(|h| h.card.id == card.id) {
            Some(i) => d.history.remove(i).count + 1,
            None => 1,
        };
        d.history.insert(0, HistItem { card, is_music, last: now(), count });
        d.history.truncate(MAX_HISTORY);
        self.save(&d);
    }

    pub fn remove(&self, id: &str) {
        let mut d = self.data.lock().unwrap();
        d.history.retain(|h| h.card.id != id);
        self.save(&d);
    }

    pub fn clear(&self) {
        let mut d = self.data.lock().unwrap();
        d.history.clear();
        self.save(&d);
    }

    pub fn music(&self, id: &str) -> Option<bool> {
        self.data.lock().unwrap().music.get(id).copied()
    }

    pub fn set_music(&self, id: &str, yes: bool) {
        let mut d = self.data.lock().unwrap();
        d.music.insert(id.to_string(), yes);
        self.save(&d);
    }
}
