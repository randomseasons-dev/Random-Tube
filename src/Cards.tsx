import { Card, fmtTime, fmtViews } from "./api";
import { Icon } from "./icons";

const fallback = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

export function Thumb({ c }: { c: Card }) {
  return (
    <div className="thumb">
      <img
        loading="lazy"
        src={c.thumb || fallback(c.id)}
        alt=""
        onError={(e) => {
          const img = e.currentTarget;
          if (img.src !== fallback(c.id)) img.src = fallback(c.id);
        }}
      />
      {c.live ? <span className="dur live">LIVE</span> : c.duration ? <span className="dur">{fmtTime(c.duration)}</span> : null}
    </div>
  );
}

interface GridProps {
  items: Card[];
  onPlay(i: number): void;
  onRemove?(c: Card): void;
  note?(c: Card): string;
}

export function Grid({ items, onPlay, onRemove, note }: GridProps) {
  return (
    <div className="grid">
      {items.map((c, i) => (
        <div className="cell" key={c.id + i}>
          <button className="card" onClick={() => onPlay(i)}>
            <Thumb c={c} />
            <div className="card-t">
              <b>{c.title}</b>
              <span>{c.channel}</span>
              <span className="dim">{[fmtViews(c.views), c.published, note?.(c)].filter(Boolean).join(" · ")}</span>
            </div>
          </button>
          {onRemove && (
            <button className="rm" title="Remove from history" onClick={() => onRemove(c)}>
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
