import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, Card, DEFAULT_PREFS, errText, HistItem, IS_TV, Page, Prefs } from "./api";
import { Grid } from "./Cards";
import { Icon } from "./icons";
import Player from "./Player";
import { tvBack } from "./tv";

type View = "home" | "search" | "history";

export default function App() {
  const [profileId, setProfileId] = useState("");
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [history, setHistory] = useState<HistItem[]>([]);
  const [view, setView] = useState<View>("home");
  const [home, setHome] = useState<Card[] | null>(null);
  const [homeErr, setHomeErr] = useState("");
  const homeAt = useRef(-1); // history length the feed was built from
  const [results, setResults] = useState<Page | null>(null);
  const [searching, setSearching] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [queue, setQueueState] = useState<Card[]>([]);
  const [idx, setIdx] = useState(0);
  const [full, setFullState] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // ---------- profile / prefs ----------

  const saveT = useRef<number | undefined>(undefined);
  const setPrefs = useCallback((part: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...part };
      window.clearTimeout(saveT.current);
      saveT.current = window.setTimeout(() => api.savePrefs(next).catch(() => {}), 400);
      return next;
    });
  }, []);

  const loadHome = useCallback(async () => {
    setHomeErr("");
    setHome(null);
    try {
      setHome(await api.home());
    } catch (e) {
      setHomeErr(errText(e));
      setHome([]);
    }
  }, []);

  useEffect(() => {
    api.boot().then((b) => {
      setProfileId(b.profile.id);
      setPrefsState({ ...DEFAULT_PREFS, ...b.profile.prefs });
      setHistory(b.history);
      homeAt.current = b.history.length;
      loadHome();
    });
  }, [loadHome]);

  const refreshHistory = useCallback(() => {
    api.history().then(setHistory).catch(() => {});
  }, []);

  const recent = useMemo(() => new Set(history.slice(0, 100).map((h) => h.id)), [history]);

  // ---------- navigation (Back = browser history: one entry per open layer) ----------

  const fullRef = useRef(full);
  fullRef.current = full;
  const viewRef = useRef(view);
  viewRef.current = view;

  const setFull = useCallback((f: boolean) => {
    if (f && !fullRef.current) history_push();
    setFullState(f);
  }, []);

  function goView(v: View) {
    if (v !== "home" && viewRef.current === "home") history_push();
    setView(v);
    setFullState(false);
    if (v === "home" && homeAt.current !== historyLen.current) {
      homeAt.current = historyLen.current;
      loadHome();
    }
    if (v === "history") refreshHistory();
  }
  const historyLen = useRef(0);
  historyLen.current = history.length;

  useEffect(() => {
    const onPop = () => {
      if (tvBack.handler?.()) return history_push();
      if (fullRef.current) setFullState(false);
      else if (viewRef.current !== "home") setView("home");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // ---------- search ----------

  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<string[]>([]);
  const [suggOpen, setSuggOpen] = useState(false);
  const suggT = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  function onType(v: string) {
    setText(v);
    window.clearTimeout(suggT.current);
    if (!v.trim()) return setSugg([]);
    suggT.current = window.setTimeout(() => {
      api.suggest(v).then((s) => {
        setSugg(s.slice(0, 8));
        setSuggOpen(true);
      }).catch(() => {});
    }, 250);
  }

  async function doSearch(q: string) {
    q = q.trim();
    if (!q) return;
    setText(q);
    setSuggOpen(false);
    inputRef.current?.blur();
    goView("search");
    setSearching(true);
    setResults(null);
    try {
      const page = await api.search(q);
      setResults(page);
      // a pasted video link plays straight away
      if (page.title === "Link" && page.items.length === 1) play(page.items, 0);
    } catch (e) {
      setResults({ title: `Search failed: ${errText(e)}`, items: [], more: false });
    } finally {
      setSearching(false);
    }
  }

  const moreRef = useRef<HTMLDivElement>(null);
  async function loadMore() {
    if (moreBusy || !results?.more) return;
    setMoreBusy(true);
    try {
      const p = await api.searchMore();
      setResults((r) => (r ? { ...r, items: [...r.items, ...p.items.filter((c) => !r.items.some((x) => x.id === c.id))], more: p.more } : r));
    } catch (e) {
      toast(errText(e));
    } finally {
      setMoreBusy(false);
    }
  }
  // auto "load more" when the end of the results scrolls into view (not on TV: button)
  useEffect(() => {
    const el = moreRef.current;
    if (!el || IS_TV) return;
    const ob = new IntersectionObserver((e) => e[0].isIntersecting && loadMore());
    ob.observe(el);
    return () => ob.disconnect();
  });

  // ---------- playing ----------

  function play(list: Card[], i: number) {
    const playable = list.filter((c) => !c.live);
    const at = Math.max(0, playable.findIndex((c) => c.id === list[i].id));
    setQueueState(playable);
    setIdx(at);
    setFull(true);
  }
  const setQueue = useCallback((q: Card[], i: number) => {
    setQueueState(q);
    setIdx(i);
  }, []);

  function closePlayer() {
    setQueueState([]);
    setIdx(0);
    setFullState(false);
  }

  // ---------- render ----------

  let body: React.ReactNode;
  if (view === "home") {
    body = (
      <>
        <div className="sec-h">
          <h2>{history.length ? "For you" : "Trending"}</h2>
          <span className="dim">{history.length ? `from your last ${Math.min(8, history.length)} watched` : "watch something to get your own picks"}</span>
          <button className="pill" onClick={() => { homeAt.current = history.length; loadHome(); }}><Icon name="refresh" /> Refresh</button>
        </div>
        {homeErr && <div className="msg">Could not load: {homeErr}</div>}
        {home === null ? <div className="spin center" /> : <Grid items={home} onPlay={(i) => play(home, i)} />}
      </>
    );
  } else if (view === "search") {
    body = (
      <>
        <div className="sec-h"><h2>{results?.title ?? "Searching…"}</h2></div>
        {searching && <div className="spin center" />}
        {results && <Grid items={results.items} onPlay={(i) => play(results.items, i)} />}
        {results?.more && (
          <div ref={moreRef} className="more">
            <button className="pill" disabled={moreBusy} onClick={loadMore}>{moreBusy ? "Loading…" : "Load more"}</button>
          </div>
        )}
      </>
    );
  } else {
    body = (
      <>
        <div className="sec-h">
          <h2>History</h2>
          <span className="dim">{history.length} videos · profile #{profileId.slice(0, 6)}</span>
          {history.length > 0 && (
            <button className="pill" onClick={() => { if (confirm("Clear the whole watch history? Your recommendations start over.")) api.clearHistory().then(refreshHistory); }}>Clear history</button>
          )}
        </div>
        {!history.length && <div className="msg">Nothing watched yet.</div>}
        <Grid
          items={history}
          onPlay={(i) => play(history, i)}
          onRemove={(c) => api.removeHistory(c.id).then(refreshHistory)}
          note={(c) => {
            const h = c as HistItem;
            return `${h.count > 1 ? `played ${h.count}× · ` : ""}${new Date(h.last * 1000).toLocaleDateString()}`;
          }}
        />
      </>
    );
  }

  return (
    <div className={`app ${queue.length ? "has-mini" : ""}`}>
      <header className="top">
        <button className="logo" onClick={() => goView("home")}>
          <span className="logo-i"><Icon name="play" /></span>
          <span className="logo-t">Random Tube</span>
        </button>
        <div className="search">
          <form onSubmit={(e) => { e.preventDefault(); doSearch(text); }}>
            <input
              ref={inputRef}
              type="text"
              value={text}
              placeholder="Search, or paste a YouTube link"
              onChange={(e) => onType(e.target.value)}
              onFocus={() => sugg.length && setSuggOpen(true)}
              onBlur={() => window.setTimeout(() => setSuggOpen(false), 200)}
              onKeyDown={(e) => e.key === "Escape" && setSuggOpen(false)}
            />
            <button type="submit" className="search-b" title="Search"><Icon name="search" /></button>
          </form>
          {suggOpen && sugg.length > 0 && (
            <div className="sugg">
              {sugg.map((s) => (
                <button key={s} onMouseDown={(e) => e.preventDefault()} onClick={() => doSearch(s)}>
                  <Icon name="search" /> {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <nav>
          <button className={`nav ${view === "home" ? "on" : ""}`} onClick={() => goView("home")}><Icon name="home" /><span>Home</span></button>
          <button className={`nav ${view === "history" ? "on" : ""}`} onClick={() => goView("history")}><Icon name="history" /><span>History</span></button>
          <button className={`nav music ${prefs.music ? "on lit" : ""}`} title="Music only: sound only, skips videos not tagged Music" onClick={() => { setPrefs({ music: !prefs.music }); toast(prefs.music ? "Music only off" : "Music only on"); }}>
            <Icon name="music" /><span>Music only</span>
          </button>
          <span className="who" title={`Anonymous profile ${profileId}: your history and picks are kept on this device`}><Icon name="person" /><span>#{profileId.slice(0, 6)}</span></span>
        </nav>
      </header>

      <main className="page">{body}</main>

      {queue.length > 0 && (
        <Player
          queue={queue}
          idx={idx}
          setQueue={setQueue}
          prefs={prefs}
          setPrefs={setPrefs}
          full={full}
          setFull={setFull}
          recent={recent}
          onWatched={refreshHistory}
          toast={toast}
          onClose={closePlayer}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
      </div>
    </div>
  );
}

function history_push() {
  window.history.pushState({ rt: Date.now() }, "");
}
