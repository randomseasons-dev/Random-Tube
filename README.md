# Random Tube

An ad-free YouTube player for Windows, Android phones and Android TV, with its own player menu.

- **Player menu**: previous · play/pause · next · loop · captions · resolution (remembers your choice) · Music only · fullscreen
- **Double-tap** the right side of the video to skip ahead 10 s, or the left side to go back 10 s. Double-tap the middle for fullscreen.
- **No ads**: the app takes the raw audio and video streams and plays them in its own player. YouTube's player and its ads never load.
- **Background play**: keeps playing when minimized on Windows. On Android it keeps playing with the screen off and shows a media notification with prev / play / next.
- **Music only**: plays sound only and automatically skips any video whose YouTube category isn't *Music*.
- **Search** with suggestions. You can also paste a video or playlist link.
- **Your own picks**: an anonymous profile is created on first start. Your watch history stays on the device, and "For you" is built from videos related to what you watched last.

TV remote: ←/→ = ±10 s, OK = play/pause, ↑/↓ = open the menu, Back = close menu / leave the player.
Keyboard (Windows): Space/K, ←/→, F, N, P, M (Music only), L (loop), Esc.

## Build

```
npm install
npx tauri build                                               # Windows
npx tauri android build --apk --target aarch64 --target armv7 # Android phone + TV
```

The Android build generates QuickJS bindings with bindgen, so it needs libclang: `python -m pip install --target D:\AndroidDev\libclang libclang`, then set
`LIBCLANG_PATH=D:\AndroidDev\libclang\clang\native` and
`BINDGEN_EXTRA_CLANG_ARGS=--sysroot=<NDK>/toolchains/llvm/prebuilt/windows-x86_64/sysroot -isystem <NDK>/toolchains/llvm/prebuilt/windows-x86_64/lib/clang/18/include`.

Streams come from YouTube's visionOS player client. Its stream URLs need no PO token, so YouTube serves the whole file (since late 2026 the iOS client's URLs return 403 after the first ~1 MB). RustyPipe is the second choice. On Windows, [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH (or next to the exe) is the last fallback; keep it updated with `yt-dlp -U`. "Made for kids" videos aren't available through the visionOS client.

Built on [RustyPipe](https://codeberg.org/ThetaDev/rustypipe) (GPL-3.0).

## License

GPL-3.0 (see LICENSE.md), because it uses [RustyPipe](https://codeberg.org/ThetaDev/rustypipe), which is GPL-3.0.
