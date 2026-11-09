// Drawing helpers shared by the notebook view and PDF export.
import type { Stroke } from "./format";
import { inkFor, type FontDef, type Tone } from "./settings";

export const LINE = 36;
export const TEXT_TOP = 72;
const TEXT_LEFT = 96;
const TEXT_RIGHT = 44;
const BOTTOM = 80;

/** Units per millimetre: A4 (210 mm) is 820 units wide. */
const MM = 820 / 210;
const SIZES_MM: Record<string, [number, number]> = {
  a4: [210, 297],
  b5: [176, 250],
  a5: [148, 210],
  square: [210, 210],
};

export interface PageDims {
  w: number;
  h: number;
  /** Text box width and height (a whole number of ruled lines). */
  tw: number;
  th: number;
  lines: number;
}

export function pageDims(size: string): PageDims {
  const [mw, mh] = SIZES_MM[size] ?? SIZES_MM.a4;
  const w = Math.round(mw * MM);
  const h = Math.round(mh * MM);
  const lines = Math.floor((h - TEXT_TOP - BOTTOM) / LINE);
  return { w, h, tw: w - TEXT_LEFT - TEXT_RIGHT, th: lines * LINE, lines };
}

/** Sets the CSS variables that size a page element. */
export function applyDims(el: HTMLElement, d: PageDims) {
  el.style.setProperty("--pw", d.w + "px");
  el.style.setProperty("--ph", d.h + "px");
  el.style.setProperty("--tw", d.tw + "px");
  el.style.setProperty("--th", d.th + "px");
}
/** Gap between the baseline and the ruled line below it. */
const BASELINE_GAP = 6;

export interface FontMetrics {
  size: number;
  top: number;
}

const metricsCache = new Map<string, FontMetrics>();

// Every font gets the same x-height as the reference (Caveat at 29px) and its
// baseline is placed just above the ruled line, so all fonts sit on the paper.
export function fontMetrics(font: FontDef, scale: number): FontMetrics {
  const key = font.id + scale;
  const hit = metricsCache.get(key);
  if (hit) return hit;
  const ctx = document.createElement("canvas").getContext("2d")!;
  const measure = (f: FontDef, px: number) => {
    ctx.font = `${f.weight} ${px}px "${f.family}"`;
    const x = ctx.measureText("x");
    const box = ctx.measureText("Hg");
    return { xh: x.actualBoundingBoxAscent, asc: box.fontBoundingBoxAscent, desc: box.fontBoundingBoxDescent };
  };
  const ref = measure({ id: "caveat", label: "", family: "Defter Caveat", weight: 500 }, 29);
  const probe = measure(font, 100);
  const size = probe.xh > 0 && ref.xh > 0 ? Math.round(((100 * ref.xh) / probe.xh) * scale * 10) / 10 : 29 * scale;
  const m = measure(font, size);
  // Inside a 36px line box the baseline sits at half-leading + ascent.
  const baseline = (LINE - (m.asc + m.desc)) / 2 + m.asc;
  const top = TEXT_TOP + LINE - BASELINE_GAP - baseline;
  const result = { size, top: Math.round(top * 10) / 10 };
  // Only cache once the font is really loaded; before that metrics are a fallback's.
  if (document.fonts.check(`${font.weight} 20px "${font.family}"`)) metricsCache.set(key, result);
  return result;
}

/** Points along a stroke, used for hit testing (eraser). */
export function strokePoints(s: Stroke): number[] {
  if (!s.s) return s.p;
  const [x1, y1, x2, y2] = s.p;
  const segs: number[][] =
    s.s === "rect"
      ? [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]]
      : [[x1, y1, x2, y2]];
  const out: number[] = [];
  for (const [a, b, c, d] of segs) {
    const n = Math.max(1, Math.ceil(Math.hypot(c - a, d - b) / 6));
    for (let i = 0; i <= n; i++) out.push(a + ((c - a) * i) / n, b + ((d - b) * i) / n);
  }
  return out;
}

function traceFree(ctx: CanvasRenderingContext2D, p: number[]) {
  ctx.moveTo(p[0], p[1]);
  if (p.length === 2) {
    ctx.lineTo(p[0] + 0.01, p[1]);
    return;
  }
  for (let i = 2; i < p.length - 2; i += 2) {
    ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  }
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
}

function traceShape(ctx: CanvasRenderingContext2D, s: Stroke) {
  const [x1, y1, x2, y2] = s.p;
  if (s.s === "rect") {
    ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    return;
  }
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  if (s.s === "arrow") {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = 12 + s.w * 2.2;
    for (const side of [-1, 1]) {
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(ang + side * 0.5), y2 - len * Math.sin(ang + side * 0.5));
    }
  }
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], tone: Tone) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    ctx.beginPath();
    ctx.strokeStyle = s.t === "hl" ? s.c : inkFor(s.c, tone);
    ctx.lineWidth = s.w;
    ctx.globalAlpha = s.t === "hl" ? (tone === "dark" ? 0.32 : 0.42) : 1;
    if (s.s) traceShape(ctx, s);
    else traceFree(ctx, s.p);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** Snaps a shape end point: 45° steps for lines, squares for boxes. */
export function snapShape(kind: string, x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (kind === "rect") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [x1 + Math.sign(dx || 1) * d, y1 + Math.sign(dy || 1) * d];
  }
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [x1 + Math.cos(ang) * len, y1 + Math.sin(ang) * len];
}

// ---- Markdown marks on the handwriting ------------------------------------

/**
 * Format flags per character of one line. Widths never change (the textarea
 * above must line up letter for letter), so marks are shown with colour,
 * underline and background only. Markers like ** are kept but faded.
 */
export function lineFormats(line: string): string[] {
  const f: string[] = new Array(line.length).fill("");
  const add = (from: number, to: number, flag: string) => {
    for (let i = from; i < to; i++) f[i] = f[i] ? f[i] + " " + flag : flag;
  };
  const head = /^(#{1,3}) /.exec(line);
  if (head) {
    add(0, head[0].length, "m");
    add(head[0].length, line.length, "h");
  }
  const li = /^(\s*)([-*]) /.exec(line);
  if (li && !head) add(li[1].length, li[1].length + 1, "li");
  const inline: [RegExp, string, number][] = [
    [/\*\*(?=\S)(.+?)\*\*/g, "b", 2],
    [/==(?=\S)(.+?)==/g, "hl", 2],
    [/\[\[([^\]\n]+?)\]\]/g, "link", 2],
  ];
  for (const [re, flag, n] of inline) {
    for (let m = re.exec(line); m; m = re.exec(line)) {
      add(m.index, m.index + n, "m");
      add(m.index + n, m.index + m[0].length - n, flag);
      add(m.index + m[0].length - n, m.index + m[0].length, "m");
    }
  }
  return f;
}

/** The [[link]] target at a text position, if any. */
export function linkAt(text: string, pos: number): string | null {
  const start = text.lastIndexOf("[[", pos);
  if (start === -1) return null;
  const end = text.indexOf("]]", start);
  if (end === -1 || pos > end + 2) return null;
  const inner = text.slice(start + 2, end);
  if (inner.includes("\n")) return null;
  return inner.split("|")[0].trim() || null;
}

// Stable per-letter wobble: depends on the letter and its neighbour, so
// inserting text elsewhere does not make the rest of the page jump.
export function wobble(ch: string, prev: string): number {
  const n = (ch.charCodeAt(0) * 31 + (prev ? prev.charCodeAt(0) : 7) * 17) % 7;
  return (n - 3) * 0.45;
}
