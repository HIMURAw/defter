import { Menu, Notice, TextFileView, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  emptyNotebook,
  emptyPage,
  pageTitle,
  parseNotebook,
  serializeNotebook,
  setProp,
  type Notebook,
  type Page,
  type ShapeKind,
  type Stroke,
  type StrokeKind,
} from "./format";
import { applyDims, pageDims, drawStrokes, fontMetrics, lineFormats, linkAt, snapShape, strokePoints, wobble } from "./render";
import type { PageDims } from "./render";
import { ANIM, HIGHLIGHTS, INKS, inkFor, resolveLook, type DefterSettings, type NotebookLook } from "./settings";
import { NotebookSettingsModal } from "./notebook-settings";

export const VIEW_TYPE = "defter-view";

const PEN_WIDTHS = [2, 3.5, 6];
const HL_WIDTH = 24;
const ERASER_RADIUS = 14;
const UNDO_LIMIT = 100;
// Above this many inserted characters (a paste) nothing is animated.
const ANIMATE_LIMIT = 40;

type Tool = "write" | "pen" | "hl" | "shape" | "erase";

const SHAPE_DEFS: { id: ShapeKind; label: string; icon: string }[] = [
  { id: "line", label: "Line", icon: "minus" },
  { id: "arrow", label: "Arrow", icon: "move-up-right" },
  { id: "rect", label: "Box", icon: "square" },
];

interface HistoryEntry {
  page: number;
  ink: Stroke[];
}

export interface DefterHost {
  settings: DefterSettings;
  openAsMarkdown(leaf: WorkspaceLeaf): void;
  rememberPage(path: string, page: number): void;
  exportPdf(title: string, nb: Notebook, look: NotebookLook): Promise<void>;
}

export class DefterView extends TextFileView {
  nb: Notebook = emptyNotebook();
  look!: NotebookLook;
  private dims: PageDims = pageDims("a4");
  private host: DefterHost;
  private pageIndex = 0;
  private rawBroken: string | null = null;
  private tool: Tool = "write";
  private shapeKind: ShapeKind = "line";
  private penColor = INKS[0].id;
  private hlColor = HIGHLIGHTS[0];
  private penWidth = PEN_WIDTHS[1];
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private spans: HTMLSpanElement[] = [];
  private prevText = "";
  private stroke: Stroke | null = null;
  private erasing: { x: number; y: number; changed: boolean } | null = null;
  private drawQueued = false;
  private toolButtons: Partial<Record<Tool, HTMLElement>> = {};
  private built = false;

