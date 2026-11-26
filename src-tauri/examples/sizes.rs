// Dev check: print the client User-Agent, best audio URL and the HLS manifest URL for curl experiments. (outside the sandbox)
use rustypipe::client::RustyPipe;
#[tokio::main]
async fn main() {
    let rp = RustyPipe::builder().no_storage().build().unwrap();
    let q = rp.query();
    let id = std::env::args().nth(1).unwrap();
    let p = q.player(&id).await.unwrap();
    let a = p.audio_streams.iter().max_by_key(|a| a.bitrate).unwrap();
    println!("{}\n{}\n{}\n{}", q.user_agent(p.client_type), a.url, a.size, p.hls_manifest_url.unwrap_or_default());
}
