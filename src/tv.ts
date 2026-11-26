// TV remote navigation: the arrow keys move a visible focus to the nearest item in that
// direction, OK (Enter) presses it. Only active in the TV (Android) build.
// Views that handle arrows themselves (the player) call preventDefault first.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="checkbox"]):not([type="range"]), [tabindex="0"]';

type Dir = "left" | "right" | "up" | "down";
const KEY_DIR: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

function isShown(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.pointerEvents !== "none";
}

/** The top-most open layer: an open player menu > the full player > the page. */
function scope(): ParentNode {
  return (
    document.querySelector(".pop") ??
    document.querySelector(".player.full") ??
    document
  );
}

export function candidates(): HTMLElement[] {
  return Array.from(scope().querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isShown);
}

/** Lets an open view (the player's menus) take the remote's Back press first; returns true if it did. */
export const tvBack: { handler: (() => boolean) | null } = { handler: null };

export function focusEl(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function move(dir: Dir): boolean {
  const list = candidates();
  if (!list.length) return false;
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || cur === document.body || !list.includes(cur)) {
    focusEl(list[0]);
    return true;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    let main: number;
    let side: number;
    switch (dir) {
      case "right": main = b.left - a.right; side = Math.abs(by - ay); if (bx <= ax) continue; break;
      case "left": main = a.left - b.right; side = Math.abs(by - ay); if (bx >= ax) continue; break;
      case "down": main = b.top - a.bottom; side = Math.abs(bx - ax); if (by <= ay) continue; break;
      default: main = a.top - b.bottom; side = Math.abs(bx - ax); if (by >= ay) continue;
    }
    const score = Math.max(main, 0) + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (best) focusEl(best);
  return !!best;
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const dir = KEY_DIR[e.key];
  const el = document.activeElement as HTMLElement | null;
  if (dir) {
    // inside a text box, left/right move the cursor until it reaches the edge
    if (el instanceof HTMLInputElement && (dir === "left" || dir === "right")) {
      const atStart = (el.selectionStart ?? 0) === 0;
      const atEnd = (el.selectionEnd ?? 0) >= el.value.length;
      if ((dir === "left" && !atStart) || (dir === "right" && !atEnd)) return;
    }
    e.preventDefault();
    move(dir);
  } else if (e.key === "Enter" && el && el !== document.body && !(el instanceof HTMLButtonElement) && !(el instanceof HTMLInputElement)) {
    e.preventDefault();
    el.click();
  }
}

export function initTv() {
  document.documentElement.classList.add("tv");
  window.addEventListener("keydown", onKey);
}
