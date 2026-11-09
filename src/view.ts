import { Menu, Notice, TextFileView, setIcon, type WorkspaceLeaf } from "obsidian";
import {
  emptyNotebook,
  emptyPage,
  getProp,
  pageTitle,
  parseNotebook,
  serializeNotebook,
  setProp,
  type Notebook,
  type Page,
  type PageObject,
  type ShapeKind,
  type Stroke,
  type StrokeKind,
} from "./format";
import { applyDims, pageDims, drawStrokes, fontMetrics, lineFormats, linkAt, snapShape, strokePoints, wobble, type PageDims } from "./render";
import { ANIM, HIGHLIGHTS, INKS, inkFor, resolveLook, type DefterSettings, type NotebookLook } from "./settings";
import { NotebookSettingsModal } from "./notebook-settings";
import { applyBox, drawDecor, drawObjects, pageBox } from "./page-decor";
import { NOTE_COLORS, TexModal, hitObject, saveImage } from "./objects";
import { TEMPLATES } from "./templates";
import { CalendarModal, todayStr } from "./new-notebook";

export const VIEW_TYPE = "defter-view";

const PEN_WIDTHS = [2, 3.5, 6];
const HL_WIDTH = 24;
const ERASER_RADIUS = 14;
const UNDO_LIMIT = 100;
// Above this many inserted characters (a paste) nothing is animated.
const ANIMATE_LIMIT = 40;
const MARK_COLORS = ["#e8574d", "#f2a541", "#4fb06d", "#4f8fe0", "#9b6ad6"];

type Tool = "write" | "pen" | "hl" | "shape" | "erase" | "select";

const SHAPE_DEFS: { id: ShapeKind; label: string; icon: string }[] = [
  { id: "line", label: "Line", icon: "minus" },
  { id: "arrow", label: "Arrow", icon: "move-up-right" },
  { id: "rect", label: "Box", icon: "square" },
];

interface HistoryEntry {
  page: number;
  ink: Stroke[];
  obj: PageObject[];
}

interface Selection {
  strokes: Set<Stroke>;
  objs: Set<PageObject>;
}

type Drag =
  | { kind: "lasso"; pts: number[] }
  | { kind: "move"; x: number; y: number; moved: boolean }
  | { kind: "resize"; obj: PageObject; x: number; y: number; w: number; h: number; ratio: number };

