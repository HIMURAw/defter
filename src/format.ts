// The notebook file format. Pure functions, no Obsidian imports, so it can be
// tested with plain Node.
//
//   ---
//   defter-plugin: notebook
//   ---
//
//   <!-- defter:page -->
//   Text of page one, plain and searchable.
//
//   <!-- defter:page -->
//   Text of page two.
//
//   <!-- defter:ink
//   {"v":1,"pages":[[...strokes of page one...],[...]]}
//   -->

export const FRONTMATTER_KEY = "defter-plugin";
export const PAGE_MARKER = "<!-- defter:page -->";
const INK_OPEN = "<!-- defter:ink";
const INK_CLOSE = "-->";
const ESCAPE = "​";

export type StrokeKind = "pen" | "hl";
export type ShapeKind = "line" | "arrow" | "rect";
const SHAPES: ShapeKind[] = ["line", "arrow", "rect"];

export interface Stroke {
  t: StrokeKind;
  c: string;
  w: number;
  /** Freehand: x,y pairs. Shape: start and end point (4 numbers). */
  p: number[];
  s?: ShapeKind;
}

export interface Page {
  text: string;
  ink: Stroke[];
}

export interface Notebook {
  /** Frontmatter lines without the --- fences. Other keys (tags, aliases) are kept. */
  frontmatter: string;
  /** Anything written before the first page marker; kept so nothing is lost. */
  preface: string;
  pages: Page[];
}

export class NotebookFormatError extends Error {}

export const emptyPage = (): Page => ({ text: "", ink: [] });

export function emptyNotebook(): Notebook {
  return { frontmatter: `${FRONTMATTER_KEY}: notebook`, preface: "", pages: [emptyPage()] };
}

function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  if (!md.startsWith("---\n")) return { frontmatter: null, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: md };
  const after = md.indexOf("\n", end + 4);
  const fenceLine = md.slice(end + 1, after === -1 ? md.length : after);
  if (fenceLine.trim() !== "---") return { frontmatter: null, body: md };
  return {
    frontmatter: md.slice(4, end),
    body: after === -1 ? "" : md.slice(after + 1),
  };
}

export function isNotebookText(md: string): boolean {
  const { frontmatter } = splitFrontmatter(md.replace(/\r\n/g, "\n"));
  return frontmatter !== null && new RegExp(`^${FRONTMATTER_KEY}:\\s*notebook\\s*$`, "m").test(frontmatter);
}

function isStroke(s: unknown): s is Stroke {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  if (o.s !== undefined && !(SHAPES.includes(o.s as ShapeKind) && Array.isArray(o.p) && o.p.length === 4)) return false;
  return (
    (o.t === "pen" || o.t === "hl") &&
    typeof o.c === "string" &&
    typeof o.w === "number" &&
    Array.isArray(o.p) &&
    o.p.length >= 2 &&
    o.p.length % 2 === 0 &&
    o.p.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function parseInk(json: string): Stroke[][] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new NotebookFormatError("The drawing block is not valid JSON.");
  }
  const pages = (data as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) throw new NotebookFormatError("The drawing block has no pages list.");
  return pages.map((list) => (Array.isArray(list) ? list.filter(isStroke) : []));
}

const escapeText = (t: string) => t.replace(/^<!-- defter:/gm, `<!-- defter${ESCAPE}:`);
const unescapeText = (t: string) => t.replace(new RegExp(`^<!-- defter${ESCAPE}:`, "gm"), "<!-- defter:");

