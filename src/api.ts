import { invoke } from "@tauri-apps/api/core";

export interface Card {
  id: string;
  title: string;
  channel: string;
  channelId: string;
  duration: number;
  thumb: string;
  views?: number | null;
  published?: string | null;
  live: boolean;
  short: boolean;
}

export interface VStream {
  url: string;
  height: number;
  fps: number;
  mime: string;
  bitrate: number;
  muxed: boolean;
}

export interface AStream {
  url: string;
  mime: string;
  bitrate: number;
}

export interface Sub {
  lang: string;
  name: string;
  auto: boolean;
  url: string;
}

export interface VideoInfo {
  card: Card;
  isMusic: boolean;
  video: VStream[];
  audio: AStream[];
  subs: Sub[];
  related: Card[];
  source: string;
}

export interface Page {
  title: string;
  items: Card[];
  more: boolean;
}

export interface HistItem extends Card {
  isMusic: boolean;
  last: number;
  count: number;
}

export interface Prefs {
  /** preferred height, 0 = auto */
  quality: number;
  captions: boolean;
  captionLang: string;
  music: boolean;
  loop: boolean;
  volume: number;
}

export const DEFAULT_PREFS: Prefs = { quality: 0, captions: false, captionLang: "en", music: false, loop: false, volume: 1 };

export interface Boot {
  profile: { id: string; created: number; prefs: Partial<Prefs> };
  history: HistItem[];
}

/** Bridge the Android app adds (MainActivity.kt): media notification + TV check + fullscreen. */
interface AndroidBridge {
  isTv(): boolean;
  update(json: string): void;
  stop(): void;
  setFullscreen(on: boolean): void;
}

declare global {
  interface Window {
    RTAndroid?: AndroidBridge;
    /** called by the Android media notification: play / pause / toggle / next / prev */
    __rtMedia?: (cmd: string) => void;
  }
}

export const IS_ANDROID = /Android/i.test(navigator.userAgent);
export const IS_TV = IS_ANDROID && (window.RTAndroid ? window.RTAndroid.isTv() : navigator.maxTouchPoints === 0);
export const IS_PHONE = IS_ANDROID && !IS_TV;

export const api = {
  boot: () => invoke<Boot>("boot"),
  savePrefs: (prefs: Prefs) => invoke<void>("save_prefs", { prefs }),
  suggest: (text: string) => invoke<string[]>("suggest", { text }),
  search: (text: string) => invoke<Page>("search", { text }),
  searchMore: () => invoke<Page>("search_more"),
  home: () => invoke<Card[]>("home"),
  video: (id: string, ytdlp = false) => invoke<VideoInfo>("video", { id, ytdlp }),
  isMusic: (id: string) => invoke<boolean>("is_music", { id }),
  subtitle: (url: string) => invoke<string>("subtitle", { url }),
  recordWatch: (card: Card, isMusic: boolean) => invoke<void>("record_watch", { card, isMusic }),
  history: () => invoke<HistItem[]>("history"),
  removeHistory: (id: string) => invoke<void>("remove_history", { id }),
  clearHistory: () => invoke<void>("clear_history"),
};

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function fmtViews(n?: number | null): string {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B views`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M views`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K views`;
  return `${n} views`;
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