  private errorEl!: HTMLElement;
  private deskEl!: HTMLElement;
  private holderEl!: HTMLElement;
  private sheetEl!: HTMLElement;
  private hlCanvas!: HTMLCanvasElement;
  private inkCanvas!: HTMLCanvasElement;
  private mirrorEl!: HTMLElement;
  private textEl!: HTMLTextAreaElement;
  private pageNoEl!: HTMLElement;
  private dockEl!: HTMLElement;
  private swatchesEl!: HTMLElement;
  private widthsEl!: HTMLElement;
  private counterEl!: HTMLElement;
  private chipEl: HTMLElement | null = null;
  private drawerEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;

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
    this.addAction("sliders-horizontal", "Notebook settings", () => this.openSettings());
    this.addAction("list", "Pages", () => this.toggleDrawer(false));
    this.addAction("search", "Search this notebook", () => this.toggleDrawer(true));
    const actions = (this as unknown as { actionsEl?: HTMLElement }).actionsEl;
    if (actions) {
      this.chipEl = createDiv({ cls: "defter-chip clickable-icon", attr: { "aria-label": "Pages" } });
      actions.prepend(this.chipEl);
      this.registerDomEvent(this.chipEl, "click", () => this.toggleDrawer(false));
    }
    this.ensureUi();
  }

  onPaneMenu(menu: Menu, source: string) {
    if (source === "more-options" || source === "tab-header") {
      menu.addItem((i) => i.setSection("action").setTitle("Notebook settings").setIcon("sliders-horizontal").onClick(() => this.openSettings()));
      menu.addItem((i) => i.setSection("action").setTitle("Add page after this one").setIcon("file-plus").onClick(() => this.addPage()));
      menu.addItem((i) => i.setSection("action").setTitle("Remove this page").setIcon("file-minus").onClick(() => this.removePage(this.pageIndex)));
      menu.addItem((i) => i.setSection("action").setTitle("Export to PDF").setIcon("file-output").onClick(() => this.exportPdf()));
      menu.addItem((i) => i.setSection("action").setTitle("Open as Markdown").setIcon("file-text").onClick(() => this.host.openAsMarkdown(this.leaf)));
    }
    super.onPaneMenu(menu, source);
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
      this.dockEl.toggle(true);
    } catch (e) {
      this.rawBroken = data;
      this.errorEl.setText(
        "This notebook could not be read, so it was left unchanged. Use “Open as Markdown” to look at the file. " +
          ((e as Error).message || "")
      );
      this.errorEl.toggle(true);
      this.deskEl.toggle(false);
      this.dockEl.toggle(false);
      return;
    }
    if (clear) {
      this.undoStack = [];
      this.redoStack = [];
      this.pageIndex = (this.file && this.host.settings.lastPage[this.file.path]) || 0;
    }
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, this.nb.pages.length - 1));
    this.applyLook();
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

  // ---- Look (paper, font, ink) ---------------------------------------------

  /** Applies frontmatter + defaults to the page and redraws everything. */
  applyLook() {
    this.look = resolveLook(this.nb.frontmatter, this.file?.basename ?? "", this.host.settings);
    const { paper, tone, font, scale, ink } = this.look;
    this.dims = pageDims(this.look.page);
    applyDims(this.sheetEl, this.dims);
    this.sizeCanvases();
    this.fitToPane();
    this.sheetEl.dataset.paper = paper;
    this.sheetEl.dataset.tone = tone;
    const apply = () => {
      const m = fontMetrics(font, scale);
      const st = this.sheetEl.style;
      st.setProperty("--defter-family", `"${font.family}"`);
      st.setProperty("--defter-weight", String(font.weight));
      st.setProperty("--defter-size", m.size + "px");
      st.setProperty("--defter-top", m.top + "px");
      st.setProperty("--defter-ink", inkFor(ink, tone));
      st.setProperty("--defter-anim", ANIM[this.host.settings.anim] + "ms");
    };
    apply();
    this.showPage(this.pageIndex);
    if (!document.fonts.check(`${font.weight} 20px "${font.family}"`)) {
      void document.fonts.load(`${font.weight} 20px "${font.family}"`).then(() => {
        apply();
        this.showPage(this.pageIndex);
      });
    }
  }

  /** Writes one look property to the frontmatter and saves. */
  setLook(key: string, value: string | null) {
    this.nb.frontmatter = setProp(this.nb.frontmatter, key, value);
    this.requestSave();
    this.applyLook();
  }

  private openSettings() {
    new NotebookSettingsModal(this.app, this).open();
  }

  private async exportPdf() {
    this.finishStroke();
    await this.host.exportPdf(this.getDisplayText(), this.nb, this.look);
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

    this.deskEl = root.createDiv("defter-desk");
    this.holderEl = this.deskEl.createDiv("defter-holder");
    this.sheetEl = this.holderEl.createDiv("defter-sheet");

    this.hlCanvas = this.sheetEl.createEl("canvas", { cls: "defter-layer defter-hl" });
    this.mirrorEl = this.sheetEl.createDiv("defter-text defter-mirror");
    this.inkCanvas = this.sheetEl.createEl("canvas", { cls: "defter-layer defter-ink" });
    this.textEl = this.sheetEl.createEl("textarea", { cls: "defter-text defter-input" });
    this.textEl.spellcheck = false;
    this.pageNoEl = this.sheetEl.createDiv("defter-pageno");

    this.sizeCanvases();

    this.buildDock(root);
    this.buildDrawer(root);

    this.registerDomEvent(this.textEl, "input", () => this.onTextInput());
    this.registerDomEvent(this.textEl, "click", (e) => this.onTextClick(e));
    this.registerDomEvent(this.inkCanvas, "pointerdown", (e) => this.onPointerDown(e));
    this.registerDomEvent(this.inkCanvas, "pointermove", (e) => this.onPointerMove(e));
    this.registerDomEvent(this.inkCanvas, "pointerup", () => this.onPointerUp());
    this.registerDomEvent(this.inkCanvas, "pointercancel", () => this.onPointerUp());
    this.registerDomEvent(root, "keydown", (e) => this.onKeyDown(e));

    // Resizing in the next frame avoids a ResizeObserver feedback loop warning.
    const ro = new ResizeObserver(() => requestAnimationFrame(() => this.fitToPane()));
    ro.observe(this.deskEl);
    this.register(() => ro.disconnect());
    this.look = resolveLook("", "", this.host.settings);
    this.setTool("write");
  }

  private iconButton(parent: HTMLElement, icon: string, title: string, fn: (e: MouseEvent) => void, cls = "") {
    const b = parent.createEl("button", { cls: "defter-btn clickable-icon " + cls });
    b.setAttr("aria-label", title);
    b.setAttr("data-tooltip-position", "top");
    setIcon(b, icon);
    this.registerDomEvent(b, "click", fn);
    return b;
  }

  // The pencil case: a floating dock at the bottom of the pane.
  private buildDock(root: HTMLElement) {
    this.dockEl = root.createDiv("defter-dock");
    const tools = this.dockEl.createDiv("defter-group");
    this.toolButtons.write = this.iconButton(tools, "type", "Write (Alt+1)", () => this.setTool("write"));
    this.toolButtons.pen = this.iconButton(tools, "pen-line", "Pen (Alt+2)", () => this.setTool("pen"));
    this.toolButtons.hl = this.iconButton(tools, "highlighter", "Highlighter (Alt+3)", () => this.setTool("hl"));
    this.toolButtons.shape = this.iconButton(tools, "minus", "Shapes: line, arrow, box (Alt+5)", (e) => this.shapeMenu(e));
    this.toolButtons.erase = this.iconButton(tools, "eraser", "Eraser (Alt+4)", () => this.setTool("erase"));

    this.swatchesEl = this.dockEl.createDiv("defter-group defter-swatches");
    this.widthsEl = this.dockEl.createDiv("defter-group");

    const history = this.dockEl.createDiv("defter-group");
    this.iconButton(history, "undo-2", "Undo drawing (Ctrl+Z)", () => this.undo());
    this.iconButton(history, "redo-2", "Redo drawing (Ctrl+Y)", () => this.redo());

    const nav = this.dockEl.createDiv("defter-group");
    this.iconButton(nav, "chevron-left", "Previous page (Page Up)", () => this.goTo(this.pageIndex - 1));
    this.counterEl = nav.createSpan("defter-counter");
    this.iconButton(nav, "chevron-right", "Next page (Page Down)", () => this.goTo(this.pageIndex + 1));
    this.iconButton(nav, "plus", "New page after this one", () => this.addPage());
  }

  private shapeMenu(e: MouseEvent) {
    const menu = new Menu();
    for (const s of SHAPE_DEFS) {
      menu.addItem((i) =>
        i
          .setTitle(s.label)
          .setIcon(s.icon)
          .setChecked(this.tool === "shape" && this.shapeKind === s.id)
          .onClick(() => {
            this.shapeKind = s.id;
            this.setTool("shape");
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Hold Shift for straight lines and squares").setDisabled(true));
    menu.showAtMouseEvent(e);
  }

  private renderDockOptions() {
    this.swatchesEl.empty();
    this.widthsEl.empty();
    const colored = this.tool === "pen" || this.tool === "hl" || this.tool === "shape";
    this.swatchesEl.toggle(colored);
    this.widthsEl.toggle(this.tool === "pen" || this.tool === "shape");
    const shapeBtn = this.toolButtons.shape!;
    setIcon(shapeBtn, SHAPE_DEFS.find((s) => s.id === this.shapeKind)!.icon);
    if (!colored) return;
    const hl = this.tool === "hl";
    const colors = hl ? HIGHLIGHTS : INKS.map((i) => i.id);
    const current = hl ? this.hlColor : this.penColor;
    for (const c of colors) {
      const b = this.swatchesEl.createEl("button", { cls: "defter-swatch" });
      b.style.setProperty("--swatch", hl ? c : inkFor(c, this.look.tone));
      b.setAttr("aria-label", hl ? "Highlighter colour" : INKS.find((i) => i.id === c)!.label);
      b.toggleClass("is-active", c === current);
      b.onclick = () => {
        if (hl) this.hlColor = c;
        else this.penColor = c;
        this.renderDockOptions();
      };
    }
    PEN_WIDTHS.forEach((w, i) => {
      const b = this.widthsEl.createEl("button", { cls: "defter-width" });
      b.style.setProperty("--dot", w * 2 + "px");
      b.setAttr("aria-label", ["Fine", "Medium", "Bold"][i]);
      b.toggleClass("is-active", w === this.penWidth);
      b.onclick = () => {
        this.penWidth = w;
        this.renderDockOptions();
      };
    });
  }

  private setTool(tool: Tool) {
    this.tool = tool;
    for (const id of Object.keys(this.toolButtons) as Tool[]) this.toolButtons[id]!.toggleClass("is-active", id === tool);
    this.sheetEl.dataset.tool = tool;
    this.renderDockOptions();
    if (tool === "write") this.textEl.focus({ preventScroll: true });
    else this.textEl.blur();
  }

  private sizeCanvases() {
    for (const c of [this.hlCanvas, this.inkCanvas]) {
      if (c.width === this.dims.w * 2 && c.height === this.dims.h * 2) continue;
      c.width = this.dims.w * 2;
      c.height = this.dims.h * 2;
      c.getContext("2d")!.setTransform(2, 0, 0, 2, 0, 0);
    }
  }

  private fitToPane() {
    const avail = this.deskEl.clientWidth - 48;
    if (avail <= 0) return;
    // Same zoom for every page size, so text looks the same and an A5 is a smaller page.
    const s = Math.min(1.35, Math.max(0.45, avail / 820), avail / this.dims.w);
    this.sheetEl.style.transform = `scale(${s})`;
    this.holderEl.style.width = this.dims.w * s + "px";
    this.holderEl.style.height = this.dims.h * s + "px";
  }

  // ---- Pages drawer (list + search) ----------------------------------------

  private buildDrawer(root: HTMLElement) {
    this.drawerEl = root.createDiv("defter-drawer");
    this.drawerEl.toggle(false);
    const head = this.drawerEl.createDiv("defter-drawer-head");
    this.searchEl = head.createEl("input", { type: "search", cls: "defter-search", attr: { placeholder: "Search this notebook…" } });
    this.iconButton(head, "x", "Close", () => this.drawerEl.toggle(false));
    this.listEl = this.drawerEl.createDiv("defter-pages");
    this.registerDomEvent(this.searchEl, "input", () => this.renderList());
    this.registerDomEvent(this.searchEl, "keydown", (e) => {
      if (e.key === "Escape") this.drawerEl.toggle(false);
      if (e.key === "Enter") (this.listEl.querySelector(".defter-page-row") as HTMLElement | null)?.click();
    });
  }

  private toggleDrawer(search: boolean) {
    const open = this.drawerEl.isShown();
    if (open && !search) {
      this.drawerEl.toggle(false);
      return;
    }
    this.drawerEl.toggle(true);
    this.renderList();
    if (search) {
      this.searchEl.focus();
      this.searchEl.select();
    }
  }

  private renderList() {
    if (!this.drawerEl.isShown()) return;
    this.listEl.empty();
    const q = this.searchEl.value.trim().toLocaleLowerCase("tr");
    let shown = 0;
    this.nb.pages.forEach((p, i) => {
      const lower = p.text.toLocaleLowerCase("tr");
      const at = q ? lower.indexOf(q) : -1;
      if (q && at === -1) return;
      shown++;
      const row = this.listEl.createDiv("defter-page-row");
      row.toggleClass("is-current", i === this.pageIndex);
      row.createSpan({ cls: "defter-page-no", text: String(i + 1) });
      const body = row.createDiv("defter-page-body");
      body.createDiv({ cls: "defter-page-title", text: pageTitle(p.text) || (p.ink.length ? "Drawing" : "Empty page") });
      if (q) {
        const from = Math.max(0, at - 24);
        const snip = body.createDiv("defter-page-snippet");
        snip.appendText((from ? "…" : "") + p.text.slice(from, at).replace(/\n/g, " "));
        snip.createEl("mark", { text: p.text.slice(at, at + q.length) });
        snip.appendText(p.text.slice(at + q.length, at + q.length + 40).replace(/\n/g, " "));
      }
      this.registerDomEvent(row, "click", () => {
        this.goTo(i);
        if (q) {
          this.setTool("write");
          this.textEl.focus({ preventScroll: true });
          this.textEl.setSelectionRange(at, at + q.length);
        }
        this.renderList();
      });
      if (!q) {
        const tools = row.createDiv("defter-page-tools");
        const btn = (icon: string, title: string, fn: () => void, enabled: boolean) => {
          const b = this.iconButton(tools, icon, title, (e) => {
            e.stopPropagation();
            fn();
          });
          b.toggleClass("is-disabled", !enabled);
        };
        btn("arrow-up", "Move up", () => this.movePage(i, -1), i > 0);
        btn("arrow-down", "Move down", () => this.movePage(i, 1), i < this.nb.pages.length - 1);
        btn("trash-2", "Remove page (only when empty)", () => this.removePage(i), this.nb.pages.length > 1);
      }
    });
    if (!shown) this.listEl.createDiv({ cls: "defter-empty", text: q ? "No page contains this." : "No pages." });
  }

  // ---- Pages --------------------------------------------------------------

  private showPage(i: number, direction?: number) {
    this.finishStroke();
    this.pageIndex = i;
    const text = this.page.text;
    this.textEl.value = text;
    this.prevText = text;
    this.textEl.placeholder =
      i === 0 && this.nb.pages.length === 1 ? "Start writing… (# heading, **bold**, ==mark==, - list, [[link]])" : "";
    this.mirrorEl.empty();
    this.spans = [];
    this.spliceSpans(0, 0, text, false);
    this.restyle(0, text.length);
    this.redrawInk();
    const label = `${i + 1} / ${this.nb.pages.length}`;
    this.counterEl.setText(label);
    this.chipEl?.setText(`p. ${label}`);
    this.pageNoEl.setText(String(i + 1));
    if (this.file) this.host.rememberPage(this.file.path, i);
    if (direction) {
      this.sheetEl.removeClass("flip-next", "flip-prev");
      void this.sheetEl.offsetWidth;
      this.sheetEl.addClass(direction > 0 ? "flip-next" : "flip-prev");
    }
    // A larger font can push text past the bottom: carry it to the next page.
    this.fitText(false);
    this.renderList();
  }

  onResize() {
    // A notebook opened in a background tab is measured when it is shown.
    if (this.built && this.rawBroken === null) this.fitText(false);
  }

  private goTo(i: number) {
    if (i < 0 || i >= this.nb.pages.length || i === this.pageIndex) return;
    this.showPage(i, i > this.pageIndex ? 1 : -1);
    if (this.tool === "write") {
      this.textEl.focus({ preventScroll: true });
      this.textEl.setSelectionRange(this.textEl.value.length, this.textEl.value.length);
    }
    this.deskEl.scrollTop = 0;
  }

  private addPage() {
    this.nb.pages.splice(this.pageIndex + 1, 0, emptyPage());
    this.requestSave();
    this.goTo(this.pageIndex + 1);
  }

  private removePage(i: number) {
    const p = this.nb.pages[i];
    if (this.nb.pages.length === 1) return;
    if (p.text.trim() || p.ink.length) {
      new Notice("Clear the page before removing it.");
      return;
    }
    this.nb.pages.splice(i, 1);
    this.undoStack = [];
    this.redoStack = [];
    this.requestSave();
    this.showPage(Math.min(i <= this.pageIndex ? Math.max(0, this.pageIndex - 1) : this.pageIndex, this.nb.pages.length - 1), -1);
  }

  private movePage(i: number, dir: number) {
    const j = i + dir;
    if (j < 0 || j >= this.nb.pages.length) return;
    const pages = this.nb.pages;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    this.undoStack = [];
    this.redoStack = [];
    const current = this.pageIndex === i ? j : this.pageIndex === j ? i : this.pageIndex;
    this.requestSave();
    this.showPage(current);
  }

  // ---- Handwriting --------------------------------------------------------

  // Replaces [from, from + removeCount) of the rendered text. Untouched letters
  // keep their DOM nodes, so a letter still being written is not interrupted.
  private spliceSpans(from: number, removeCount: number, inserted: string, animate: boolean) {
    for (const el of this.spans.splice(from, removeCount)) el.remove();
    const before = this.spans[from] ?? null;
    const full = this.textEl.value;
    const made: HTMLSpanElement[] = [];
    const anim = animate && this.host.settings.anim !== "off";
    const stagger = Math.round(ANIM[this.host.settings.anim] / 9);
    for (let k = 0; k < inserted.length; k++) {
      const ch = inserted[k];
      const el = document.createElement("span");
      el.textContent = ch;
      el.style.top = wobble(ch, from + k > 0 ? full[from + k - 1] : "") + "px";
      if (anim && ch.trim()) {
        el.className = "defter-ch-new";
        if (inserted.length > 1) el.style.animationDelay = k * stagger + "ms";
        el.addEventListener("animationend", () => el.removeAttribute("class"), { once: true });
      }
      this.mirrorEl.insertBefore(el, before);
      made.push(el);
    }
    this.spans.splice(from, 0, ...made);
  }

  /** Re-applies Markdown marks to every line touching [from, to]. */
  private restyle(from: number, to: number) {
    const text = this.textEl.value;
    let start = text.lastIndexOf("\n", from - 1) + 1;
    const endNl = text.indexOf("\n", to);
    const end = endNl === -1 ? text.length : endNl;
    while (start <= end) {
      const nl = text.indexOf("\n", start);
      const lineEnd = nl === -1 || nl > end ? end : nl;
      const flags = lineFormats(text.slice(start, lineEnd));
      for (let i = 0; i < flags.length; i++) {
        const el = this.spans[start + i];
        if (!el) continue;
        if (flags[i]) el.dataset.f = flags[i];
        else delete el.dataset.f;
      }
      start = lineEnd + 1;
    }
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
    this.restyle(a, a + inserted.length);
    this.prevText = next;
    this.page.text = next;
  }

  private onTextInput() {
    this.syncMirror(true);
    this.fitText(true);
    this.requestSave();
  }

  private onTextClick(e: MouseEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const target = linkAt(this.textEl.value, this.textEl.selectionStart);
    if (!target) return;
    e.preventDefault();
    void this.app.workspace.openLinkText(target, this.file?.path ?? "", true);
  }

  private fits(value: string) {
    this.textEl.value = value;
    // Chromium can report one pixel extra on a full page; that still fits.
    return this.textEl.scrollHeight <= this.textEl.clientHeight + 2;
  }

  // When the page is full the overflow continues on the next page, like
  // turning the page and carrying on. Writing follows only if the caret did.
  private fitText(follow: boolean) {
    const ta = this.textEl;
    // A page that is not laid out (background tab, view still opening) has no
    // real height: measuring it would push all the text onto the next page.
    if (!ta.isShown() || ta.clientHeight < this.dims.th - 2) return;
    if (ta.scrollHeight <= ta.clientHeight + 2) return;
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
    let skip = 0;
    if (full[cut] === "\n") {
      // The page ends exactly at a line break: the next page starts with the next line.
      skip = 1;
    } else {
      // Otherwise break before the last word instead of in the middle of it.
      const boundary = Math.max(full.lastIndexOf(" ", cut - 1), full.lastIndexOf("\n", cut - 1));
      if (boundary > 0 && cut - boundary < 24 && cut < full.length) cut = boundary + 1;
    }

    ta.value = full.slice(0, cut).replace(/\n$/, "");
    const rest = full.slice(cut + skip);
    this.syncMirror(false);

    if (this.pageIndex === this.nb.pages.length - 1) this.nb.pages.push(emptyPage());
    const next = this.nb.pages[this.pageIndex + 1];
    next.text = next.text ? rest + "\n" + next.text : rest;
    const label = `${this.pageIndex + 1} / ${this.nb.pages.length}`;
    this.counterEl.setText(label);
    this.chipEl?.setText(`p. ${label}`);
    this.requestSave();

    if (follow && caret >= cut) {
      this.showPage(this.pageIndex + 1, 1);
      const pos = Math.max(0, Math.min(caret - cut - skip, ta.value.length));
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(pos, pos);
      this.deskEl.scrollTop = 0;
      this.fitText(true);
    } else {
      ta.setSelectionRange(Math.min(caret, ta.value.length), Math.min(caret, ta.value.length));
    }
  }

  // ---- Ink ----------------------------------------------------------------

  private point(e: PointerEvent): [number, number] {
    const r = this.inkCanvas.getBoundingClientRect();
    return [
      Math.round(((e.clientX - r.left) / r.width) * this.dims.w * 2) / 2,
      Math.round(((e.clientY - r.top) / r.height) * this.dims.h * 2) / 2,
    ];
  }

  private redrawLayer(kind: StrokeKind) {
    const canvas = kind === "hl" ? this.hlCanvas : this.inkCanvas;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, this.dims.w, this.dims.h);
    const strokes = this.page.ink.filter((s) => s.t === kind);
    if (this.stroke && this.stroke.t === kind) strokes.push(this.stroke);
    drawStrokes(ctx, strokes, this.look.tone);
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
    this.drawerEl.toggle(false);
    this.inkCanvas.setPointerCapture(e.pointerId);
    const [x, y] = this.point(e);
    this.snapshot();
    if (this.tool === "erase") {
      this.erasing = { x, y, changed: false };
      this.eraseAlong(x, y);
      return;
    }
    if (this.tool === "shape") {
      this.stroke = { t: "pen", s: this.shapeKind, c: this.penColor, w: this.penWidth, p: [x, y, x, y] };
    } else {
      const hl = this.tool === "hl";
      this.stroke = { t: hl ? "hl" : "pen", c: hl ? this.hlColor : this.penColor, w: hl ? HL_WIDTH : this.penWidth, p: [x, y] };
    }
    this.queueDraw();
  }

  private onPointerMove(e: PointerEvent) {
    if (this.erasing) {
      const [x, y] = this.point(e);
      this.eraseAlong(x, y);
      return;
    }
    if (!this.stroke) return;
    const p = this.stroke.p;
    if (this.stroke.s) {
      let [x, y] = this.point(e);
      if (e.shiftKey) [x, y] = snapShape(this.stroke.s, p[0], p[1], x, y);
      p[2] = x;
      p[3] = y;
    } else {
      const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of coalesced.length ? coalesced : [e]) {
        const [x, y] = this.point(ev);
        const dx = x - p[p.length - 2];
        const dy = y - p[p.length - 1];
        if (dx * dx + dy * dy >= 2.25) p.push(x, y);
      }
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
    if (s.s && Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]) < 3) {
      this.undoStack.pop();
      this.redrawLayer(s.t);
      return;
    }
    s.p = s.p.map((n) => Math.round(n * 2) / 2);
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
      const pts = strokePoints(s);
      for (let n = 0; n <= steps; n++) {
        const ex = er.x + ((x - er.x) * n) / steps;
        const ey = er.y + ((y - er.y) * n) / steps;
        for (let i = 0; i < pts.length; i += 2) {
          const dx = pts[i] - ex;
          const dy = pts[i + 1] - ey;
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
    if (e.target === this.searchEl) return;
    if (e.altKey && ["1", "2", "3", "4", "5"].includes(e.key)) {
      e.preventDefault();
      this.setTool((["write", "pen", "hl", "erase", "shape"] as Tool[])[Number(e.key) - 1]);
      return;
    }
    if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      this.goTo(this.pageIndex + (e.key === "PageDown" ? 1 : -1));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      this.toggleDrawer(true);
      return;
    }
    if (e.key === "Escape") {
      if (this.drawerEl.isShown()) this.drawerEl.toggle(false);
      else if (this.tool !== "write") this.setTool("write");
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
