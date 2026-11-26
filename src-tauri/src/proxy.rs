//! Local stream server on 127.0.0.1. The player never talks to YouTube's video servers
//! itself: each stream URL is registered here and served as /s/<n>, so the right
//! User-Agent/headers go with it and every browser Range request is fetched upstream in
//! small chunks (YouTube slows down big single requests).

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

const CHUNK: u64 = 4 * 1024 * 1024;
/// stream URLs kept registered (the last few videos' worth)
const KEEP: u64 = 200;

#[derive(Clone)]
pub struct Entry {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub size: Option<u64>,
    pub mime: String,
}

struct Inner {
    entries: Mutex<HashMap<u64, Entry>>,
    next: AtomicU64,
    http: reqwest::Client,
}

#[derive(Clone)]
pub struct Proxy {
    pub port: u16,
    inner: Arc<Inner>,
}

impl Proxy {
    pub async fn start(http: reqwest::Client) -> Proxy {
        let inner = Arc::new(Inner { entries: Mutex::new(HashMap::new()), next: AtomicU64::new(1), http });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind stream server");
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/s/{id}", get(serve)).with_state(inner.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Proxy { port, inner }
    }

    /// Registers a stream and returns the local URL the player loads.
    pub fn add(&self, e: Entry) -> String {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let mut map = self.inner.entries.lock().unwrap();
        map.insert(id, e);
        map.retain(|k, _| *k + KEEP > id);
        format!("http://127.0.0.1:{}/s/{}", self.port, id)
    }
}

fn parse_range(h: &HeaderMap) -> Option<(u64, Option<u64>)> {
    let v = h.get(header::RANGE)?.to_str().ok()?;
    let v = v.strip_prefix("bytes=")?;
    let (a, b) = v.split_once('-')?;
    let start = a.trim().parse().ok()?;
    let end = b.trim().parse().ok();
    Some((start, end))
}

fn with_headers(rb: reqwest::RequestBuilder, e: &Entry) -> reqwest::RequestBuilder {
    e.headers.iter().fold(rb, |rb, (k, v)| rb.header(k, v))
}

/// Total size from a 1-byte request ("Content-Range: bytes 0-0/12345").
async fn probe_size(http: &reqwest::Client, e: &Entry) -> Option<u64> {
    let r = with_headers(http.get(&e.url), e).header(header::RANGE, "bytes=0-0").send().await.ok()?;
    let cr = r.headers().get(header::CONTENT_RANGE)?.to_str().ok()?;
    cr.rsplit('/').next()?.parse().ok()
}

async fn serve(State(st): State<Arc<Inner>>, Path(id): Path<u64>, headers: HeaderMap) -> Response {
    let Some(mut e) = st.entries.lock().unwrap().get(&id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if e.size.is_none() {
        e.size = probe_size(&st.http, &e).await;
        if let Some(s) = e.size {
            if let Some(x) = st.entries.lock().unwrap().get_mut(&id) {
                x.size = Some(s);
            }
        }
    }
    let Some(size) = e.size.filter(|s| *s > 0) else {
        return (StatusCode::BAD_GATEWAY, "stream unavailable").into_response();
    };
    let range = parse_range(&headers);
    let start = range.map(|r| r.0).unwrap_or(0);
    if start >= size {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Body::empty())
            .unwrap();
    }
    let end = range.and_then(|r| r.1).unwrap_or(size - 1).min(size - 1);

    // Pump the range upstream chunk by chunk. YouTube's servers sometimes end a chunk early
    // or drop the connection, so the position advances by the bytes actually received and
    // a broken chunk is fetched again from exactly there; the player must get every byte
    // the Content-Length promised.
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(8);
    let http = st.http.clone();
    let mime = e.mime.clone();
    tokio::spawn(async move {
        let mut pos = start;
        let mut fails = 0;
        while pos <= end {
            let ce = (pos + CHUNK - 1).min(end);
            let res = with_headers(http.get(&e.url), &e).header(header::RANGE, format!("bytes={pos}-{ce}")).send().await;
            let mut problem = match res {
                Ok(r) if r.status().is_success() => {
                    let mut s = r.bytes_stream();
                    let mut err = None;
                    while let Some(item) = s.next().await {
                        match item {
                            Ok(b) => {
                                // never send past the chunk asked for
                                let take = (b.len() as u64).min(ce + 1 - pos) as usize;
                                if take == 0 {
                                    break;
                                }
                                pos += take as u64;
                                if tx.send(Ok(b.slice(..take))).await.is_err() {
                                    return; // the player closed this request
                                }
                                fails = 0;
                            }
                            Err(x) => {
                                err = Some(x.to_string());
                                break;
                            }
                        }
                    }
                    if pos <= ce { Some(err.unwrap_or_else(|| "chunk ended early".into())) } else { None }
                }
                Ok(r) => Some(format!("upstream {}", r.status())),
                Err(x) => Some(x.to_string()),
            };
            if let Some(p) = problem.take() {
                eprintln!("proxy: {p} at {pos} (try {})", fails + 1);
                fails += 1;
                if fails > 5 {
                    let _ = tx.send(Err(std::io::Error::other(p))).await;
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(300 * fails)).await;
            }
        }
    });
    let body = futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });

    let status = if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, end - start + 1)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if range.is_some() {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    b.body(Body::from_stream(body)).unwrap()
}
