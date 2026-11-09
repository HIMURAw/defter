import { Notice, TextFileView, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  emptyNotebook,
  emptyPage,
  parseNotebook,
  serializeNotebook,
  type Notebook,
  type Page,
  type Stroke,
  type StrokeKind,
} from "./format";

export const VIEW_TYPE = "defter-view";

// Logical page size. Everything is stored in these units, so a page looks the
// same at any pane width.
const W = 820;
const H = 1160;
const PEN_COLORS = ["#1d3a8f", "#1b1b1f", "#c42b2b", "#1f7a4d"];
const HL_COLORS = ["#ffe14d", "#ff9ec7", "#8ee88e", "#ffb45c"];
const PEN_WIDTHS = [2, 3.5, 6];
const HL_WIDTH = 24;
const ERASER_RADIUS = 14;
const UNDO_LIMIT = 100;
// Above this many inserted characters (a paste) nothing is animated.
const ANIMATE_LIMIT = 40;

type Tool = "write" | "pen" | "hl" | "erase";

interface HistoryEntry {
  page: number;
  ink: Stroke[];
}

// Stable per-letter wobble: depends on the letter and its neighbour, so
// inserting text elsewhere does not make the rest of the page jump.
function wobble(ch: string, prev: string): number {
  const n = (ch.charCodeAt(0) * 31 + (prev ? prev.charCodeAt(0) : 7) * 17) % 7;
  return (n - 3) * 0.45;
}

