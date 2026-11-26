// Dev check: related videos per id. (outside the sandbox)
use rustypipe::client::RustyPipe;
#[tokio::main]
async fn main() {
    let rp = RustyPipe::builder().no_storage().build().unwrap();
    for id in std::env::args().skip(1) {
        match rp.query().video_details(&id).await {
            Ok(d) => println!("{id}: related {} (shorts {}, live {}) ctoken {}", d.recommended.items.len(), d.recommended.items.iter().filter(|c| c.is_short).count(), d.recommended.items.iter().filter(|c| c.is_live).count(), d.recommended.ctoken.is_some()),
            Err(e) => println!("{id}: err {e}"),
        }
    }
}