export interface DefterHost {
  settings: DefterSettings;
  openAsMarkdown(leaf: WorkspaceLeaf): void;
  rememberPage(path: string, page: number): void;
  exportPdf(title: string, nb: Notebook, look: NotebookLook): Promise<void>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function inPolygon(x: number, y: number, poly: number[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bounds(pts: number[]) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x1 = Math.min(x1, pts[i]);
    x2 = Math.max(x2, pts[i]);
    y1 = Math.min(y1, pts[i + 1]);
    y2 = Math.max(y2, pts[i + 1]);
  }
  return { x1, y1, x2, y2 };
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
  private drag: Drag | null = null;
  private sel: Selection = { strokes: new Set(), objs: new Set() };
  private objEls = new Map<object, HTMLElement>();
  private drawQueued = false;
  private toolButtons: Partial<Record<Tool, HTMLElement>> = {};
  private built = false;

  private errorEl!: HTMLElement;
  private deskEl!: HTMLElement;
  private holderEl!: HTMLElement;
  private sheetEl!: HTMLElement;
  private decorEl!: HTMLElement;
  private hlCanvas!: HTMLCanvasElement;
  private mirrorEl!: HTMLElement;
  private objLowEl!: HTMLElement;
  private inkCanvas!: HTMLCanvasElement;
  private textEl!: HTMLTextAreaElement;
  private objHighEl!: HTMLElement;
  private selEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private pageNoEl!: HTMLElement;
  private dockEl!: HTMLElement;
  private swatchesEl!: HTMLElement;
  private widthsEl!: HTMLElement;
  private counterEl!: HTMLElement;
  private chipEl: HTMLElement | null = null;
  private calendarBtn: HTMLElement | null = null;
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

  private get journal() {
    return getProp(this.nb.frontmatter, "defter-journal") === "true";
  }

  async onOpen() {
    this.addAction("sliders-horizontal", "Notebook settings", () => this.openSettings());
    this.addAction("list", "Pages", () => this.toggleDrawer(false));
    this.addAction("search", "Search this notebook", () => this.toggleDrawer(true));
    this.calendarBtn = this.addAction("calendar-days", "Journal calendar", () => this.openCalendar());
    this.calendarBtn.toggle(false);
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
    this.calendarBtn?.toggle(this.journal);
    if (clear && this.journal) this.pageIndex = this.journalPage(todayStr());
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

  // ---- Journal ----------------------------------------------------------------

  /** Index of the first page of a day; today's page is created when missing. */
  private journalPage(date: string): number {
    const i = this.nb.pages.findIndex((p) => p.date === date);
    if (i !== -1) return i;
    if (date !== todayStr()) return this.pageIndex;
    const last = this.nb.pages[this.nb.pages.length - 1];
    if (!last.date && !last.text.trim() && !last.ink.length && !last.obj?.length) {
      last.date = date;
    } else {
      this.nb.pages.push({ ...emptyPage(), date });
    }
    this.requestSave();
    return this.nb.pages.length - 1;
  }

  private openCalendar() {
    const dates = [...new Set(this.nb.pages.map((p) => p.date).filter((d): d is string => !!d))];
    new CalendarModal(this.app, dates, this.page.date, (date) => {
      const i = this.journalPage(date);
      if (i === this.pageIndex) this.showPage(i);
      else this.goTo(i);
    }).open();
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

    this.decorEl = this.sheetEl.createDiv("defter-decor");
    this.hlCanvas = this.sheetEl.createEl("canvas", { cls: "defter-layer defter-hl" });
    this.mirrorEl = this.sheetEl.createDiv("defter-text defter-mirror");
    this.objLowEl = this.sheetEl.createDiv("defter-objs defter-objs-low");
    this.inkCanvas = this.sheetEl.createEl("canvas", { cls: "defter-layer defter-ink" });
    this.textEl = this.sheetEl.createEl("textarea", { cls: "defter-text defter-input" });
    this.textEl.spellcheck = false;
    this.objHighEl = this.sheetEl.createDiv("defter-objs defter-objs-high");
    this.selEl = this.sheetEl.createDiv("defter-sel");
    this.tabsEl = this.sheetEl.createDiv("defter-tabs");
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
    this.registerDomEvent(this.inkCanvas, "dblclick", (e) => this.onDoubleClick(e));
    this.registerDomEvent(this.inkCanvas, "contextmenu", (e) => e.preventDefault());
    this.registerDomEvent(root, "keydown", (e) => this.onKeyDown(e));
    this.registerDomEvent(root, "paste", (e) => this.onPaste(e));

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
    this.toolButtons.select = this.iconButton(tools, "lasso-select", "Select and move (Alt+6)", () => this.setTool("select"));
    this.iconButton(tools, "plus-square", "Insert: picture, sticky note, formula, template, bookmark", (e) => this.insertMenu(e));

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

  private insertMenu(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Picture…").setIcon("image").setSection("insert").onClick(() => this.pickImage()));
    menu.addItem((i) => i.setTitle("Sticky note").setIcon("sticky-note").setSection("insert").onClick(() => this.addNote()));
    menu.addItem((i) => i.setTitle("Formula…").setIcon("sigma").setSection("insert").onClick(() => this.addFormula()));
    menu.addItem((i) => i.setTitle("Tip: paste a screenshot with Ctrl+V").setDisabled(true).setSection("insert"));
    for (const t of [null, ...TEMPLATES]) {
      menu.addItem((i) =>
        i
          .setTitle(t ? `Template: ${t.label}` : "Template: plain page")
          .setIcon("layout-template")
          .setSection("template")
          .setChecked((this.page.tpl ?? null) === (t?.id ?? null))
          .onClick(() => this.setTemplate(t?.id))
      );
    }
    for (const c of MARK_COLORS) {
      menu.addItem((i) => {
        i.setTitle(this.page.mark === c ? "Bookmarked" : "Bookmark this page").setIcon("bookmark").setSection("mark").onClick(() => this.setMark(c));
        const icon = (i as unknown as { iconEl?: HTMLElement }).iconEl;
        if (icon) icon.style.color = c;
      });
    }
    if (this.page.mark) menu.addItem((i) => i.setTitle("Remove bookmark").setIcon("bookmark-minus").setSection("mark").onClick(() => this.setMark(undefined)));
    menu.showAtMouseEvent(e);
  }

  private renderDockOptions() {
    this.swatchesEl.empty();
    this.widthsEl.empty();
    const colored = this.tool === "pen" || this.tool === "hl" || this.tool === "shape";
    this.swatchesEl.toggle(colored);
    this.widthsEl.toggle(this.tool === "pen" || this.tool === "shape");
    setIcon(this.toolButtons.shape!, SHAPE_DEFS.find((s) => s.id === this.shapeKind)!.icon);
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
    if (tool !== "select") this.clearSelection();
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
    const avail = this.deskEl.clientWidth - 48 - 40; // room for bookmark tabs
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
      const notes = (p.obj ?? []).filter((o) => o.k === "note").map((o) => o.v).join("\n");
      const at = q ? p.text.toLocaleLowerCase("tr").indexOf(q) : -1;
      if (q && at === -1 && !notes.toLocaleLowerCase("tr").includes(q)) return;
      shown++;
      const row = this.listEl.createDiv("defter-page-row");
      row.toggleClass("is-current", i === this.pageIndex);
      if (p.mark) row.style.setProperty("--mark", p.mark);
      row.toggleClass("has-mark", !!p.mark);
      row.createSpan({ cls: "defter-page-no", text: String(i + 1) });
      const body = row.createDiv("defter-page-body");
      const title = pageTitle(p.text) || (p.ink.length || p.obj?.length ? "Drawing" : "Empty page");
      body.createDiv({ cls: "defter-page-title", text: title });
      if (p.date) body.createDiv({ cls: "defter-page-snippet", text: window.moment(p.date).format("ddd, D MMM YYYY") });
      if (q && at !== -1) {
        const from = Math.max(0, at - 24);
        const snip = body.createDiv("defter-page-snippet");
        snip.appendText((from ? "…" : "") + p.text.slice(from, at).replace(/\n/g, " "));
        snip.createEl("mark", { text: p.text.slice(at, at + q.length) });
        snip.appendText(p.text.slice(at + q.length, at + q.length + 40).replace(/\n/g, " "));
      } else if (q) {
        body.createDiv({ cls: "defter-page-snippet", text: "Found in a sticky note" });
      }
      this.registerDomEvent(row, "click", () => {
        this.goTo(i);
        if (q && at !== -1) {
          this.setTool("write");
          this.textEl.focus({ preventScroll: true });
          this.textEl.setSelectionRange(at, at + q.length);
        }
        this.renderList();
      });
      if (!q) {
        const tools = row.createDiv("defter-page-tools");
        const btn = (icon: string, t: string, fn: () => void, enabled: boolean) => {
          const b = this.iconButton(tools, icon, t, (e) => {
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

  private redrawObjects() {
    this.objEls = drawObjects(this.app, this.objLowEl, this.objHighEl, this.page, inkFor(this.look.ink, this.look.tone));
  }

  private showPage(i: number, direction?: number) {
    this.finishStroke();
    this.clearSelection();
    this.pageIndex = i;
    const page = this.page;
    applyBox(this.sheetEl, pageBox(page, this.dims));
    if (page.tpl) this.sheetEl.dataset.tpl = page.tpl;
    else delete this.sheetEl.dataset.tpl;
    drawDecor(this.decorEl, page, this.dims, this.getDisplayText());
    this.redrawObjects();
    this.renderTabs();
    const text = page.text;
    this.textEl.value = text;
    this.prevText = text;
    this.textEl.placeholder =
      i === 0 && this.nb.pages.length === 1 && !page.tpl ? "Start writing… (# heading, **bold**, ==mark==, - list, [[link]])" : "";
    this.mirrorEl.empty();
    this.spans = [];
    this.spliceSpans(0, 0, text, false);
    this.restyle(0, text.length);
    this.redrawInk();
    this.updateCounter();
    this.pageNoEl.setText(String(i + 1));
    if (this.file) this.host.rememberPage(this.file.path, i);
    if (direction) {
      this.sheetEl.removeClass("flip-next", "flip-prev");
      void this.sheetEl.offsetWidth;
      this.sheetEl.addClass(direction > 0 ? "flip-next" : "flip-prev");
    }
    // A larger font or a template can push text past the bottom: carry it on.
    this.fitText(false);
    this.renderList();
  }

  private updateCounter() {
    const label = `${this.pageIndex + 1} / ${this.nb.pages.length}`;
    this.counterEl.setText(label);
    const date = this.page.date;
    this.chipEl?.setText(date ? `${window.moment(date).format("D MMM")} · ${label}` : `p. ${label}`);
  }

  onResize() {
    // A notebook opened in a background tab is measured when it is shown.
    if (this.built && this.rawBroken === null) this.fitText(false);
  }

  /** Bookmark tabs sticking out of the page edge, one per bookmarked page. */
  private renderTabs() {
    this.tabsEl.empty();
    let k = 0;
    this.nb.pages.forEach((p, i) => {
      if (!p.mark) return;
      const tab = this.tabsEl.createDiv({ cls: "defter-tab", text: String(i + 1) });
      tab.style.setProperty("--mark", p.mark);
      tab.style.top = 90 + k++ * 62 + "px";
      tab.toggleClass("is-current", i === this.pageIndex);
      tab.setAttr("aria-label", pageTitle(p.text) || `Page ${i + 1}`);
      tab.onclick = () => this.goTo(i);
    });
  }

  private setMark(color: string | undefined) {
    if (color) this.page.mark = color;
    else delete this.page.mark;
    this.requestSave();
    this.renderTabs();
    this.renderList();
  }

  private setTemplate(id: string | undefined) {
    if (id) this.page.tpl = id;
    else delete this.page.tpl;
    this.requestSave();
    this.showPage(this.pageIndex);
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

  /** A new page continues the current one: same journal day, same template. */
  private newPageAfter(): Page {
    const p = emptyPage();
    if (this.page.date) p.date = this.page.date;
    if (this.page.tpl && this.page.tpl !== "cover") p.tpl = this.page.tpl;
    return p;
  }

  private addPage() {
    this.nb.pages.splice(this.pageIndex + 1, 0, this.newPageAfter());
    this.requestSave();
    this.goTo(this.pageIndex + 1);
  }

  private removePage(i: number) {
    const p = this.nb.pages[i];
    if (this.nb.pages.length === 1) return;
    if (p.text.trim() || p.ink.length || p.obj?.length) {
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
    if (!ta.isShown() || ta.clientHeight < 3 * 36 - 2) return;
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

    // Continue on the next page of the same day (journal), else a new page.
    const nextPage = this.nb.pages[this.pageIndex + 1];
    if (!nextPage || (this.page.date && nextPage.date !== this.page.date)) {
      this.nb.pages.splice(this.pageIndex + 1, 0, this.newPageAfter());
    }
    const next = this.nb.pages[this.pageIndex + 1];
    next.text = next.text ? rest + "\n" + next.text : rest;
    this.updateCounter();
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

  // ---- Objects: pictures, sticky notes, formulas -----------------------------

  private addObject(o: PageObject) {
    this.snapshot();
    (this.page.obj ??= []).push(o);
    this.requestSave();
    this.redrawObjects();
    this.setTool("select");
    this.sel = { strokes: new Set(), objs: new Set([o]) };
    this.renderSelection();
  }

  /** Centre of the visible part of the page, in page units. */
  private visibleCentre(): [number, number] {
    const r = this.inkCanvas.getBoundingClientRect();
    const d = this.deskEl.getBoundingClientRect();
    const scale = r.width / this.dims.w || 1;
    const cy = (Math.max(r.top, d.top) + Math.min(r.bottom, d.bottom)) / 2;
    return [this.dims.w / 2, Math.max(80, Math.min(this.dims.h - 80, (cy - r.top) / scale))];
  }

  private async placeImage(blob: Blob) {
    if (!this.file) return;
    try {
      const img = await saveImage(this.app, blob, this.file);
      const s = Math.min(1, (this.dims.w * 0.6) / img.w, (this.dims.h * 0.5) / img.h);
      const w = Math.round(img.w * s);
      const h = Math.round(img.h * s);
      const [cx, cy] = this.visibleCentre();
      this.addObject({ k: "img", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, v: img.path });
    } catch (e) {
      new Notice("Could not add the picture: " + (e as Error).message);
    }
  }

  private pickImage() {
    const input = document.body.createEl("input", { type: "file", attr: { accept: "image/*" } });
    input.style.display = "none";
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (f) void this.placeImage(f);
    };
    input.click();
  }

  private onPaste(e: ClipboardEvent) {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    const blob = item?.getAsFile();
    if (!blob) return;
    e.preventDefault();
    void this.placeImage(blob);
  }

  private addNote() {
    const [cx, cy] = this.visibleCentre();
    const o: PageObject = { k: "note", x: Math.round(cx - 100), y: Math.round(cy - 80), w: 200, h: 160, v: "", c: NOTE_COLORS[0] };
    this.addObject(o);
    this.editNote(o);
  }

  private addFormula() {
    new TexModal(this.app, "", (tex, w, h) => {
      const [cx, cy] = this.visibleCentre();
      this.addObject({ k: "tex", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, v: tex });
    }).open();
  }

  private editNote(o: PageObject) {
    const el = this.objEls.get(o);
    if (!el) return;
    el.empty();
    const ta = el.createEl("textarea", { cls: "defter-note-edit" });
    ta.value = o.v;
    el.addClass("is-editing");
    setTimeout(() => ta.focus(), 0);
    const done = () => {
      if (ta.value !== o.v) {
        this.snapshot();
        o.v = ta.value;
        this.requestSave();
      }
      this.redrawObjects();
      this.renderSelection();
    };
    ta.addEventListener("blur", done, { once: true });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") ta.blur();
    });
  }

  private objectMenu(e: MouseEvent, o: PageObject) {
    const menu = new Menu();
    if (o.k === "note") {
      menu.addItem((i) => i.setTitle("Edit text").setIcon("pencil").onClick(() => this.editNote(o)));
      for (const c of NOTE_COLORS) {
        menu.addItem((i) => {
          i.setTitle("Note colour").setIcon("square").setSection("colour").onClick(() => {
            this.snapshot();
            o.c = c;
            this.requestSave();
            this.showPage(this.pageIndex);
          });
          const icon = (i as unknown as { iconEl?: HTMLElement }).iconEl;
          if (icon) icon.style.color = c;
        });
      }
    }
    if (o.k === "tex") {
      menu.addItem((i) =>
        i.setTitle("Edit formula").setIcon("pencil").onClick(() =>
          new TexModal(this.app, o.v, (tex, w, h) => {
            this.snapshot();
            const ratio = o.h / Math.max(1, h);
            o.v = tex;
            o.w = Math.round(w * ratio);
            o.h = Math.round(h * ratio);
            this.requestSave();
            this.showPage(this.pageIndex);
          }).open()
        )
      );
    }
    menu.addItem((i) =>
      i
        .setTitle("Delete")
        .setIcon("trash-2")
        .setWarning(true)
        .setSection("danger")
        .onClick(() => {
          this.sel = { strokes: new Set(), objs: new Set([o]) };
          this.deleteSelection();
        })
    );
    menu.showAtMouseEvent(e);
  }

  // ---- Selection --------------------------------------------------------------

  private clearSelection() {
    this.sel = { strokes: new Set(), objs: new Set() };
    if (this.selEl) {
      this.selEl.empty();
      this.selEl.toggle(false);
    }
  }

  private selectionBounds() {
    const pts: number[] = [];
    for (const s of this.sel.strokes) pts.push(...strokePoints(s));
    for (const o of this.sel.objs) pts.push(o.x, o.y, o.x + o.w, o.y + o.h);
    if (!pts.length) return null;
    const b = bounds(pts);
    const pad = 6;
    return { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad };
  }

  private renderSelection(lasso?: number[]) {
    this.selEl.empty();
    if (lasso && lasso.length > 2) {
      const svg = this.selEl.createSvg("svg", { attr: { width: String(this.dims.w), height: String(this.dims.h) } });
      svg.createSvg("polyline", { attr: { points: lasso.join(" "), class: "defter-lasso" } });
      this.selEl.toggle(true);
      return;
    }
    const b = this.selectionBounds();
    if (!b) {
      this.selEl.toggle(false);
      return;
    }
    const box = this.selEl.createDiv("defter-sel-box");
    box.style.left = b.x1 + "px";
    box.style.top = b.y1 + "px";
    box.style.width = b.x2 - b.x1 + "px";
    box.style.height = b.y2 - b.y1 + "px";
    if (this.sel.objs.size === 1 && !this.sel.strokes.size) box.createDiv("defter-sel-handle");
    this.selEl.toggle(true);
  }

  private deleteSelection() {
    if (!this.sel.strokes.size && !this.sel.objs.size) return;
    this.snapshot();
    this.page.ink = this.page.ink.filter((s) => !this.sel.strokes.has(s));
    if (this.page.obj) this.page.obj = this.page.obj.filter((o) => !this.sel.objs.has(o));
    if (this.page.obj && !this.page.obj.length) delete this.page.obj;
    this.requestSave();
    this.showPage(this.pageIndex);
  }

  // ---- Ink ----------------------------------------------------------------

  private point(e: PointerEvent | MouseEvent): [number, number] {
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

  // Strokes and objects are changed in place when moved, so history keeps copies.
  private snapshot() {
    this.undoStack.push({ page: this.pageIndex, ink: clone(this.page.ink), obj: clone(this.page.obj ?? []) });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private applyHistory(from: HistoryEntry[], to: HistoryEntry[]) {
    const entry = from.pop();
    if (!entry || !this.nb.pages[entry.page]) return;
    const page = this.nb.pages[entry.page];
    to.push({ page: entry.page, ink: clone(page.ink), obj: clone(page.obj ?? []) });
    page.ink = entry.ink;
    if (entry.obj.length) page.obj = entry.obj;
    else delete page.obj;
    this.showPage(entry.page);
    this.requestSave();
  }

  private undo() {
    this.applyHistory(this.undoStack, this.redoStack);
  }
  private redo() {
    this.applyHistory(this.redoStack, this.undoStack);
  }

  private onDoubleClick(e: MouseEvent) {
    if (this.tool !== "select") return;
    const [x, y] = this.point(e);
    const hit = hitObject(this.page.obj ?? [], x, y);
    if (hit?.obj.k === "note") this.editNote(hit.obj);
    else if (hit) this.objectMenu(e, hit.obj);
  }

  private onPointerDown(e: PointerEvent) {
    if (this.tool === "write") return;
    if (e.button === 2) {
      const [x, y] = this.point(e);
      const hit = hitObject(this.page.obj ?? [], x, y);
      if (hit) this.objectMenu(e, hit.obj);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    this.drawerEl.toggle(false);
    this.inkCanvas.setPointerCapture(e.pointerId);
    const [x, y] = this.point(e);
    if (this.tool === "select") {
      const hit = hitObject(this.page.obj ?? [], x, y);
      const b = this.selectionBounds();
      const inSel = !!b && x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
      this.snapshot();
      if (hit?.corner) {
        this.sel = { strokes: new Set(), objs: new Set([hit.obj]) };
        this.drag = { kind: "resize", obj: hit.obj, x, y, w: hit.obj.w, h: hit.obj.h, ratio: hit.obj.w / Math.max(1, hit.obj.h) };
      } else if (inSel) {
        this.drag = { kind: "move", x, y, moved: false };
      } else if (hit) {
        this.sel = { strokes: new Set(), objs: new Set([hit.obj]) };
        this.drag = { kind: "move", x, y, moved: false };
      } else {
        this.undoStack.pop();
        this.clearSelection();
        this.drag = { kind: "lasso", pts: [x, y] };
      }
      this.renderSelection();
      return;
    }
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
    if (this.drag) {
      this.onDragMove(e);
      return;
    }
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

  private onDragMove(e: PointerEvent) {
    const [x, y] = this.point(e);
    const d = this.drag!;
    if (d.kind === "lasso") {
      d.pts.push(x, y);
      this.renderSelection(d.pts);
      return;
    }
    if (d.kind === "move") {
      const dx = x - d.x;
      const dy = y - d.y;
      if (!dx && !dy) return;
      d.moved = true;
      d.x = x;
      d.y = y;
      for (const s of this.sel.strokes) {
        for (let i = 0; i < s.p.length; i += 2) {
          s.p[i] += dx;
          s.p[i + 1] += dy;
        }
      }
      for (const o of this.sel.objs) {
        o.x += dx;
        o.y += dy;
        const el = this.objEls.get(o);
        if (el) {
          el.style.left = o.x + "px";
          el.style.top = o.y + "px";
        }
      }
      if (this.sel.strokes.size) this.queueRedrawAll();
      this.renderSelection();
      return;
    }
    const o = d.obj;
    let w = Math.max(30, d.w + (x - d.x));
    let h = Math.max(24, d.h + (y - d.y));
    if (o.k !== "note") {
      // Pictures and formulas keep their shape.
      h = w / d.ratio;
      if (h < 24) {
        h = 24;
        w = h * d.ratio;
      }
    }
    o.w = Math.round(w);
    o.h = Math.round(h);
    const el = this.objEls.get(o);
    if (el) {
      el.style.width = o.w + "px";
      el.style.height = o.h + "px";
      const tex = el.querySelector(".defter-tex") as HTMLElement | null;
      if (tex) tex.style.transform = `scale(${Math.min(o.w / (tex.scrollWidth || 1), o.h / (tex.scrollHeight || 1))})`;
    }
    this.renderSelection();
  }

  private queueRedrawAll() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.redrawInk();
    });
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
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      if (d.kind === "lasso") {
        const poly = d.pts;
        if (poly.length >= 6) {
          const strokes = this.page.ink.filter((s) => {
            const b = bounds(strokePoints(s));
            return inPolygon((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2, poly);
          });
          const objs = (this.page.obj ?? []).filter((o) => inPolygon(o.x + o.w / 2, o.y + o.h / 2, poly));
          this.sel = { strokes: new Set(strokes), objs: new Set(objs) };
        }
        this.renderSelection();
      } else if (d.kind === "move" && !d.moved) {
        this.undoStack.pop();
      } else {
        for (const s of this.sel.strokes) s.p = s.p.map((n) => Math.round(n * 2) / 2);
        this.requestSave();
        this.redrawInk();
        if (d.kind === "resize") this.redrawObjects();
        this.renderSelection();
      }
      return;
    }
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
    if (e.altKey && ["1", "2", "3", "4", "5", "6"].includes(e.key)) {
      e.preventDefault();
      this.setTool((["write", "pen", "hl", "erase", "shape", "select"] as Tool[])[Number(e.key) - 1]);
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
    if (this.tool === "select" && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (e.key === "Escape") {
      if (this.drawerEl.isShown()) this.drawerEl.toggle(false);
      else if (this.sel.strokes.size || this.sel.objs.size) this.clearSelection();
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
