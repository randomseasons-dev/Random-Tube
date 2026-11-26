//! Everything that talks to YouTube: search, video streams (visionOS player client, then
//! RustyPipe; yt-dlp as the Windows fallback), related videos, the Music category check and the home feed.
//! The player gets raw audio/video streams through the local proxy, so no ads ever load.

use rustypipe::client::{ClientType, RustyPipe, RustyPipeQuery};
use rustypipe::model::paginator::Paginator;
use rustypipe::model::{Thumbnail, Verification, VideoItem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::profile::Store;
use crate::proxy::{Entry, Proxy};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub channel_id: String,
    /// seconds, 0 = unknown
    #[serde(default)]
    pub duration: u32,
    #[serde(default)]
    pub thumb: String,
    #[serde(default)]
    pub views: Option<u64>,
    #[serde(default)]
    pub published: Option<String>,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub short: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VStream {
    pub url: String,
    pub height: u32,
    pub fps: u32,
    pub mime: String,
    pub bitrate: u32,
    /// has its own sound (no separate audio stream needed)
    pub muxed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AStream {
    pub url: String,
    pub mime: String,
    pub bitrate: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sub {
    pub lang: String,
    pub name: String,
    pub auto: bool,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub card: Card,
    pub is_music: bool,
    pub video: Vec<VStream>,
    pub audio: Vec<AStream>,
    pub subs: Vec<Sub>,
    pub related: Vec<Card>,
    pub source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub title: String,
    pub items: Vec<Card>,
    pub more: bool,
}

#[derive(Clone)]
struct Details {
    related: Vec<Card>,
    artist: bool,
    channel: String,
}

pub struct Yt {
    pub rp: RustyPipe,
    pub http: reqwest::Client,
    pub proxy: Proxy,
    pub store: Arc<Store>,
    details: Mutex<HashMap<String, Details>>,
    search_page: tokio::sync::Mutex<Option<Paginator<VideoItem>>>,
    /// anonymous YouTube visitor id for the visionOS player requests (refreshed every few hours)
    visitor: tokio::sync::Mutex<Option<(String, std::time::Instant)>>,
}

fn best_thumb(list: &[Thumbnail], id: &str) -> String {
    list.iter()
        .filter(|t| t.width <= 720)
        .max_by_key(|t| t.width)
        .or_else(|| list.iter().max_by_key(|t| t.width))
        .map(|t| t.url.clone())
        .unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"))
}

fn card(v: &VideoItem) -> Card {
    Card {
        id: v.id.clone(),
        title: v.name.clone(),
        channel: v.channel.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
        channel_id: v.channel.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
        duration: v.duration.unwrap_or(0),
        thumb: best_thumb(&v.thumbnail, &v.id),
        views: v.view_count,
        published: v.publish_date_txt.clone(),
        live: v.is_live,
        short: v.is_short,
    }
}

/// Video id and/or playlist id from a pasted link (or a bare 11-char id).
fn parse_link(s: &str) -> (Option<String>, Option<String>) {
    let s = s.trim();
    let vid = regex::Regex::new(r"(?:v=|youtu\.be/|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})").unwrap();
    let list = regex::Regex::new(r"[?&]list=([A-Za-z0-9_-]{10,})").unwrap();
    let mut v = vid.captures(s).map(|c| c[1].to_string());
    if v.is_none() && regex::Regex::new(r"^[A-Za-z0-9_-]{11}$").unwrap().is_match(s) && s.chars().any(|c| c.is_ascii_digit() || c == '_' || c == '-') {
        v = Some(s.to_string());
    }
    (v, list.captures(s).map(|c| c[1].to_string()))
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Yt {
    pub fn new(rp: RustyPipe, http: reqwest::Client, proxy: Proxy, store: Arc<Store>) -> Yt {
        Yt { rp, http, proxy, store, details: Mutex::new(HashMap::new()), search_page: tokio::sync::Mutex::new(None), visitor: tokio::sync::Mutex::new(None) }
    }

    fn q(&self) -> RustyPipeQuery {
        self.rp.query()
    }

    pub async fn suggest(&self, text: &str) -> Vec<String> {
        self.q().search_suggestion(text).await.unwrap_or_default()
    }

    /// Search text, or open a pasted video / playlist link.
    pub async fn search(&self, text: &str) -> Result<Page, String> {
        let (vid, list) = parse_link(text);
        if let Some(list) = list {
            let q = self.q();
            let mut pl = q.playlist(&list).await.map_err(err)?;
            let _ = pl.videos.extend_limit(&q, 300).await;
            let mut items: Vec<Card> = pl.videos.items.iter().map(card).collect();
            // a "watch?v=X&list=Y" link starts at X
            if let Some(v) = vid {
                if let Some(i) = items.iter().position(|c| c.id == v) {
                    items.rotate_left(i);
                }
            }
            return Ok(Page { title: pl.name, items, more: false });
        }
        if let Some(v) = vid {
            let p = self.q().player(&v).await.map_err(err)?;
            let d = &p.details;
            let c = Card {
                id: d.id.clone(),
                title: d.name.clone().unwrap_or_default(),
                channel: d.channel_name.clone().unwrap_or_default(),
                channel_id: d.channel_id.clone(),
                duration: d.duration,
                thumb: format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", d.id),
                views: d.view_count,
                live: d.is_live,
                ..Default::default()
            };
            return Ok(Page { title: "Link".into(), items: vec![c], more: false });
        }
        let res = self.q().search::<VideoItem, _>(text).await.map_err(err)?;
        let items = res.items.items.iter().map(card).collect();
        let more = res.items.ctoken.is_some();
        *self.search_page.lock().await = Some(res.items);
        Ok(Page { title: format!("Results for \"{}\"", res.corrected_query.unwrap_or_else(|| text.to_string())), items, more })
    }

    pub async fn search_more(&self) -> Result<Page, String> {
        let mut guard = self.search_page.lock().await;
        let Some(cur) = guard.as_ref() else {
            return Ok(Page { title: String::new(), items: vec![], more: false });
        };
        let q = self.q();
        let next = cur.next(&q).await.map_err(err)?;
        let page = match next {
            Some(p) => {
                let pg = Page { title: String::new(), items: p.items.iter().map(card).collect(), more: p.ctoken.is_some() };
                *guard = Some(p);
                pg
            }
            None => {
                *guard = None;
                Page { title: String::new(), items: vec![], more: false }
            }
        };
        Ok(page)
    }

    async fn details(&self, id: &str) -> Result<Details, String> {
        if let Some(d) = self.details.lock().unwrap().get(id) {
            return Ok(d.clone());
        }
        let v = self.q().video_details(id).await.map_err(err)?;
        let d = Details {
            related: v.recommended.items.iter().map(card).collect(),
            artist: v.channel.verification == Verification::Artist,
            channel: v.channel.name.clone(),
        };
        let mut map = self.details.lock().unwrap();
        if map.len() > 300 {
            map.clear();
        }
        map.insert(id.to_string(), d.clone());
        Ok(d)
    }

    /// Some watch pages don't parse ("could not find secondary_info"): then the videos a
    /// search for the title finds stand in for YouTube's related list.
    async fn search_related(&self, id: &str, title: &str) -> Vec<Card> {
        if title.trim().is_empty() {
            return vec![];
        }
        match self.q().search::<VideoItem, _>(title).await {
            Ok(r) => r.items.items.iter().map(card).filter(|c| c.id != id).collect(),
            Err(_) => vec![],
        }
    }

    async fn related(&self, id: &str, title: &str) -> Vec<Card> {
        match self.details(id).await {
            Ok(d) if !d.related.is_empty() => d.related,
            _ => self.search_related(id, title).await,
        }
    }

    /// YouTube's own category field from the web player response ("Music", "Gaming", ...).
    async fn category(&self, id: &str) -> Option<String> {
        let body = serde_json::json!({ "videoId": id, "contentCheckOk": true, "racyCheckOk": true });
        if let Ok(txt) = self.q().raw(ClientType::Desktop, "player", &body).await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(c) = v.pointer("/microformat/playerMicroformatRenderer/category").and_then(|c| c.as_str()) {
                    return Some(c.to_string());
                }
            }
        }
        // the watch page carries the same field
        let html = self
            .http
            .get(format!("https://www.youtube.com/watch?v={id}&hl=en"))
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36")
            .header("Cookie", "CONSENT=YES+1; SOCS=CAI")
            .send()
            .await
            .ok()?
            .text()
            .await
            .ok()?;
        let re = regex::Regex::new(r#""category":"([^"]+)""#).unwrap();
        re.captures(&html).map(|c| c[1].to_string())
    }

    /// True when the video is tagged Music (category, or an official artist / "- Topic" channel).
    pub async fn is_music(&self, id: &str) -> bool {
        if let Some(m) = self.store.music(id) {
            return m;
        }
        let yes = match self.category(id).await {
            Some(c) => c == "Music",
            None => match self.details(id).await {
                Ok(d) => d.artist || d.channel.ends_with(" - Topic") || d.channel.to_lowercase().contains("vevo"),
                Err(_) => return false, // unknown: don't remember
            },
        };
        self.store.set_music(id, yes);
        yes
    }

    pub async fn video(&self, id: &str, use_ytdlp: bool) -> Result<VideoInfo, String> {
        let (streams, related, music) = tokio::join!(
            async {
                // asked for yt-dlp (Windows retry): if it isn't working, RustyPipe again
                if use_ytdlp {
                    if let Ok(s) = ytdlp::load(self, id).await {
                        return Ok(s);
                    }
                }
                // visionOS client first: its stream URLs need no PO token, so YouTube serves
                // the whole file (the iOS client's URLs now stop with a 403 after ~1 MB)
                let vos_err = match vos::load(self, id).await {
                    Ok(s) if !s.1.is_empty() || !s.2.is_empty() => return Ok(s),
                    Ok(_) => "no playable streams".to_string(),
                    Err(e) => e,
                };
                eprintln!("visionos: {vos_err}");
                match self.rp_streams(id).await {
                    Ok(s) if !s.1.is_empty() || !s.2.is_empty() => Ok(s),
                    Ok(_) if use_ytdlp => Err("no playable streams".into()),
                    Err(e) if use_ytdlp => Err(e),
                    first => match ytdlp::load(self, id).await {
                        Ok(s) => Ok(s),
                        Err(e2) => Err(match first {
                            Err(e) => format!("{e} ({e2})"),
                            Ok(_) => format!("no playable streams ({e2})"),
                        }),
                    },
                }
            },
            self.details(id),
            self.is_music(id)
        );
        let (card, video, audio, subs, source) = streams?;
        let related = match related {
            Ok(d) if !d.related.is_empty() => d.related,
            _ => self.search_related(id, &card.title).await,
        };
        Ok(VideoInfo { card, is_music: music, video, audio, subs, related, source })
    }

    #[allow(clippy::type_complexity)]
    async fn rp_streams(&self, id: &str) -> Result<(Card, Vec<VStream>, Vec<AStream>, Vec<Sub>, String), String> {
        let q = self.q();
        let p = q.player(id).await.map_err(err)?;
        if p.drm.is_some() {
            return Err("this video is DRM protected".into());
        }
        let ua = q.user_agent(p.client_type).to_string();
        let headers = vec![("User-Agent".to_string(), ua.clone())];
        let d = &p.details;
        let card = Card {
            id: d.id.clone(),
            title: d.name.clone().unwrap_or_default(),
            channel: d.channel_name.clone().unwrap_or_default(),
            channel_id: d.channel_id.clone(),
            duration: d.duration,
            thumb: format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", d.id),
            views: d.view_count,
            live: d.is_live,
            ..Default::default()
        };
        if d.is_live {
            return Err("live streams are not supported".into());
        }
        let mut video = vec![];
        for (list, muxed) in [(&p.video_streams, true), (&p.video_only_streams, false)] {
            for s in list.iter() {
                let url = self.proxy.add(Entry { url: s.url.clone(), headers: headers.clone(), size: s.size, mime: s.mime.clone() });
                video.push(VStream { url, height: s.height, fps: s.fps as u32, mime: s.mime.clone(), bitrate: s.bitrate, muxed });
            }
        }
        let audio = p
            .audio_streams
            .iter()
            // other-language dubs: keep only the original track
            .filter(|s| s.track.as_ref().map(|t| t.is_default).unwrap_or(true))
            .map(|s| AStream {
                url: self.proxy.add(Entry { url: s.url.clone(), headers: headers.clone(), size: Some(s.size), mime: s.mime.clone() }),
                mime: s.mime.clone(),
                bitrate: s.bitrate,
            })
            .collect();
        let subs = p
            .subtitles
            .iter()
            .map(|s| Sub {
                lang: s.lang.clone(),
                name: s.lang_name.clone(),
                auto: s.auto_generated,
                url: if s.url.contains("fmt=") { s.url.clone() } else { format!("{}&fmt=vtt", s.url) },
            })
            .collect();
        Ok((card, video, audio, subs, "rustypipe".into()))
    }

    pub async fn subtitle(&self, url: &str) -> Result<String, String> {
        let r = self.http.get(url).send().await.map_err(err)?;
        if !r.status().is_success() {
            return Err(format!("captions: HTTP {}", r.status()));
        }
        r.text().await.map_err(err)
    }

    /// "For you": videos that YouTube lists as related to what this profile watched last.
    /// A video recommended by more of those seeds ranks higher; anything already watched
    /// is left out. No history yet = trending.
    pub async fn home(&self) -> Result<Vec<Card>, String> {
        let hist = self.store.history();
        if hist.is_empty() {
            let mut items: Vec<Card> = self.q().trending().await.map(|v| v.iter().map(card).collect()).unwrap_or_default();
            if items.is_empty() {
                items = self.search("trending").await?.items;
            }
            return Ok(items.into_iter().filter(|c| !c.short).collect());
        }
        let seen: HashSet<&str> = hist.iter().map(|h| h.card.id.as_str()).collect();
        let lists = futures::future::join_all(hist.iter().take(8).map(|h| self.related(&h.card.id, &h.card.title))).await;
        // id -> (seeds recommending it, first position seen, card)
        let mut score: HashMap<String, (u32, usize, Card)> = HashMap::new();
        for (si, list) in lists.into_iter().enumerate() {
            for (pi, c) in list.into_iter().enumerate() {
                if seen.contains(c.id.as_str()) || c.short || c.live {
                    continue;
                }
                let rank = si * 100 + pi;
                score.entry(c.id.clone()).and_modify(|e| e.0 += 1).or_insert((1, rank, c));
            }
        }
        let mut list: Vec<(u32, usize, Card)> = score.into_values().collect();
        list.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        Ok(list.into_iter().take(60).map(|e| e.2).collect())
    }
}

/// yt-dlp fallback (Windows only: yt-dlp on PATH or next to the exe). It keeps up with
/// YouTube changes faster than anything else; `yt-dlp -U` updates it.
mod ytdlp {
    use super::*;

    #[cfg(windows)]
    pub async fn load(yt: &Yt, id: &str) -> Result<(Card, Vec<VStream>, Vec<AStream>, Vec<Sub>, String), String> {
        let mut cmd = tokio::process::Command::new(exe());
        cmd.args(["-J", "--no-warnings", "--no-playlist", &format!("https://www.youtube.com/watch?v={id}")]);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let out = cmd.output().await.map_err(|e| format!("yt-dlp not found ({e})"))?;
        if !out.status.success() {
            let e = String::from_utf8_lossy(&out.stderr);
            return Err(match e.lines().rev().find(|l| !l.trim().is_empty()) {
                Some(l) => format!("yt-dlp: {l}"),
                None => format!("yt-dlp is not working on this PC (exit code {:?})", out.status.code()),
            });
        }
        let j: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(err)?;
        if j["is_live"].as_bool().unwrap_or(false) {
            return Err("live streams are not supported".into());
        }
        let s = |v: &serde_json::Value| v.as_str().unwrap_or("").to_string();
        let card = Card {
            id: id.to_string(),
            title: s(&j["title"]),
            channel: s(&j["channel"]),
            channel_id: s(&j["channel_id"]),
            duration: j["duration"].as_f64().unwrap_or(0.0) as u32,
            thumb: format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"),
            views: j["view_count"].as_u64(),
            ..Default::default()
        };
        if j["categories"].as_array().map(|c| c.iter().any(|x| x == "Music")).unwrap_or(false) {
            yt.store.set_music(id, true);
        }
        let mut video = vec![];
        let mut audio = vec![];
        for f in j["formats"].as_array().into_iter().flatten() {
            if s(&f["protocol"]) != "https" {
                continue;
            }
            let headers: Vec<(String, String)> = f["http_headers"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), s(v))).collect())
                .unwrap_or_default();
            let (vc, ac, ext) = (s(&f["vcodec"]), s(&f["acodec"]), s(&f["ext"]));
            let has_v = !vc.is_empty() && vc != "none";
            let has_a = !ac.is_empty() && ac != "none";
            let kind = if has_v { "video" } else { "audio" };
            let container = match ext.as_str() {
                "m4a" | "mp4" => "mp4",
                "webm" => "webm",
                _ => continue,
            };
            let codecs = match (has_v, has_a) {
                (true, true) => format!("{vc}, {ac}"),
                (true, false) => vc.clone(),
                _ => ac.clone(),
            };
            let mime = format!("{kind}/{container}; codecs=\"{codecs}\"");
            let url = yt.proxy.add(Entry { url: s(&f["url"]), headers, size: f["filesize"].as_u64(), mime: mime.clone() });
            let bitrate = (f["tbr"].as_f64().unwrap_or(0.0) * 1000.0) as u32;
            if has_v {
                video.push(VStream {
                    url,
                    height: f["height"].as_u64().unwrap_or(0) as u32,
                    fps: f["fps"].as_f64().unwrap_or(30.0) as u32,
                    mime,
                    bitrate,
                    muxed: has_a,
                });
            } else if has_a {
                // skip dubbed tracks (yt-dlp marks the original with language_preference 10)
                if f["language_preference"].as_i64().map(|p| p < 0).unwrap_or(false) {
                    continue;
                }
                audio.push(AStream { url, mime, bitrate });
            }
        }
        let mut subs = vec![];
        for (key, auto) in [("subtitles", false), ("automatic_captions", true)] {
            for (lang, list) in j[key].as_object().into_iter().flatten() {
                // auto captions come translated into ~150 languages: keep the original + en/vi
                if auto && !(lang.ends_with("-orig") || lang == "en" || lang == "vi") {
                    continue;
                }
                let Some(vtt) = list.as_array().and_then(|l| l.iter().find(|x| x["ext"] == "vtt")) else { continue };
                subs.push(Sub { lang: lang.clone(), name: s(&vtt["name"]), auto, url: s(&vtt["url"]) });
            }
        }
        Ok((card, video, audio, subs, "yt-dlp".into()))
    }

    #[cfg(windows)]
    fn exe() -> std::path::PathBuf {
        if let Some(p) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("yt-dlp.exe"))) {
            if p.exists() {
                return p;
            }
        }
        "yt-dlp".into()
    }

    #[cfg(not(windows))]
    pub async fn load(_yt: &Yt, _id: &str) -> Result<(Card, Vec<VStream>, Vec<AStream>, Vec<Sub>, String), String> {
        Err("no fallback extractor on this device".into())
    }
}

