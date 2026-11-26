// Dev check: which RustyPipe client gives streams that play to the end?
// `cargo run --release --example probe` (outside the sandbox)
use rustypipe::client::{ClientType, RustyPipe};

#[tokio::main]
async fn main() {
    let rp = RustyPipe::builder().no_storage().build().unwrap();
    let q = rp.query();
    let http = reqwest::Client::new();
    let id = std::env::args().nth(1).unwrap_or("dQw4w9WgXcQ".into());
    for ct in [ClientType::Ios, ClientType::Tv, ClientType::Android, ClientType::Mobile, ClientType::Desktop] {
        let p = match q.player_from_client(&id, ct).await {
            Ok(p) => p,
            Err(e) => { println!("{ct:?}: player error {e}"); continue }
        };
        let ua = q.user_agent(ct).to_string();
        let a = p.audio_streams.iter().max_by_key(|a| a.bitrate);
        let v = p.video_only_streams.iter().filter(|s| s.height <= 1080).max_by_key(|s| s.height);
        println!("{ct:?}: muxed {} vonly {} audio {} title {:?}", p.video_streams.len(), p.video_only_streams.len(), p.audio_streams.len(), p.details.name);
        for (label, url, size) in [("audio", a.map(|a| a.url.clone()), a.map(|a| a.size)), ("video", v.map(|v| v.url.clone()), v.and_then(|v| v.size))] {
            let (Some(url), Some(size)) = (url, size) else { continue };
            for start in [0u64, 2_000_000, size / 2] {
                if start >= size { continue }
                let end = (start + 1_048_575).min(size - 1);
                let r = http.get(&url).header("User-Agent", &ua).header("Range", format!("bytes={start}-{end}")).send().await;
                match r {
                    Ok(r) => { let st = r.status(); let n = r.bytes().await.map(|b| b.len()).unwrap_or(0); println!("  {label} {start}-{end}/{size}: {st} got {n}") }
                    Err(e) => println!("  {label} {start}: err {e}"),
                }
            }
        }
    }
}
