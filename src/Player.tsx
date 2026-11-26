import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, AStream, Card, errText, fmtTime, IS_ANDROID, IS_PHONE, IS_TV, Prefs, Sub, VideoInfo, VStream } from "./api";
import { Cue, cueAt, parseVtt } from "./captions";
import { candidates, focusEl, tvBack } from "./tv";
import { Icon } from "./icons";
import { Thumb } from "./Cards";

// Playback: YouTube serves HD as separate video-only + audio streams, so "dual" mode plays
// a muted <video> and an <audio> side by side with the audio as the clock. "muxed" is a
// single stream with sound (360p and below). "audio" is Music only: no video is fetched.
type Mode = "dual" | "muxed" | "audio";

interface Props {
  queue: Card[];
  idx: number;
  setQueue(q: Card[], idx: number): void;
  prefs: Prefs;
  setPrefs(p: Partial<Prefs>): void;
  full: boolean;
  setFull(f: boolean): void;
  recent: Set<string>;
  onWatched(): void;
  toast(msg: string): void;
  onClose(): void;
}

const probeV = document.createElement("video");
const probeA = document.createElement("audio");
const canV = (m: string) => probeV.canPlayType(m) !== "";
const canA = (m: string) => probeA.canPlayType(m) !== "";
// hardware-decoded everywhere first: H.264, then VP9, then AV1
const codecRank = (m: string) => (m.includes("avc1") ? 0 : /vp0?9/.test(m) ? 1 : m.includes("av01") ? 2 : 3);
const autoHeight = () => (IS_PHONE ? 720 : 1080);

function pickAudio(inf: VideoInfo): AStream | null {
  return inf.audio.filter((a) => canA(a.mime)).sort((a, b) => b.bitrate - a.bitrate)[0] ?? null;
}

function playableVideo(inf: VideoInfo): VStream[] {
  const haveAudio = !!pickAudio(inf);
  return inf.video.filter((s) => canV(s.mime) && (s.muxed || haveAudio));
}

function heightsOf(inf: VideoInfo): number[] {
  return [...new Set(playableVideo(inf).map((s) => s.height))].sort((a, b) => b - a);
}

function pickVideo(inf: VideoInfo, quality: number): VStream | null {
  const list = playableVideo(inf);
  if (!list.length) return null;
  const want = quality || autoHeight();
  const hs = heightsOf(inf);
  const h = hs.find((x) => x <= want) ?? hs[hs.length - 1];
  return (
    list
      .filter((s) => s.height === h)
      .sort((a, b) => Number(b.muxed) - Number(a.muxed) || codecRank(a.mime) - codecRank(b.mime) || b.fps - a.fps || b.bitrate - a.bitrate)[0] ?? null
  );
}

function chooseSub(inf: VideoInfo, p: Prefs): Sub | null {
  if (!p.captions) return null;
  const l = p.captionLang;
  const base = l.split("-")[0];
  return (
    inf.subs.find((s) => s.lang === l && !s.auto) ??
    inf.subs.find((s) => s.lang === l) ??
    inf.subs.find((s) => s.lang.split("-")[0] === base && !s.auto) ??
    inf.subs.find((s) => s.lang.split("-")[0] === base) ??
    null
  );
}

