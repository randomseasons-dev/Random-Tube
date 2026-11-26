// Dev check: serve a video's best audio through the app's proxy and read ranges like a
// browser does. `proxytest <id>` (outside the sandbox)
#[path = "../src/proxy.rs"]
mod proxy;
use futures::StreamExt;
use rustypipe::client::RustyPipe;

#[tokio::main]
async fn main() {
    let id = std::env::args().nth(1).unwrap_or("dQw4w9WgXcQ".into());
    let rp = RustyPipe::builder().no_storage().build().unwrap();
    let q = rp.query();
    let p = q.player(&id).await.unwrap();
    let ua = q.user_agent(p.client_type).to_string();
    let http = reqwest::Client::builder().build().unwrap();
    let px = proxy::Proxy::start(http.clone()).await;
    let a = p.audio_streams.iter().max_by_key(|a| a.bitrate).unwrap();
    let u = px.add(proxy::Entry { url: a.url.clone(), headers: vec![("User-Agent".into(), ua.clone())], size: Some(a.size), mime: a.mime.clone() });
    println!("{} size {}", a.mime, a.size);
    for (range, want) in [(format!("bytes=0-"), 12_000_000usize), (format!("bytes={}-", a.size - 300_000), 300_000), (format!("bytes={}-", a.size / 2), 9_000_000)] {
        let t = std::time::Instant::now();
        let r = http.get(&u).header("Range", &range).send().await.unwrap();
        let st = r.status();
        let mut s = r.bytes_stream();
        let mut n = 0usize;
        let mut err = None;
        while let Some(c) = s.next().await {
            match c { Ok(b) => { n += b.len(); if n >= want { break } } Err(e) => { err = Some(format!("{e:?}")); break } }
        }
        println!("{range}: {st} read {n} in {:?} err {err:?}", t.elapsed());
    }
}
