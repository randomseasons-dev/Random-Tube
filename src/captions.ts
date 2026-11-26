// WebVTT -> cues. YouTube's auto captions repeat the previous line in each cue and carry
// inline <c>/timestamp tags; tags are stripped and identical consecutive cues merged.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function ts(s: string): number {
  const p = s.trim().split(":").map(parseFloat);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

export function parseVtt(src: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of src.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    const text = lines
      .slice(ti + 1)
      .map((l) => l.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    const cue = { start: ts(a), end: ts(b.trim().split(/\s/)[0]), text };
    const prev = cues[cues.length - 1];
    if (prev && prev.text === cue.text && cue.start - prev.end < 0.05) prev.end = cue.end;
    else cues.push(cue);
  }
  return cues;
}

export function cueAt(cues: Cue[], t: number): string {
  const lines: string[] = [];
  for (const c of cues) {
    if (c.start > t) break;
    if (c.end > t) lines.push(c.text);
  }
  return lines.slice(-2).join("\n");
}