/// YouTube's visionOS (Apple Vision Pro) player client: plain stream URLs (no signature
/// deobfuscation) that don't need a PO token. yt-dlp uses the same client when it has no
/// JavaScript runtime. "Made for kids" videos are not available through it.
mod vos {
    use super::*;

    const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    const VERSION: &str = "1.02";

    async fn text(yt: &Yt, url: &str) -> Result<String, String> {
        yt.http
            .get(url)
            .header("User-Agent", UA)
            .header("Cookie", "CONSENT=YES+1; SOCS=CAI")
            .send()
            .await
            .map_err(err)?
            .text()
            .await
            .map_err(err)
    }

    async fn visitor(yt: &Yt) -> Result<String, String> {
        let mut v = yt.visitor.lock().await;
        if let Some((id, t)) = v.as_ref() {
            if t.elapsed().as_secs() < 6 * 3600 {
                return Ok(id.clone());
            }
        }
        let txt = text(yt, "https://www.youtube.com/sw.js_data").await?;
        let re = regex::Regex::new(r#""(Cg[A-Za-z0-9_%-]{20,})""#).unwrap();
        let id = match re.captures(&txt) {
            Some(c) => c[1].replace("%3D", "=").replace("%3d", "="),
            None => {
                let html = text(yt, "https://www.youtube.com/?hl=en").await?;
                let re = regex::Regex::new(r#""VISITOR_DATA":"([^"]+)""#).unwrap();
                re.captures(&html).map(|c| c[1].to_string()).ok_or("no visitor id")?
            }
        };
        *v = Some((id.clone(), std::time::Instant::now()));
        Ok(id)
    }

    async fn player(yt: &Yt, id: &str) -> Result<serde_json::Value, String> {
        let vd = visitor(yt).await?;
        let body = serde_json::json!({
            "context": { "client": {
                "clientName": "VISIONOS", "clientVersion": VERSION, "deviceMake": "Apple",
                "deviceModel": "RealityDevice17,1", "userAgent": UA, "osName": "visionOS",
                "osVersion": "26.5.23O471", "hl": "en", "gl": "US", "visitorData": vd,
            }},
            "videoId": id, "contentCheckOk": true, "racyCheckOk": true,
        });
        let r = yt
            .http
            .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
            .header("User-Agent", UA)
            .header("X-YouTube-Client-Name", "101")
            .header("X-YouTube-Client-Version", VERSION)
            .header("X-Goog-Visitor-Id", &vd)
            .header("Origin", "https://www.youtube.com")
            .json(&body)
            .send()
            .await
            .map_err(err)?;
        if !r.status().is_success() {
            return Err(format!("player HTTP {}", r.status()));
        }
        r.json().await.map_err(err)
    }

    #[allow(clippy::type_complexity)]
    pub async fn load(yt: &Yt, id: &str) -> Result<(Card, Vec<VStream>, Vec<AStream>, Vec<Sub>, String), String> {
        let mut p = player(yt, id).await?;
        if p["playabilityStatus"]["status"].as_str() == Some("LOGIN_REQUIRED") {
            // a stale visitor id can trigger "confirm you're not a bot": once more with a fresh one
            *yt.visitor.lock().await = None;
            p = player(yt, id).await?;
        }
        let ps = &p["playabilityStatus"];
        if ps["status"].as_str() != Some("OK") {
            return Err(ps["reason"].as_str().or(ps["status"].as_str()).unwrap_or("not playable").to_string());
        }
        let s = |v: &serde_json::Value| v.as_str().unwrap_or("").to_string();
        let n = |v: &serde_json::Value| v.as_str().and_then(|x| x.parse::<u64>().ok()).or_else(|| v.as_u64());
        let d = &p["videoDetails"];
        if d["isLive"].as_bool().unwrap_or(false) {
            return Err("live streams are not supported".into());
        }
        let card = Card {
            id: id.to_string(),
            title: s(&d["title"]),
            channel: s(&d["author"]),
            channel_id: s(&d["channelId"]),
            duration: n(&d["lengthSeconds"]).unwrap_or(0) as u32,
            thumb: format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"),
            views: n(&d["viewCount"]),
            ..Default::default()
        };
        let headers = vec![("User-Agent".to_string(), UA.to_string())];
        let sd = &p["streamingData"];
        let mut video = vec![];
        let mut audio = vec![];
        for (key, muxed) in [("formats", true), ("adaptiveFormats", false)] {
            for f in sd[key].as_array().into_iter().flatten() {
                let Some(url) = f["url"].as_str() else { continue }; // ciphered: not for this client
                if f.get("drmFamilies").is_some() {
                    continue;
                }
                let mime = s(&f["mimeType"]);
                let bitrate = f["bitrate"].as_u64().unwrap_or(0) as u32;
                let entry = Entry { url: url.to_string(), headers: headers.clone(), size: n(&f["contentLength"]), mime: mime.clone() };
                if mime.starts_with("video/") {
                    video.push(VStream {
                        url: yt.proxy.add(entry),
                        height: f["height"].as_u64().unwrap_or(0) as u32,
                        fps: f["fps"].as_u64().unwrap_or(30) as u32,
                        mime,
                        bitrate,
                        muxed,
                    });
                } else if mime.starts_with("audio/") {
                    // other-language dubs: keep only the original track
                    if f["audioTrack"]["audioIsDefault"].as_bool() == Some(false) {
                        continue;
                    }
                    audio.push(AStream { url: yt.proxy.add(entry), mime, bitrate });
                }
            }
        }
        let mut subs = vec![];
        for t in p["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"].as_array().into_iter().flatten() {
            let base = s(&t["baseUrl"]);
            if base.is_empty() {
                continue;
            }
            let name = t["name"]["runs"][0]["text"].as_str().or(t["name"]["simpleText"].as_str()).unwrap_or("").to_string();
            subs.push(Sub {
                lang: s(&t["languageCode"]),
                name,
                auto: t["kind"].as_str() == Some("asr"),
                url: if base.contains("fmt=") { base } else { format!("{base}&fmt=vtt") },
            });
        }
        Ok((card, video, audio, subs, "visionos".into()))
    }
}
