// Drawing helpers shared by the notebook view and PDF export.
import { colorRuns, type ShapeKind, type Stroke } from "./format";
import { inkFor, type FontDef, type Tone } from "./settings";
import { SYMBOL_NAMES } from "./symbols";

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
/** After the user's own font changed. */
export function clearFontMetrics() {
  metricsCache.clear();
}

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

/** Corner points of a shape, in drawing order (closed shapes repeat the first). */
function shapeOutline(s: Stroke): number[] {
  const [x1, y1, x2, y2] = s.p;
  switch (s.s) {
    case "rect":
      return [x1, y1, x2, y1, x2, y2, x1, y2, x1, y1];
    case "tri":
      return [(x1 + x2) / 2, Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), Math.min(x1, x2), Math.max(y1, y2), (x1 + x2) / 2, Math.min(y1, y2)];
    case "poly":
      return [...s.p, s.p[0], s.p[1]];
    case "ellipse": {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      const out: number[] = [];
      for (let i = 0; i <= 48; i++) out.push(cx + rx * Math.cos((i / 48) * Math.PI * 2), cy + ry * Math.sin((i / 48) * Math.PI * 2));
      return out;
    }
    default:
      return [x1, y1, x2, y2];
  }
}

/** Points along a stroke, used for hit testing (eraser, lasso). */
export function strokePoints(s: Stroke): number[] {
  if (!s.s) return s.p;
  const o = shapeOutline(s);
  const out: number[] = [];
  for (let k = 0; k + 3 < o.length; k += 2) {
    const [a, b, c, d] = [o[k], o[k + 1], o[k + 2], o[k + 3]];
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
  if (s.s === "ellipse") {
    ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (s.s !== "line" && s.s !== "arrow") {
    const o = shapeOutline(s);
    ctx.moveTo(o[0], o[1]);
    for (let i = 2; i < o.length; i += 2) ctx.lineTo(o[i], o[i + 1]);
    ctx.closePath();
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

/**
 * A fountain pen: the line is thinner where the hand moved fast (points far
 * apart) and fuller where it slowed down, drawn as short overlapping segments.
 */
function drawFountain(ctx: CanvasRenderingContext2D, s: Stroke) {
  const p = s.p;
  if (p.length < 6) {
    ctx.beginPath();
    ctx.lineWidth = s.w;
    traceFree(ctx, p);
    ctx.stroke();
    return;
  }
  let width = s.w;
  let px = p[0], py = p[1];
  for (let i = 2; i < p.length; i += 2) {
    const nx = i + 2 < p.length ? (p[i] + p[i + 2]) / 2 : p[i];
    const ny = i + 2 < p.length ? (p[i + 1] + p[i + 3]) / 2 : p[i + 1];
    const speed = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    const target = s.w * Math.max(0.45, Math.min(1.45, 1.5 - speed / 14));
    width += (target - width) * 0.35;
    ctx.beginPath();
    ctx.lineWidth = width;
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(p[i], p[i + 1], nx, ny);
    ctx.stroke();
    px = nx;
    py = ny;
  }
}

/** A stylus line: each segment as wide as the pen was pressed. */
function drawPressure(ctx: CanvasRenderingContext2D, s: Stroke) {
  const p = s.p;
  const q = s.q!;
  if (p.length < 4) {
    ctx.beginPath();
    ctx.lineWidth = s.w * (0.4 + q[0] * 1.2);
    traceFree(ctx, p);
    ctx.stroke();
    return;
  }
  for (let i = 2; i < p.length; i += 2) {
    ctx.beginPath();
    ctx.lineWidth = s.w * (0.35 + ((q[i / 2 - 1] + q[i / 2]) / 2) * 1.3);
    ctx.moveTo(p[i - 2], p[i - 1]);
    ctx.lineTo(p[i], p[i + 1]);
    ctx.stroke();
  }
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, tone: Tone) {
  ctx.strokeStyle = s.t === "hl" ? s.c : inkFor(s.c, tone);
  ctx.globalAlpha = s.t === "hl" ? (tone === "dark" ? 0.32 : 0.42) : s.y === "pencil" ? 0.72 : 1;
  ctx.setLineDash(s.y === "dash" ? [s.w * 3 + 4, s.w * 2.4 + 5] : []);
  if (s.q && !s.s) {
    drawPressure(ctx, s);
    return;
  }
  if (s.y === "fountain" && !s.s) {
    drawFountain(ctx, s);
    return;
  }
  ctx.beginPath();
  ctx.lineWidth = s.y === "pencil" ? Math.max(1.2, s.w * 0.8) : s.w;
  if (s.s) traceShape(ctx, s);
  else traceFree(ctx, s.p);
  ctx.stroke();
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], tone: Tone) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) drawStroke(ctx, s, tone);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
}

/** Snaps a shape end point: 45° steps for lines, squares, circles and even triangles. */
export function snapShape(kind: string, x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (kind === "rect" || kind === "ellipse" || kind === "tri") {
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    const h = kind === "tri" ? d * 0.866 : d;
    return [x1 + Math.sign(dx || 1) * d, y1 + Math.sign(dy || 1) * h];
  }
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [x1 + Math.cos(ang) * len, y1 + Math.sin(ang) * len];
}

/** Light smoothing for a finished freehand line: removes mouse jitter, keeps the ends. */
export function smoothPoints(p: number[]): number[] {
  if (p.length < 8) return p;
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length - 2; i += 2) {
    out.push((p[i - 2] + p[i] * 2 + p[i + 2]) / 4, (p[i - 1] + p[i + 1] * 2 + p[i + 3]) / 4);
  }
  out.push(p[p.length - 2], p[p.length - 1]);
  return out.map((n) => Math.round(n * 2) / 2);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Ramer–Douglas–Peucker: the corners of a hand-drawn path. */
function simplify(p: number[], eps: number): number[] {
  if (p.length <= 4) return p;
  const [ax, ay, bx, by] = [p[0], p[1], p[p.length - 2], p[p.length - 1]];
  let best = -1, at = 0;
  for (let i = 2; i < p.length - 2; i += 2) {
    const d = distToSegment(p[i], p[i + 1], ax, ay, bx, by);
    if (d > best) [best, at] = [d, i];
  }
  if (best <= eps) return [ax, ay, bx, by];
  const left = simplify(p.slice(0, at + 2), eps);
  return [...left.slice(0, -2), ...simplify(p.slice(at), eps)];
}

/**
 * Recognises a held freehand line as a clean shape: straight line, triangle,
 * four-cornered shape or ellipse. Returns null when it looks like writing.
 */
export function recognizeShape(p: number[]): { s: ShapeKind; p: number[] } | null {
  if (p.length < 8) return null;
  const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  let length = 0;
  for (let i = 0; i < p.length; i += 2) {
    b.x1 = Math.min(b.x1, p[i]);
    b.x2 = Math.max(b.x2, p[i]);
    b.y1 = Math.min(b.y1, p[i + 1]);
    b.y2 = Math.max(b.y2, p[i + 1]);
    if (i) length += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  }
  const diag = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
  if (diag < 24) return null;
  const [sx, sy, ex, ey] = [p[0], p[1], p[p.length - 2], p[p.length - 1]];
  const gap = Math.hypot(ex - sx, ey - sy);
  if (gap > diag * 0.3) {
    // Open path: a straight line if nothing strays far from the chord.
    let worst = 0;
    for (let i = 0; i < p.length; i += 2) worst = Math.max(worst, distToSegment(p[i], p[i + 1], sx, sy, ex, ey));
    return worst < Math.max(6, gap * 0.08) && length < gap * 1.25 ? { s: "line", p: [sx, sy, ex, ey] } : null;
  }
  const closed = [...p, sx, sy];
  const corners = simplify(closed, diag * 0.09);
  const n = corners.length / 2 - 1; // the last point repeats the first
  if (n === 3 || n === 4) {
    const pts = corners.slice(0, -2).map((v) => Math.round(v * 2) / 2);
    return { s: "poly", p: pts };
  }
  return { s: "ellipse", p: [b.x1, b.y1, b.x2, b.y2].map((v) => Math.round(v * 2) / 2) };
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
  colorRuns(line).forEach((c, i) => {
    if (c === -1) add(i, i + 1, "mh");
    else if (c !== null) add(i, i + 1, "tc" + c);
  });
  const head = /^(#{1,3}) /.exec(line);
  if (head) {
    add(0, head[0].length, "m");
    add(head[0].length, line.length, "h");
  }
  const li = /^(\s*)([-*]) /.exec(line);
  const todo = /^(\s*(?:[-*] )?)\[([ xX])\] /.exec(line);
  if (li && !head && !todo) add(li[1].length, li[1].length + 1, "li");
  if (todo && !head) {
    const at = todo[1].length;
    if (todo[1].trim()) add(todo[1].length - 2, todo[1].length - 1, "m");
    const done = todo[2] !== " ";
    add(at, at + 1, done ? "cb cb0 is-done" : "cb cb0");
    add(at + 1, at + 3, "cb");
    if (done) add(at + 4, line.length, "done");
  }
  mathFormats(line, add);
  const card = line.indexOf(" :: ");
  if (card > 0 && !head) {
    add(card + 1, card + 3, "m");
    add(card + 4, line.length, "back");
  }
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

/**
 * Maths marks on a line: √(…) gets a bar over its contents, x^2 and a_1 are
 * drawn small above/below (the ^ and _ fade away), and symbols the
 * handwriting fonts lack are drawn by hand (see symbols.ts).
 */
function mathFormats(line: string, add: (from: number, to: number, flag: string) => void) {
  for (let i = 0; i < line.length; i++) {
    const name = SYMBOL_NAMES[line[i]];
    if (name) add(i, i + 1, "sym sym-" + name);
  }
  // √( … ) and √x
  for (let i = line.indexOf("√"); i !== -1; i = line.indexOf("√", i + 1)) {
    if (line[i + 1] === "(") {
      let depth = 0;
      for (let k = i + 1; k < line.length; k++) {
        if (line[k] === "(") depth++;
        else if (line[k] === ")" && --depth === 0) {
          add(i + 1, i + 2, "mh rad");
          add(i + 2, k, "rad");
          add(k, k + 1, "mh");
          break;
        }
      }
    } else {
      const m = /^[0-9A-Za-zπ.,]+/.exec(line.slice(i + 1));
      if (m) add(i + 1, i + 1 + m[0].length, "rad");
    }
  }
  // Powers and indices: x^2, x^(n+1), x^-1, a_1, a_(n)
  for (const m of line.matchAll(/(?<=[0-9A-Za-zπ)²³\]])([\^_])(\((?:[^()]|\([^()]*\))*\)|-?[0-9A-Za-zπ]+)/g)) {
    const at = m.index!;
    const kind = m[1] === "^" ? "sup" : "sub";
    // snake_case words stay words: an index is a number, one letter or (…).
    if (kind === "sub" && /^[A-Za-z]{2,}/.test(m[2])) continue;
    add(at, at + 1, "mh");
    let from = at + 1;
    let to = at + 1 + m[2].length;
    if (m[2].startsWith("(")) {
      add(from, from + 1, "mh");
      add(to - 1, to, "mh");
      from++;
      to--;
    }
    add(from, to, kind);
  }
}

/** Range of the "[ ]" checkbox on the line holding `pos`, when the click is on it. */
export function checkboxAt(text: string, pos: number): number | null {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const m = /^(\s*(?:[-*] )?)\[([ xX])\] /.exec(text.slice(start));
  if (!m) return null;
  const at = start + m[1].length;
  return pos >= at && pos <= at + 3 ? at : null;
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