const hq = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export default function Player(p: Props) {
  const vRef = useRef<HTMLVideoElement>(null);
  const aRef = useRef<HTMLAudioElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);

  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [mode, setMode] = useState<Mode>("muxed");
  const [curV, setCurV] = useState<VStream | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [buf, setBuf] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [show, setShow] = useState(true);
  const [pop, setPop] = useState<null | "quality" | "captions">(null);
  const [fs, setFs] = useState(false);
  const [curSub, setCurSub] = useState<Sub | null>(null);
  const [capText, setCapText] = useState("");
  const [seekFx, setSeekFx] = useState<{ side: number; n: number; k: number } | null>(null);

  // latest values for event handlers / timers
  const infoRef = useRef<VideoInfo | null>(null);
  const modeRef = useRef<Mode>("muxed");
  const prefsRef = useRef(p.prefs);
  prefsRef.current = p.prefs;
  const queueRef = useRef(p.queue);
  queueRef.current = p.queue;
  const idxRef = useRef(p.idx);
  idxRef.current = p.idx;
  const recentRef = useRef(p.recent);
  recentRef.current = p.recent;
  const popRef = useRef(pop);
  popRef.current = pop;
  const want = useRef(false); // the user wants it playing
  const vStall = useRef(false); // audio paused because the video is buffering
  const aStall = useRef(false);
  const cuesRef = useRef<Cue[]>([]);
  const loadSeq = useRef(0);
  const skips = useRef(0);
  const retried = useRef(""); // id of the video being retried
  const retryN = useRef(0);
  const lastRelated = useRef<Card[]>([]);
  const hideT = useRef<number | undefined>(undefined);

  const card = info?.card ?? p.queue[p.idx];
  const master = () => (modeRef.current === "muxed" ? vRef.current! : aRef.current!);
  const active = (): HTMLMediaElement[] => {
    const v = vRef.current!;
    const a = aRef.current!;
    return modeRef.current === "audio" ? [a] : modeRef.current === "muxed" ? [v] : [v, a];
  };

  const poke = useCallback(() => {
    setShow(true);
    window.clearTimeout(hideT.current);
    hideT.current = window.setTimeout(() => {
      if (!want.current || popRef.current) return;
      setShow(false);
      // TV: focus leaves the hidden menu so the arrows seek again
      const f = document.activeElement;
      if (IS_TV && f instanceof HTMLElement && f.closest(".ctl, .collapse")) f.blur();
    }, 3200);
  }, []);

  // ---------- media engine ----------

  function applyVolume() {
    const v = vRef.current!;
    const a = aRef.current!;
    const vol = prefsRef.current.volume;
    a.volume = vol;
    v.volume = vol;
    v.muted = modeRef.current !== "muxed";
  }

  function attach(inf: VideoInfo, startAt: number, autoplay: boolean) {
    const v = vRef.current!;
    const a = aRef.current!;
    const aud = pickAudio(inf);
    let m: Mode;
    let vs: VStream | null = null;
    if (prefsRef.current.music && aud) m = "audio";
    else {
      vs = pickVideo(inf, prefsRef.current.quality);
      if (vs) m = vs.muxed ? "muxed" : "dual";
      else if (aud) m = "audio";
      else {
        setError("No stream this device can play");
        return;
      }
    }
    want.current = false;
    vStall.current = aStall.current = false;
    v.pause();
    a.pause();
    modeRef.current = m;
    setMode(m);
    setCurV(vs);
    if (m === "audio") {
      v.removeAttribute("src");
      v.load();
      a.src = aud!.url;
    } else if (m === "muxed") {
      a.removeAttribute("src");
      a.load();
      v.src = vs!.url;
    } else {
      v.src = vs!.url;
      a.src = aud!.url;
    }
    applyVolume();
    for (const el of active()) {
      el.playbackRate = 1;
      el.currentTime = startAt;
    }
    if (autoplay) play();
    else setPlaying(false);
  }

  function play() {
    want.current = true;
    setPlaying(true);
    for (const el of active()) el.play().catch(() => {});
    poke();
  }

  function pause() {
    want.current = false;
    setPlaying(false);
    vRef.current!.pause();
    aRef.current!.pause();
    setShow(true);
  }

  const toggle = () => (want.current ? pause() : play());

  function seek(t: number) {
    const d = master().duration || infoRef.current?.card.duration || 0;
    t = Math.max(0, d ? Math.min(t, d - 0.3) : t);
    for (const el of active()) el.currentTime = t;
    setTime(t);
  }

  function seekBy(d: number) {
    seek(master().currentTime + d);
  }

  // timer: clock, A/V sync, captions
  useEffect(() => {
    const t = window.setInterval(() => {
      const v = vRef.current;
      const a = aRef.current;
      if (!v || !a) return;
      const m = modeRef.current;
      const ms = m === "muxed" ? v : a;
      setTime(ms.currentTime);
      setDur(isFinite(ms.duration) ? ms.duration : infoRef.current?.card.duration ?? 0);
      let b = 0;
      for (let i = 0; i < ms.buffered.length; i++) if (ms.buffered.start(i) <= ms.currentTime + 0.5) b = ms.buffered.end(i);
      setBuf(b);
      if (m === "dual" && want.current && !document.hidden) {
        if (!a.paused && v.paused && !vStall.current && !aStall.current) {
          // back from the background: the video was suspended, catch it up
          v.currentTime = a.currentTime;
          v.play().catch(() => {});
        } else if (!a.paused && !v.paused) {
          const d = v.currentTime - a.currentTime;
          if (Math.abs(d) > 1) {
            v.currentTime = a.currentTime;
            v.playbackRate = 1;
          } else if (Math.abs(d) > 0.08) v.playbackRate = d > 0 ? 0.92 : 1.08;
          else v.playbackRate = 1;
        }
      }
      setCapText(cuesRef.current.length ? cueAt(cuesRef.current, ms.currentTime) : "");
    }, 250);
    return () => window.clearInterval(t);
  }, []);

  const onVWaiting = () => {
    if (modeRef.current === "dual" && want.current && !document.hidden) {
      vStall.current = true;
      aRef.current!.pause();
    }
  };
  const onVPlaying = () => {
    if (modeRef.current === "dual" && vStall.current) {
      vStall.current = false;
      if (want.current) aRef.current!.play().catch(() => {});
    }
  };
  const onAWaiting = () => {
    if (modeRef.current === "dual" && want.current) {
      aStall.current = true;
      vRef.current!.pause();
    }
  };
  const onAPlaying = () => {
    if (modeRef.current === "dual" && aStall.current) {
      aStall.current = false;
      if (want.current && !document.hidden) {
        vRef.current!.currentTime = aRef.current!.currentTime;
        vRef.current!.play().catch(() => {});
      }
    }
  };
  // paused from outside (headset unplugged, media key...): follow it
  const onMasterPause = (el: HTMLMediaElement) => {
    if (el !== master() || !want.current || !el.paused || el.ended || vStall.current || aStall.current) return;
    want.current = false;
    setPlaying(false);
    vRef.current!.pause();
    aRef.current!.pause();
  };
  const onMasterPlay = (el: HTMLMediaElement) => {
    if (el !== master() || want.current) return;
    play();
  };
  const onEnded = (el: HTMLMediaElement) => {
    if (el !== master()) return;
    if (prefsRef.current.loop) {
      seek(0);
      play();
    } else next();
  };
  const onMediaError = (el: HTMLMediaElement) => {
    if (!el.getAttribute("src") || !el.error) return;
    const inf = infoRef.current;
    if (!inf) return;
    const c = inf.card;
    const n = retried.current === c.id ? retryN.current : 0;
    if (n < 2) {
      // stream links expire or a stream breaks: fresh links from the same spot, then
      // (Windows) once more through yt-dlp
      retried.current = c.id;
      retryN.current = n + 1;
      load(c, { startAt: master().currentTime || 0, ytdlp: n === 1 && !IS_ANDROID, autoplay: want.current });
    } else setError(`Playback failed (${el.error.message || `error ${el.error.code}`}). Try another resolution or press Next.`);
  };

  // ---------- loading / queue ----------

  async function loadCaptions(inf: VideoInfo) {
    cuesRef.current = [];
    setCapText("");
    const s = chooseSub(inf, prefsRef.current);
    setCurSub(s);
    if (!s) return;
    try {
      const txt = await api.subtitle(s.url);
      if (infoRef.current === inf) cuesRef.current = parseVtt(txt);
    } catch (e) {
      p.toast(`Captions failed: ${errText(e)}`);
    }
  }

  function skipNotMusic(c: Card) {
    p.toast(`Skipped (not music): ${c.title}`);
    skips.current++;
    if (skips.current > 25) {
      skips.current = 0;
      setLoading(false);
      setError("Music only: no music in the next 25 videos.");
      return;
    }
    next();
  }

  async function load(c: Card, o: { startAt?: number; ytdlp?: boolean; autoplay?: boolean } = {}) {
    const seq = ++loadSeq.current;
    setError("");
    setLoading(true);
    try {
      if (prefsRef.current.music) {
        const m = await api.isMusic(c.id);
        if (seq !== loadSeq.current) return;
        if (!m) return skipNotMusic(c);
      }
      const inf = await api.video(c.id, !!o.ytdlp);
      if (seq !== loadSeq.current) return;
      if (prefsRef.current.music && !inf.isMusic) return skipNotMusic(c);
      skips.current = 0;
      inf.card = { ...c, ...inf.card, title: inf.card.title || c.title, thumb: c.thumb || inf.card.thumb, duration: inf.card.duration || c.duration };
      infoRef.current = inf;
      lastRelated.current = inf.related;
      setInfo(inf);
      attach(inf, o.startAt ?? 0, o.autoplay ?? true);
      loadCaptions(inf);
      if (retried.current !== c.id) api.recordWatch(inf.card, inf.isMusic).then(p.onWatched).catch(() => {});
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(errText(e));
      // keep the music going: an unplayable track just moves on
      if (prefsRef.current.music) window.setTimeout(() => seq === loadSeq.current && next(), 2500);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  function next() {
    const q = queueRef.current;
    const i = idxRef.current;
    if (i + 1 < q.length) return p.setQueue(q, i + 1);
    // end of the queue: continue with a related video not played lately
    const inQueue = new Set(q.map((c) => c.id));
    const ok = (c: Card) => !inQueue.has(c.id) && !c.short && !c.live;
    const rel = lastRelated.current;
    const pick = rel.find((c) => ok(c) && !recentRef.current.has(c.id)) ?? rel.find(ok);
    if (pick) p.setQueue([...q, pick], i + 1);
    else {
      setLoading(false);
      p.toast("Nothing more to play");
    }
  }

  function prev() {
    if (master().currentTime > 5 || idxRef.current === 0) return seek(0);
    p.setQueue(queueRef.current, idxRef.current - 1);
  }

  const curId = p.queue[p.idx]?.id;
  useEffect(() => {
    const c = queueRef.current[idxRef.current];
    if (!c) return;
    retried.current = "";
    infoRef.current = null;
    setInfo(null);
    cuesRef.current = [];
    setCapText("");
    setTime(0);
    load(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.idx, curId]);

  // ---------- menu actions ----------

  function setQuality(h: number) {
    p.setPrefs({ quality: h });
    prefsRef.current = { ...prefsRef.current, quality: h };
    setPop(null);
    if (infoRef.current && modeRef.current !== "audio") attach(infoRef.current, master().currentTime, want.current);
  }

  function toggleMusic() {
    const on = !prefsRef.current.music;
    p.setPrefs({ music: on });
    p.toast(on ? "Music only: sound only, non-music videos are skipped" : "Music only off");
  }

  // Music only switched (here or in the top bar): sound-only stream, or skip a non-music video
  const lastMusic = useRef(p.prefs.music);
  useEffect(() => {
    if (lastMusic.current === p.prefs.music) return;
    lastMusic.current = p.prefs.music;
    const inf = infoRef.current;
    if (!inf) return;
    if (p.prefs.music && !inf.isMusic) return skipNotMusic(inf.card);
    attach(inf, master().currentTime, want.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.prefs.music]);

  useEffect(applyVolume, [p.prefs.volume]);

  function pickCaption(s: Sub | null) {
    setPop(null);
    const np = s ? { captions: true, captionLang: s.lang } : { captions: false };
    p.setPrefs(np);
    prefsRef.current = { ...prefsRef.current, ...np };
    if (infoRef.current) loadCaptions(infoRef.current);
  }

  async function setFullscreen(on: boolean) {
    setFs(on);
    if (on) p.setFull(true);
    if (IS_ANDROID) window.RTAndroid?.setFullscreen(on);
    else await getCurrentWindow().setFullscreen(on).catch(() => {});
  }

  // ---------- gestures: double tap left/right = -/+10 s ----------

  const lastTap = useRef<{ t: number; side: number } | null>(null);
  const singleT = useRef<number | undefined>(undefined);
  function onTap(e: React.PointerEvent) {
    if (!p.full) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const side = x < 0.4 ? -1 : x > 0.6 ? 1 : 0;
    const now = Date.now();
    const lt = lastTap.current;
    if (lt && now - lt.t < 320) {
      window.clearTimeout(singleT.current);
      lastTap.current = { t: now, side };
      if (side === 0) {
        if (lt.side === 0) setFullscreen(!fs);
        return;
      }
      seekBy(side * 10);
      setSeekFx((f) => ({ side, n: f && f.side === side ? f.n + 10 : 10, k: now }));
      return;
    }
    lastTap.current = { t: now, side };
    const mouse = e.pointerType === "mouse";
    singleT.current = window.setTimeout(() => {
      if (mouse) toggle();
      else if (show) setShow(false);
      else poke();
    }, 300);
    if (mouse) poke();
  }
  useEffect(() => {
    if (!seekFx) return;
    const t = window.setTimeout(() => setSeekFx(null), 700);
    return () => window.clearTimeout(t);
  }, [seekFx]);

  // ---------- progress bar ----------

  function seekFromBar(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (dur) seek(f * dur);
    poke();
  }

  // ---------- keys, Back, media keys, Android notification ----------

  const cmd = useRef<(c: string) => void>(() => {});
  cmd.current = (c: string) => {
    if (c === "play") play();
    else if (c === "pause") pause();
    else if (c === "toggle") toggle();
    else if (c === "next") next();
    else if (c === "prev") prev();
  };

  useEffect(() => {
    window.__rtMedia = (c) => cmd.current(c);
    const ms = navigator.mediaSession;
    if (ms) {
      ms.setActionHandler("play", () => cmd.current("play"));
      ms.setActionHandler("pause", () => cmd.current("pause"));
      ms.setActionHandler("nexttrack", () => cmd.current("next"));
      ms.setActionHandler("previoustrack", () => cmd.current("prev"));
      ms.setActionHandler("seekforward", () => seekBy(10));
      ms.setActionHandler("seekbackward", () => seekBy(-10));
    }
    return () => {
      window.__rtMedia = undefined;
      window.RTAndroid?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!card) return;
    const ms = navigator.mediaSession;
    if (ms) {
      ms.metadata = new MediaMetadata({ title: card.title, artist: card.channel, artwork: [{ src: hq(card.id), sizes: "480x360", type: "image/jpeg" }] });
      ms.playbackState = playing ? "playing" : "paused";
    }
    window.RTAndroid?.update(JSON.stringify({ title: card.title, artist: card.channel, playing, thumb: hq(card.id) }));
  }, [card?.id, card?.title, playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement && t.type === "text") return;
      const k = e.key;
      const media: Record<string, () => void> = {
        MediaPlayPause: toggle,
        MediaPlay: play,
        MediaPause: pause,
        MediaTrackNext: next,
        MediaTrackPrevious: prev,
        MediaFastForward: () => seekBy(10),
        MediaRewind: () => seekBy(-10),
      };
      if (media[k]) {
        e.preventDefault();
        media[k]();
        return;
      }
      if (!p.full) return;
      if (IS_TV) {
        if (popRef.current) return;
        const f = document.activeElement;
        const onVideo = !f || f === document.body || !!stageRef.current?.contains(f);
        const hidden = !show && onVideo;
        if (hidden && (k === "ArrowLeft" || k === "ArrowRight")) {
          e.preventDefault();
          seekBy(k === "ArrowLeft" ? -10 : 10);
          setSeekFx((f) => ({ side: k === "ArrowLeft" ? -1 : 1, n: f ? f.n + 10 : 10, k: Date.now() }));
        } else if (hidden && k === "Enter") {
          e.preventDefault();
          toggle();
        } else if (hidden && (k === "ArrowUp" || k === "ArrowDown")) {
          e.preventDefault();
          poke();
          window.setTimeout(() => focusEl(playBtn.current), 30);
        } else poke();
        return;
      }
      const act: Record<string, () => void> = {
        " ": toggle,
        k: toggle,
        ArrowLeft: () => seekBy(-10),
        ArrowRight: () => seekBy(10),
        f: () => setFullscreen(!fs),
        n: next,
        p: prev,
        m: toggleMusic,
        l: () => p.setPrefs({ loop: !prefsRef.current.loop }),
        Escape: () => (fs ? setFullscreen(false) : pop ? setPop(null) : p.setFull(false)),
      };
      const f = act[k.length === 1 ? k.toLowerCase() : k];
      if (f) {
        e.preventDefault();
        f();
        poke();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => {
    if (!p.full) return;
    tvBack.handler = () => {
      if (popRef.current) {
        setPop(null);
        return true;
      }
      if (IS_TV && show && want.current) {
        setShow(false);
        (document.activeElement as HTMLElement | null)?.blur();
        return true;
      }
      if (fs && !IS_TV) {
        setFullscreen(false);
        return true;
      }
      return false;
    };
    return () => {
      tvBack.handler = null;
    };
  });

  // TV: focus the first menu entry when a menu opens
  useEffect(() => {
    if (pop && IS_TV) window.setTimeout(() => focusEl(candidates()[0]), 30);
  }, [pop]);

  // ---------- render ----------

  const heights = info ? heightsOf(info) : [];
  const qLabel = mode === "audio" ? "Audio" : curV ? `${curV.height}p` : "Auto";
  const upNext = p.queue.slice(p.idx + 1);
  const related = (info?.related ?? []).filter((c) => !c.short && !p.queue.some((q) => q.id === c.id));
  const playRelated = (c: Card) => p.setQueue([...p.queue.slice(0, p.idx + 1), c], p.idx + 1);
  const frac = (x: number) => (dur ? `${Math.min(100, (x / dur) * 100)}%` : "0%");

  const controls = (
    <div className={`ctl ${show || !playing ? "on" : ""}`} onPointerMove={poke}>
      <div className="bar" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seekFromBar(e); }} onPointerMove={(e) => e.buttons && seekFromBar(e)}>
        <div className="bar-buf" style={{ width: frac(buf) }} />
        <div className="bar-pos" style={{ width: frac(time) }} />
        <div className="bar-dot" style={{ left: frac(time) }} />
      </div>
      <div className="row">
        <button className="cb" title="Previous (P)" onClick={prev}><Icon name="prev" /></button>
        <button className="cb big" ref={playBtn} title="Play / pause (Space)" onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button>
        <button className="cb" title="Next (N)" onClick={next}><Icon name="next" /></button>
        {!IS_ANDROID && (
          <span className="vol">
            <button className="cb" title="Mute" onClick={() => p.setPrefs({ volume: p.prefs.volume > 0 ? 0 : 1 })}><Icon name={p.prefs.volume > 0 ? "volume" : "mute"} /></button>
            <input type="range" min={0} max={1} step={0.02} value={p.prefs.volume} onChange={(e) => p.setPrefs({ volume: +e.target.value })} />
          </span>
        )}
        <span className="time">{fmtTime(time)} / {fmtTime(dur)}</span>
        <span className="grow" />
        <button className={`cb ${p.prefs.loop ? "lit" : ""}`} title="Loop (L)" onClick={() => p.setPrefs({ loop: !p.prefs.loop })}><Icon name="loop" /></button>
        <button className={`cb ${curSub ? "lit" : ""}`} title="Captions" onClick={() => setPop(pop === "captions" ? null : "captions")}><Icon name="cc" /></button>
        <button className="cb q" title="Resolution" disabled={mode === "audio"} onClick={() => setPop(pop === "quality" ? null : "quality")}><Icon name="gear" /><span>{qLabel}</span></button>
        <button className={`cb music ${p.prefs.music ? "lit" : ""}`} title="Music only (M)" onClick={toggleMusic}><Icon name="music" /><span>Music only</span></button>
        <button className="cb" title="Fullscreen (F)" onClick={() => setFullscreen(!fs)}><Icon name={fs ? "fsExit" : "fs"} /></button>
      </div>
      {pop === "quality" && (
        <div className="pop">
          <div className="pop-h">Resolution</div>
          <button className={p.prefs.quality === 0 ? "sel" : ""} onClick={() => setQuality(0)}>Auto ({autoHeight()}p max)</button>
          {heights.map((h) => (
            <button key={h} className={p.prefs.quality === h ? "sel" : ""} onClick={() => setQuality(h)}>{h}p{h >= 2160 ? " 4K" : h >= 1440 ? " QHD" : h >= 720 ? " HD" : ""}</button>
          ))}
        </div>
      )}
      {pop === "captions" && (
        <div className="pop">
          <div className="pop-h">Captions</div>
          <button className={!curSub ? "sel" : ""} onClick={() => pickCaption(null)}>Off</button>
          {(info?.subs ?? []).map((s) => (
            <button key={s.lang + s.auto + s.url} className={curSub?.url === s.url ? "sel" : ""} onClick={() => pickCaption(s)}>
              {s.name || s.lang}{s.auto ? " (auto)" : ""}
            </button>
          ))}
          {info && !info.subs.length && <div className="pop-empty">No captions for this video</div>}
        </div>
      )}
    </div>
  );

  return (
    <div className={`player ${p.full ? "full" : "mini"} ${fs ? "fs" : ""}`}>
      <div className="main-col">
        <div className={`stage ${mode === "audio" ? "audio" : ""} ${show || !playing ? "" : "idle"}`} ref={stageRef} onPointerMove={() => p.full && poke()} onClick={() => !p.full && p.setFull(true)}>
          <video
            ref={vRef}
            playsInline
            preload="auto"
            poster={card ? hq(card.id) : undefined}
            onWaiting={onVWaiting}
            onPlaying={onVPlaying}
            onPause={(e) => onMasterPause(e.currentTarget)}
            onPlay={(e) => onMasterPlay(e.currentTarget)}
            onEnded={(e) => onEnded(e.currentTarget)}
            onError={(e) => onMediaError(e.currentTarget)}
          />
          <audio
            ref={aRef}
            preload="auto"
            onWaiting={onAWaiting}
            onPlaying={onAPlaying}
            onPause={(e) => onMasterPause(e.currentTarget)}
            onPlay={(e) => onMasterPlay(e.currentTarget)}
            onEnded={(e) => onEnded(e.currentTarget)}
            onError={(e) => onMediaError(e.currentTarget)}
          />
          {mode === "audio" && card && (
            <div className="art">
              <div className="art-bg" style={{ backgroundImage: `url(${hq(card.id)})` }} />
              <img src={hq(card.id)} alt="" />
              {p.full && <div className="art-tag"><Icon name="music" /> Music only</div>}
            </div>
          )}
          {capText && mode !== "audio" && <div className="cap">{capText.split("\n").map((l, i) => <span key={i}>{l}</span>)}</div>}
          <div className="tap" onPointerUp={onTap} />
          {loading && <div className="spin" />}
          {error && p.full && (
            <div className="err">
              <div>{error}</div>
              <div className="err-b">
                {card && <button onClick={() => load(card)}><Icon name="replay" /> Retry</button>}
                <button onClick={next}><Icon name="next" /> Next</button>
              </div>
            </div>
          )}
          {seekFx && (
            <div key={seekFx.k} className={`fx ${seekFx.side < 0 ? "l" : "r"}`}>
              {seekFx.side < 0 ? "«" : "»"} {seekFx.n}s
            </div>
          )}
          {p.full && (
            <button className={`collapse ${show || !playing ? "on" : ""}`} title="Back to browsing" onClick={(e) => { e.stopPropagation(); if (fs) setFullscreen(false); p.setFull(false); }}>
              <Icon name="down" />
            </button>
          )}
          {p.full && controls}
        </div>
        {p.full && !fs && card && (
          <div className="meta">
            <h1>{card.title}</h1>
            <div className="meta-sub">
              <span>{card.channel}</span>
              {info?.isMusic && <span className="tag"><Icon name="music" /> Music</span>}
              {info && <span className="dim">via {info.source}</span>}
            </div>
          </div>
        )}
      </div>

      {p.full && !fs && (
        <div className="side">
          {upNext.length > 0 && (
            <>
              <div className="side-h">Up next</div>
              {upNext.map((c, i) => (
                <button key={c.id + i} className="row-card" onClick={() => p.setQueue(p.queue, p.idx + 1 + i)}>
                  <Thumb c={c} />
                  <div className="rc-t"><b>{c.title}</b><span>{c.channel}</span></div>
                </button>
              ))}
            </>
          )}
          <div className="side-h">Related</div>
          {related.map((c) => (
            <button key={c.id} className="row-card" onClick={() => playRelated(c)}>
              <Thumb c={c} />
              <div className="rc-t"><b>{c.title}</b><span>{c.channel}</span></div>
            </button>
          ))}
          {!info && !error && <div className="dim pad">Loading…</div>}
        </div>
      )}

      {!p.full && card && (
        <div className="mini-bar">
          <button className="mini-t" onClick={() => p.setFull(true)}>
            <b>{card.title}</b>
            <span>{card.channel}{p.prefs.music ? " · Music only" : ""}</span>
          </button>
          <button className="cb" onClick={prev}><Icon name="prev" /></button>
          <button className="cb big" onClick={toggle}><Icon name={playing ? "pause" : "play"} /></button>
          <button className="cb" onClick={next}><Icon name="next" /></button>
          <button className="cb" title="Open player" onClick={() => p.setFull(true)}><Icon name="up" /></button>
          <button className="cb" title="Stop" onClick={p.onClose}><Icon name="close" /></button>
          <div className="mini-prog" style={{ width: frac(time) }} />
        </div>
      )}
    </div>
  );
}