export function parseNotebook(source: string): Notebook {
  const md = source.replace(/\r\n/g, "\n");
  const { frontmatter, body: rawBody } = splitFrontmatter(md);
  let body = rawBody;

  let inkPages: Stroke[][] = [];
  const inkStart = body.lastIndexOf("\n" + INK_OPEN);
  const inkAtTop = body.startsWith(INK_OPEN) ? 0 : -1;
  const start = inkStart !== -1 ? inkStart + 1 : inkAtTop;
  if (start !== -1) {
    const close = body.indexOf("\n" + INK_CLOSE, start);
    if (close === -1) throw new NotebookFormatError("The drawing block is not closed.");
    inkPages = parseInk(body.slice(start + INK_OPEN.length, close));
    const tail = body.slice(close + 1 + INK_CLOSE.length);
    if (tail.trim()) throw new NotebookFormatError("Unexpected text after the drawing block.");
    body = body.slice(0, start);
  }

  const chunks = body.split(/^<!-- defter:page -->[ \t]*$/m);
  let preface = "";
  let texts: string[];
  if (chunks.length === 1) {
    // A note that was turned into a notebook: its text becomes page one.
    texts = [chunks[0].replace(/^\n+/, "").replace(/\n+$/, "")];
  } else {
    preface = chunks[0].replace(/^\n+/, "").replace(/\n+$/, "");
    texts = chunks.slice(1).map((c) => {
      let t = c.startsWith("\n") ? c.slice(1) : c;
      if (t.endsWith("\n\n")) t = t.slice(0, -2);
      else if (t.endsWith("\n")) t = t.slice(0, -1);
      return unescapeText(t);
    });
  }

  const count = Math.max(texts.length, inkPages.length, 1);
  const pages: Page[] = [];
  for (let i = 0; i < count; i++) pages.push({ text: texts[i] ?? "", ink: inkPages[i] ?? [] });

  let fm = frontmatter ?? "";
  if (!new RegExp(`^${FRONTMATTER_KEY}:`, "m").test(fm)) fm = fm ? `${FRONTMATTER_KEY}: notebook\n${fm}` : `${FRONTMATTER_KEY}: notebook`;
  return { frontmatter: fm, preface, pages };
}

export function serializeNotebook(nb: Notebook): string {
  let out = `---\n${nb.frontmatter}\n---\n\n`;
  if (nb.preface) out += nb.preface + "\n\n";
  for (const p of nb.pages) out += `${PAGE_MARKER}\n${escapeText(p.text)}\n\n`;
  if (nb.pages.some((p) => p.ink.length)) {
    const lines = nb.pages.map((p) => JSON.stringify(p.ink));
    out += `${INK_OPEN}\n{"v":1,"pages":[\n${lines.join(",\n")}\n]}\n${INK_CLOSE}\n`;
  }
  return out;
}

// Simple `key: value` frontmatter properties. Only single-line scalar values are
// handled; every other line is left exactly as it was.
function propRegex(key: string) {
  return new RegExp(`^${key.replace(/[-]/g, "\\-")}:[ \\t]*(.*)$`, "m");
}

export function getProp(frontmatter: string, key: string): string | null {
  const m = propRegex(key).exec(frontmatter);
  if (!m) return null;
  const v = m[1].trim();
  return v.replace(/^(["'])(.*)\1$/, "$2") || null;
}

export function setProp(frontmatter: string, key: string, value: string | null): string {
  const re = propRegex(key);
  if (value === null) return frontmatter.replace(new RegExp(re.source + "\\n?", "m"), "").replace(/\n$/, "");
  const safe = /^[\w#.\- ]*$/.test(value) && !value.startsWith("#") ? value : JSON.stringify(value);
  const line = `${key}: ${safe}`;
  if (re.test(frontmatter)) return frontmatter.replace(re, line);
  return frontmatter ? `${frontmatter}\n${line}` : line;
}

/** Text of the page shown in lists: first heading or first non-empty line. */
export function pageTitle(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,3} /.test(l));
  return (heading ?? lines[0] ?? "").replace(/^#{1,3} /, "").replace(/\*\*|==|\[\[|\]\]/g, "");
}

/** Converts the JSON prototype format (.defter files) to a notebook. */
export function fromLegacy(json: string): Notebook {
  let data: unknown;
  try {
    data = JSON.parse(json || '{"pages":[]}');
  } catch {
    throw new NotebookFormatError("Old notebook file is not valid JSON.");
  }
  const pages = (data as { pages?: unknown })?.pages;
  if (!Array.isArray(pages)) throw new NotebookFormatError("Old notebook file has no pages.");
  const nb = emptyNotebook();
  nb.pages = pages.map((p) => ({
    text: typeof p?.text === "string" ? p.text : "",
    ink: Array.isArray(p?.ink) ? p.ink.filter(isStroke) : [],
  }));
  if (!nb.pages.length) nb.pages.push(emptyPage());
  return nb;
}