function traceStroke(ctx: CanvasRenderingContext2D, p: number[]) {
  ctx.beginPath();
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

export interface DefterHost {
  openAsMarkdown(leaf: WorkspaceLeaf): void;
}

export class DefterView extends TextFileView {
  private nb: Notebook = emptyNotebook();
  private pageIndex = 0;
  private rawBroken: string | null = null;
  private tool: Tool = "write";
  private penColor = PEN_COLORS[0];
  private hlColor = HL_COLORS[0];
  private penWidth = PEN_WIDTHS[1];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private spans: HTMLSpanElement[] = [];
  private prevText = "";
  private stroke: Stroke | null = null;
  private erasing: { x: number; y: number; changed: boolean } | null = null;
  private drawQueued = false;
  private toolButtons: Partial<Record<Tool, HTMLElement>> = {};

  private errorEl!: HTMLElement;
  private deskEl!: HTMLElement;
  private holderEl!: HTMLElement;
  private sheetEl!: HTMLElement;
  private hlCanvas!: HTMLCanvasElement;
  private inkCanvas!: HTMLCanvasElement;
  private mirrorEl!: HTMLElement;
  private textEl!: HTMLTextAreaElement;
  private pageNoEl!: HTMLElement;
  private counterEl!: HTMLElement;
  private swatchesEl!: HTMLElement;
  private widthsEl!: HTMLElement;
  private built = false;

  private host: DefterHost;

  constructor(leaf: WorkspaceLeaf, host: DefterHost) {
    super(leaf);
    this.host = host;
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getIcon() {
    return "notebook-pen";
  }
  getDisplayText() {
    return this.file ? this.file.basename : "Notebook";
  }

  async onOpen() {
    this.addAction("file-text", "Open as Markdown", () => this.host.openAsMarkdown(this.leaf));
    this.ensureUi();
  }

  getViewData() {
    // A file we could not read is handed back untouched, never overwritten.
    if (this.rawBroken !== null) return this.rawBroken;
    return serializeNotebook(this.nb);
  }

  setViewData(data: string, clear: boolean) {
    this.ensureUi();
    try {
      this.nb = parseNotebook(data);
      this.rawBroken = null;
      this.errorEl.toggle(false);
      this.deskEl.toggle(true);
    } catch (e) {
      this.rawBroken = data;
      this.errorEl.setText(
        "This notebook could not be read, so it was left unchanged. Use “Open as Markdown” to look at the file. " +
          ((e as Error).message || "")
      );
      this.errorEl.toggle(true);
      this.deskEl.toggle(false);
      return;
    }
    if (clear) {
      this.undoStack = [];
      this.redoStack = [];
      this.pageIndex = 0;
    }
    this.pageIndex = Math.min(this.pageIndex, this.nb.pages.length - 1);
    this.showPage(this.pageIndex);
  }

  clear() {
    this.nb = emptyNotebook();
    this.rawBroken = null;
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
  }

  private get page(): Page {
    return this.nb.pages[this.pageIndex];
  }

  // ---- UI -----------------------------------------------------------------

  private ensureUi() {
    if (this.built) return;
    this.built = true;
    const root = this.contentEl;
    root.empty();
    root.addClass("defter-root");
    this.errorEl = root.createDiv("defter-error");
    this.errorEl.toggle(false);
    this.buildToolbar(root);

    this.deskEl = root.createDiv("defter-desk");
    this.holderEl = this.deskEl.createDiv("defter-holder");
    this.sheetEl = this.holderEl.createDiv("defter-sheet");

    this.hlCanvas = this.sheetEl.createEl("canvas", { cls: "defter-layer defter-hl" });
    this.mirrorEl = this.sheetEl.createDiv("defter-text defter-mirror");
    this.inkCanvas = this.sheetEl.createEl("canvas", { cls: "defter-layer defter-ink" });
    this.textEl = this.sheetEl.createEl("textarea", { cls: "defter-text defter-input" });
    this.textEl.spellcheck = false;
    this.textEl.setAttr("aria-label", "Page text");
    this.pageNoEl = this.sheetEl.createDiv("defter-pageno");

    for (const c of [this.hlCanvas, this.inkCanvas]) {
      c.width = W * 2;
      c.height = H * 2;
      c.getContext("2d")!.setTransform(2, 0, 0, 2, 0, 0);
    }

    this.registerDomEvent(this.textEl, "input", () => this.onTextInput());
    this.registerDomEvent(this.inkCanvas, "pointerdown", (e) => this.onPointerDown(e));
    this.registerDomEvent(this.inkCanvas, "pointermove", (e) => this.onPointerMove(e));
    this.registerDomEvent(this.inkCanvas, "pointerup", () => this.onPointerUp());
    this.registerDomEvent(this.inkCanvas, "pointercancel", () => this.onPointerUp());
    this.registerDomEvent(root, "keydown", (e) => this.onKeyDown(e));

    const ro = new ResizeObserver(() => this.fitToPane());
    ro.observe(this.deskEl);
    this.register(() => ro.disconnect());
    this.setTool("write");
  }

  private buildToolbar(root: HTMLElement) {
    const bar = root.createDiv("defter-bar");
    const button = (parent: HTMLElement, icon: string, title: string, fn: () => void) => {
      const b = parent.createEl("button", { cls: "defter-btn clickable-icon" });
      b.setAttr("aria-label", title);
      setIcon(b, icon);
      this.registerDomEvent(b, "click", fn);
      return b;
    };

    const tools = bar.createDiv("defter-group");
    const defs: [Tool, string, string][] = [
      ["write", "type", "Write (Alt+1)"],
      ["pen", "pen-line", "Pen (Alt+2)"],
      ["hl", "highlighter", "Highlighter (Alt+3)"],
      ["erase", "eraser", "Eraser (Alt+4)"],
    ];
    for (const [id, icon, title] of defs) this.toolButtons[id] = button(tools, icon, title, () => this.setTool(id));

    this.swatchesEl = bar.createDiv("defter-group");
    this.widthsEl = bar.createDiv("defter-group");

    const history = bar.createDiv("defter-group");
    button(history, "undo-2", "Undo drawing (Ctrl+Z)", () => this.undo());
    button(history, "redo-2", "Redo drawing (Ctrl+Y)", () => this.redo());

    const nav = bar.createDiv("defter-group defter-nav");
    button(nav, "chevron-left", "Previous page (Page Up)", () => this.goTo(this.pageIndex - 1));
    this.counterEl = nav.createSpan("defter-counter");
    button(nav, "chevron-right", "Next page (Page Down)", () => this.goTo(this.pageIndex + 1));
    button(nav, "file-plus", "New page after this one", () => this.addPage());
    button(nav, "file-minus", "Remove this page (only when empty)", () => this.removePage());
  }

  private renderSwatches() {
    this.swatchesEl.empty();
    this.widthsEl.empty();
    const drawing = this.tool === "pen" || this.tool === "hl";
    this.swatchesEl.toggle(drawing);
    this.widthsEl.toggle(this.tool === "pen");
    if (!drawing) return;
    const colors = this.tool === "pen" ? PEN_COLORS : HL_COLORS;
    const current = this.tool === "pen" ? this.penColor : this.hlColor;
    colors.forEach((c, i) => {
      const b = this.swatchesEl.createEl("button", { cls: "defter-swatch" });
      b.style.setProperty("--swatch", c);
      b.setAttr("aria-label", "Color " + (i + 1));
      b.toggleClass("is-active", c === current);
      b.onclick = () => {
        if (this.tool === "pen") this.penColor = c;
        else this.hlColor = c;
        this.renderSwatches();
      };
    });
    PEN_WIDTHS.forEach((w, i) => {
      const b = this.widthsEl.createEl("button", { cls: "defter-width" });
      b.style.setProperty("--dot", w * 2 + "px");
      b.setAttr("aria-label", ["Fine", "Medium", "Bold"][i]);
      b.toggleClass("is-active", w === this.penWidth);
      b.onclick = () => {
        this.penWidth = w;
        this.renderSwatches();
      };
    });
  }

  private setTool(tool: Tool) {
    this.tool = tool;
    for (const id of Object.keys(this.toolButtons) as Tool[]) this.toolButtons[id]!.toggleClass("is-active", id === tool);
    this.sheetEl.dataset.tool = tool;
    this.renderSwatches();
    if (tool === "write") this.textEl.focus({ preventScroll: true });
    else this.textEl.blur();
  }

  private fitToPane() {
    const avail = this.deskEl.clientWidth - 48;
    if (avail <= 0) return;
    const s = Math.min(1.35, Math.max(0.45, avail / W));
    this.sheetEl.style.transform = `scale(${s})`;
    this.holderEl.style.width = W * s + "px";
    this.holderEl.style.height = H * s + "px";
  }

  // ---- Pages --------------------------------------------------------------

  private showPage(i: number, direction?: number) {
    this.finishStroke();
    this.pageIndex = i;
    const text = this.page.text;
    this.textEl.value = text;
    this.prevText = text;
    this.textEl.placeholder = i === 0 && this.nb.pages.length === 1 ? "Start writing…" : "";
    this.mirrorEl.empty();
    this.spans = [];
    this.spliceSpans(0, 0, text, false);
    this.redrawInk();
    this.counterEl.setText(`${i + 1} / ${this.nb.pages.length}`);
    this.pageNoEl.setText(String(i + 1));
    if (direction) {
      this.sheetEl.removeClass("flip-next", "flip-prev");
      void this.sheetEl.offsetWidth;
      this.sheetEl.addClass(direction > 0 ? "flip-next" : "flip-prev");
    }
  }

  private goTo(i: number) {
    if (i < 0 || i >= this.nb.pages.length || i === this.pageIndex) return;
    this.showPage(i, i > this.pageIndex ? 1 : -1);
    if (this.tool === "write") {
      this.textEl.focus({ preventScroll: true });
      this.textEl.setSelectionRange(this.textEl.value.length, this.textEl.value.length);
      this.fitText();
    }
    this.deskEl.scrollTop = 0;
  }

  private addPage() {
    this.nb.pages.splice(this.pageIndex + 1, 0, emptyPage());
    this.requestSave();
    this.goTo(this.pageIndex + 1);
  }

  private removePage() {
    if (this.page.text.trim() || this.page.ink.length) {
      new Notice("Clear the page before removing it.");
      return;
    }
    if (this.nb.pages.length === 1) return;
    this.nb.pages.splice(this.pageIndex, 1);
    this.undoStack = [];
    this.redoStack = [];
    this.requestSave();
    this.showPage(Math.min(this.pageIndex, this.nb.pages.length - 1), -1);
  }

  // ---- Handwriting --------------------------------------------------------

  // Replaces [from, from + removeCount) of the rendered text. Untouched letters
  // keep their DOM nodes, so a letter still being written is not interrupted.
  private spliceSpans(from: number, removeCount: number, inserted: string, animate: boolean) {
    for (const el of this.spans.splice(from, removeCount)) el.remove();
    const before = this.spans[from] ?? null;
    const full = this.textEl.value;
    const made: HTMLSpanElement[] = [];
    for (let k = 0; k < inserted.length; k++) {
      const ch = inserted[k];
      const el = document.createElement("span");
      el.textContent = ch;
      el.style.top = wobble(ch, from + k > 0 ? full[from + k - 1] : "") + "px";
      if (animate && ch.trim()) {
        el.className = "defter-ch-new";
        if (inserted.length > 1) el.style.animationDelay = k * 18 + "ms";
        el.addEventListener("animationend", () => el.removeAttribute("class"), { once: true });
      }
      this.mirrorEl.insertBefore(el, before);
      made.push(el);
    }
    this.spans.splice(from, 0, ...made);
  }

  private syncMirror(animate: boolean) {
    const next = this.textEl.value;
    const prev = this.prevText;
    if (next === prev) return;
    let a = 0;
    const minLen = Math.min(next.length, prev.length);
    while (a < minLen && next[a] === prev[a]) a++;
    let b = 0;
    while (b < minLen - a && next[next.length - 1 - b] === prev[prev.length - 1 - b]) b++;
    const inserted = next.slice(a, next.length - b);
    this.spliceSpans(a, prev.length - a - b, inserted, animate && inserted.length <= ANIMATE_LIMIT);
    this.prevText = next;
    this.page.text = next;
  }

  private onTextInput() {
    this.syncMirror(true);
    this.fitText();
    this.requestSave();
  }

  private fits(value: string) {
    this.textEl.value = value;
    return this.textEl.scrollHeight <= this.textEl.clientHeight;
  }

  // When the page is full the overflow continues on the next page, like
  // turning the page and carrying on. Writing follows only if the caret did.
  private fitText() {
    const ta = this.textEl;
    if (ta.scrollHeight <= ta.clientHeight) return;
    const full = ta.value;
    const caret = ta.selectionStart;
    let lo = 0;
    let hi = full.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.fits(full.slice(0, mid))) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    const boundary = Math.max(full.lastIndexOf(" ", cut), full.lastIndexOf("\n", cut));
    if (boundary > 0 && cut - boundary < 24 && cut < full.length) cut = boundary + 1;

    ta.value = full.slice(0, cut).replace(/\n$/, "");
    const rest = full.slice(cut);
    this.syncMirror(false);

    if (this.pageIndex === this.nb.pages.length - 1) this.nb.pages.push(emptyPage());
    const next = this.nb.pages[this.pageIndex + 1];
    next.text = next.text ? rest + "\n" + next.text : rest;
    this.counterEl.setText(`${this.pageIndex + 1} / ${this.nb.pages.length}`);
    this.requestSave();

    if (caret >= cut) {
      this.showPage(this.pageIndex + 1, 1);
      const pos = Math.min(caret - cut, ta.value.length);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(pos, pos);
      this.deskEl.scrollTop = 0;
      this.fitText();
    } else {
      ta.setSelectionRange(caret, caret);
    }
  }

  // ---- Ink ----------------------------------------------------------------

  private point(e: PointerEvent): [number, number] {
    const r = this.inkCanvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * W * 2) / 2,
      Math.round(((e.clientY - r.top) / r.height) * H * 2) / 2,
    ];
  }

  private redrawLayer(kind: StrokeKind) {
    const canvas = kind === "hl" ? this.hlCanvas : this.inkCanvas;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const strokes = this.page.ink.filter((s) => s.t === kind);
    if (this.stroke && this.stroke.t === kind) strokes.push(this.stroke);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.w;
      ctx.globalAlpha = s.t === "hl" ? 0.42 : 1;
      traceStroke(ctx, s.p);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private redrawInk() {
    this.redrawLayer("hl");
    this.redrawLayer("pen");
  }

  private snapshot() {
    this.undoStack.push({ page: this.pageIndex, ink: this.page.ink.slice() });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private applyHistory(from: HistoryEntry[], to: HistoryEntry[]) {
    const entry = from.pop();
    if (!entry || !this.nb.pages[entry.page]) return;
    to.push({ page: entry.page, ink: this.nb.pages[entry.page].ink.slice() });
    this.nb.pages[entry.page].ink = entry.ink;
    if (entry.page !== this.pageIndex) this.showPage(entry.page);
    else this.redrawInk();
    this.requestSave();
  }

  private undo() {
    this.applyHistory(this.undoStack, this.redoStack);
  }
  private redo() {
    this.applyHistory(this.redoStack, this.undoStack);
  }

  private onPointerDown(e: PointerEvent) {
    if (this.tool === "write" || e.button !== 0) return;
    e.preventDefault();
    this.inkCanvas.setPointerCapture(e.pointerId);
    const [x, y] = this.point(e);
    this.snapshot();
    if (this.tool === "erase") {
      this.erasing = { x, y, changed: false };
      this.eraseAlong(x, y);
      return;
    }
    const hl = this.tool === "hl";
    this.stroke = { t: hl ? "hl" : "pen", c: hl ? this.hlColor : this.penColor, w: hl ? HL_WIDTH : this.penWidth, p: [x, y] };
    this.queueDraw();
  }

  private onPointerMove(e: PointerEvent) {
    if (this.erasing) {
      const [x, y] = this.point(e);
      this.eraseAlong(x, y);
      return;
    }
    if (!this.stroke) return;
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const p = this.stroke.p;
    for (const ev of coalesced.length ? coalesced : [e]) {
      const [x, y] = this.point(ev);
      const dx = x - p[p.length - 2];
      const dy = y - p[p.length - 1];
      if (dx * dx + dy * dy >= 2.25) p.push(x, y);
    }
    this.queueDraw();
  }

  private queueDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (this.stroke) this.redrawLayer(this.stroke.t);
    });
  }

  private onPointerUp() {
    if (this.erasing) {
      if (!this.erasing.changed) this.undoStack.pop();
      this.erasing = null;
      return;
    }
    this.finishStroke();
  }

  private finishStroke() {
    if (!this.stroke) return;
    const s = this.stroke;
    this.stroke = null;
    this.page.ink.push(s);
    this.redrawLayer(s.t);
    this.requestSave();
  }

  // Walks from the last eraser position so a fast swipe does not skip strokes.
  private eraseAlong(x: number, y: number) {
    const er = this.erasing!;
    const steps = Math.max(1, Math.ceil(Math.hypot(x - er.x, y - er.y) / (ERASER_RADIUS / 2)));
    const r2 = ERASER_RADIUS * ERASER_RADIUS;
    const hit = (s: Stroke) => {
      for (let n = 0; n <= steps; n++) {
        const ex = er.x + ((x - er.x) * n) / steps;
        const ey = er.y + ((y - er.y) * n) / steps;
        for (let i = 0; i < s.p.length; i += 2) {
          const dx = s.p[i] - ex;
          const dy = s.p[i + 1] - ey;
          if (dx * dx + dy * dy <= r2) return true;
        }
      }
      return false;
    };
    const kept = this.page.ink.filter((s) => !hit(s));
    er.x = x;
    er.y = y;
    if (kept.length === this.page.ink.length) return;
    this.page.ink = kept;
    er.changed = true;
    this.redrawInk();
    this.requestSave();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.altKey && ["1", "2", "3", "4"].includes(e.key)) {
      e.preventDefault();
      this.setTool((["write", "pen", "hl", "erase"] as Tool[])[Number(e.key) - 1]);
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      this.goTo(this.pageIndex + (e.key === "PageDown" ? 1 : -1));
      return;
    }
    if (e.key === "Escape" && this.tool !== "write") {
      this.setTool("write");
      return;
    }
    // In write mode Ctrl+Z belongs to the text field's own undo.
    if (this.tool !== "write" && (e.ctrlKey || e.metaKey)) {
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        this.redo();
      }
    }
  }
}
