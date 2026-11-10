import { Menu, Modal, Notice, Platform, Scope, Setting, TextFileView, normalizePath, setIcon, type App, type WorkspaceLeaf } from "obsidian";
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
  type PenKind,
  type ShapeKind,
  type Stroke,
  type StrokeKind,
} from "./format";
import {
  LINE,
  TEXT_TOP,
  applyDims,
  checkboxAt,
  drawStrokes,
  fontMetrics,
  lineFormats,
  linkAt,
  pageDims,
  recognizeShape,
  smoothPoints,
  snapShape,
  strokePoints,
  wobble,
  type PageDims,
} from "./render";
import { ANIM, HIGHLIGHTS, INKS, fmtDate, inkFor, resolveLook, type DefterSettings, type NotebookLook, type Sticker } from "./settings";
import { parseCards, isDue, type CardState } from "./cards";
import { StudyModal, type StudyHost } from "./study-modal";
import type { StudyTimer } from "./timer";
import { WritePad } from "./write-pad";
import type { PenSound } from "./sound";
import { importPdf } from "./pdf-import";
import { T } from "./i18n";
import { HelpModal, StickerModal } from "./panels";
import { renderStaticPage } from "./static-page";
import { getRemote } from "./pdf";
import {
  LOCK_KEY,
  WrongSecretError,
  changePassword,
  createLock,
  isLockedText,
  openNotebookText,
  parseLocked,
  renewRecovery,
  sealNotebook,
  unlockWithPassword,
  unlockWithRecovery,
  type LockSession,
} from "./lock";
import { PasswordModal, RecoveryModal } from "./lock-ui";
import { NAMED as MATH_NAMED, OPERATORS as MATH_OPERATORS, calcLine, shortcutAt } from "./math";
import { NotebookSettingsModal } from "./notebook-settings";
import { applyBox, drawDecor, drawObjects, pageBox } from "./page-decor";
import { NOTE_COLORS, STAMP_COLORS, TAPE_COLORS, TexModal, hitObject, saveImage } from "./objects";
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

type Tool = "write" | "pen" | "hl" | "shape" | "erase" | "select" | "pad";

const SHAPE_DEFS: { id: ShapeKind; label: string; icon: string }[] = [
  { id: "line", label: "Line", icon: "minus" },
  { id: "arrow", label: "Arrow", icon: "move-up-right" },
  { id: "rect", label: "Box", icon: "square" },
  { id: "ellipse", label: "Circle / ellipse", icon: "circle" },
  { id: "tri", label: "Triangle", icon: "triangle" },
];

const PEN_DEFS: { id: PenKind | "ball"; label: string; icon: string }[] = [
  { id: "ball", label: "Ballpoint", icon: "pen-line" },
  { id: "fountain", label: "Fountain pen", icon: "pen-tool" },
  { id: "pencil", label: "Pencil", icon: "pencil" },
  { id: "dash", label: "Dashed", icon: "ellipsis" },
];

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
/** Held still this long, a freehand line becomes a clean shape. */
const HOLD_MS = 600;
/** What the system clipboard holds after copying a selection. */
const CLIP_MARK = "defter-selection:";

interface ElectronClip {
  clipboard: { writeImage(img: unknown): void };
  nativeImage: { createFromBuffer(b: unknown): unknown };
}

/** Copied strokes and objects, shared by every open notebook. */
let clipboard: { id: string; ink: Stroke[]; obj: PageObject[] } | null = null;

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

export interface DefterHost extends StudyHost {
  settings: DefterSettings;
  timer: StudyTimer;
  sound: PenSound;
  saveSettings(): Promise<void>;
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
  /** Private notebook: the key while unlocked, and the latest encrypted file. */
  private lock: LockSession | null = null;
  private sealed: string | null = null;
  lastActive = Date.now();
  private lockEl!: HTMLElement;
  private lockBtn: HTMLElement | null = null;
  private tool: Tool = "write";
  private shapeKind: ShapeKind = "line";
  private penColor = INKS[0].id;
  private hlColor = HIGHLIGHTS[0];
  private penWidth = PEN_WIDTHS[1];
  private penKind: PenKind | "ball" = "ball";
  private zoom = 1;
  private pad: WritePad | null = null;
  private studyMode = false;
  /** Study mode: hidden groups the user clicked open (stroke objects or text offsets). */
  private revealed = new Set<unknown>();
  private holdTimer = 0;
  private snapped = false;
  private focusMode = false;
  private drawerMode: "pages" | "grid" | "todos" = "pages";
  private partnerEl: HTMLElement | null = null;
  private partnerIndex = -1;
  private turnEl: HTMLElement | null = null;
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
  private studyBtn: HTMLElement | null = null;
  private cardsBtn: HTMLElement | null = null;
  private timerBtn: HTMLElement | null = null;
  private zoomEl!: HTMLElement;
  private drawerTabs!: HTMLElement;
  private drawerEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, host: DefterHost) {
    super(leaf);
    this.host = host;
    // Ctrl+D is an Obsidian hotkey (delete paragraph); in a notebook it duplicates the selection.
    this.scope = new Scope(this.app.scope);
    // F1 opens Obsidian's help elsewhere; in a notebook it lists the shortcuts.
    this.scope.register([], "F1", () => {
      new HelpModal(this.app).open();
      return false;
    });
    this.scope.register(["Mod"], "d", () => {
      if (this.tool !== "select") return true;
      this.duplicateSelection();
      return false;
    });
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getIcon() {
    return "notebook-pen";
  }
  getDisplayText() {
    return this.file ? this.file.basename : T("Notebook");
  }

  private get journal() {
    return getProp(this.nb.frontmatter, "defter-journal") === "true";
  }

  async onOpen() {
    this.addAction("sliders-horizontal", T("Notebook settings"), () => this.openSettings());
    this.timerBtn = this.addAction("timer", T("Study timer"), (e) => this.host.timer.menu(e, this.file?.path, this.getDisplayText()));
    this.cardsBtn = this.addAction("layers", T("Study flashcards (front :: back lines)"), () => this.studyCards());
    this.lockBtn = this.addAction("lock", T("Lock now"), () => void this.lockNow());
    this.lockBtn.toggle(false);
    this.studyBtn = this.addAction("eye-off", T("Study mode: hide highlighted text and card answers (Alt+S)"), () => this.toggleStudy());
    this.addAction("list", T("Pages"), () => this.toggleDrawer(false));
    this.addAction("search", T("Search this notebook"), () => this.toggleDrawer(true));
    this.calendarBtn = this.addAction("calendar-days", T("Journal calendar"), () => this.openCalendar());
    this.calendarBtn.toggle(false);
    const actions = (this as unknown as { actionsEl?: HTMLElement }).actionsEl;
    if (actions) {
      this.chipEl = createDiv({ cls: "defter-chip clickable-icon", attr: { "aria-label": T("Pages") } });
      actions.prepend(this.chipEl);
      this.registerDomEvent(this.chipEl, "click", () => this.toggleDrawer(false));
    }
    this.ensureUi();
    this.register(this.host.timer.onChange(() => this.renderTimer()));
    this.renderTimer();
  }

  private renderTimer() {
    const r = this.host.timer.running;
    const mine = !!r && r.path === this.file?.path;
    this.timerBtn?.toggleClass("is-running", mine);
    this.timerBtn?.setAttr("data-label", mine ? this.host.timer.label() : "");
  }

  onPaneMenu(menu: Menu, source: string) {
    if (source === "more-options" || source === "tab-header") {
      menu.addItem((i) => i.setSection("action").setTitle(T("Notebook settings")).setIcon("sliders-horizontal").onClick(() => this.openSettings()));
      menu.addItem((i) => i.setSection("action").setTitle(T("Add page after this one")).setIcon("file-plus").onClick(() => this.addPage()));
      menu.addItem((i) => i.setSection("action").setTitle(T("Duplicate this page")).setIcon("copy").onClick(() => this.duplicatePage(this.pageIndex)));
      menu.addItem((i) => i.setSection("action").setTitle(T("Remove this page")).setIcon("file-minus").onClick(() => this.removePage(this.pageIndex)));
      menu.addItem((i) => i.setSection("action").setTitle(T("Import PDF pages…")).setIcon("file-input").onClick(() => this.importPdf()));
      menu.addItem((i) => i.setSection("action").setTitle(T("Pull text back from the next pages")).setIcon("wrap-text").onClick(() => this.reflow()));
      if (Platform.isDesktopApp) {
        menu.addItem((i) => i.setSection("action").setTitle(T("Export to PDF")).setIcon("file-output").onClick(() => this.exportPdf()));
        menu.addItem((i) => i.setSection("action").setTitle(T("Copy page as image")).setIcon("image").onClick(() => void this.pageImage("copy")));
        menu.addItem((i) => i.setSection("action").setTitle(T("Save page as PNG")).setIcon("image-down").onClick(() => void this.pageImage("save")));
      }
      if (this.lock) {
        menu.addItem((i) => i.setSection("lock").setTitle(T("Lock now")).setIcon("lock").onClick(() => void this.lockNow()));
        menu.addItem((i) => i.setSection("lock").setTitle(T("Change password…")).setIcon("key-round").onClick(() => this.changePassword()));
        menu.addItem((i) => i.setSection("lock").setTitle(T("New recovery key…")).setIcon("life-buoy").onClick(() => void this.newRecovery()));
        menu.addItem((i) => i.setSection("lock").setTitle(T("Remove password…")).setIcon("lock-open").onClick(() => this.removeLock()));
      } else if (this.rawBroken === null) {
        menu.addItem((i) => i.setSection("lock").setTitle(T("Make private (password)…")).setIcon("lock").onClick(() => this.makePrivate()));
      }
      menu.addItem((i) => i.setSection("view").setTitle(T("Focus mode (Alt+F)")).setIcon("maximize").onClick(() => this.toggleFocus()));
      menu.addItem((i) => i.setSection("view").setTitle(T("Keyboard shortcuts (F1)")).setIcon("keyboard").onClick(() => new HelpModal(this.app).open()));
      menu.addItem((i) => i.setSection("action").setTitle(T("Open as Markdown")).setIcon("file-text").onClick(() => this.host.openAsMarkdown(this.leaf)));
    }
    super.onPaneMenu(menu, source);
  }

  getViewData() {
    // A file we could not read (or a locked one) is handed back untouched.
    if (this.rawBroken !== null) return this.rawBroken;
    // A private notebook never leaves memory unencrypted.
    if (this.lock) return this.sealed ?? "";
    return serializeNotebook(this.nb);
  }

  /** Private notebooks are encrypted before Obsidian writes the file. */
  private sealSeq = 0;

  async save(clear?: boolean) {
    if (this.lock && this.rawBroken === null) {
      // Saves can overlap (autosave + lock); an older result never replaces a newer one.
      const seq = ++this.sealSeq;
      const sealed = await sealNotebook(this.lock, this.nb.frontmatter, serializeNotebook(this.nb));
      if (seq === this.sealSeq) this.sealed = sealed;
      else return;
    }
    return super.save(clear);
  }

  /** Drops everything shown from a private notebook. */
  private wipe() {
    this.nb = emptyNotebook();
    this.mirrorEl.empty();
    this.spans = [];
    this.textEl.value = "";
    this.prevText = "";
    this.undoStack = [];
    this.redoStack = [];
    this.revealed.clear();
    for (const c of [this.inkCanvas, this.hlCanvas]) c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    this.objLowEl.empty();
    this.objHighEl.empty();
    this.decorEl.empty();
    this.listEl.empty();
    this.partnerEl?.remove();
    this.partnerEl = null;
    this.tabsEl.empty();
  }

  /** Pictures, PDF pages and exports of a private notebook are not encrypted: say so. */
  private warnPlain(what: string) {
    if (this.lock) new Notice(T(what), 8000);
  }

  setViewData(data: string, clear: boolean) {
    this.ensureUi();
    this.lockEl.toggle(false);
    if (isLockedText(data)) {
      // Until it is unlocked the file is handed back exactly as it is.
      this.rawBroken = data;
      if (this.lock && !clear) {
        void this.reopenLocked(data);
        return;
      }
      this.lock = null;
      this.sealed = null;
      this.wipe();
      this.showLockScreen(data);
      return;
    }
    if (clear) {
      this.lock = null;
      this.sealed = null;
    }
    this.loadText(data, clear);
  }

  private loadText(data: string, clear: boolean) {
    this.lockBtn?.toggle(!!this.lock);
    try {
      this.nb = parseNotebook(data);
      this.rawBroken = null;
      this.errorEl.toggle(false);
      this.deskEl.toggle(true);
      this.dockEl.toggle(true);
    } catch (e) {
      // A private notebook whose decrypted text cannot be read: keep the
      // encrypted file exactly as it is, never the decrypted text.
      if (this.lock) {
        this.rawBroken = this.sealed ?? "";
        this.lock = null;
        this.wipe();
      } else this.rawBroken = data;
      this.errorEl.setText(
        T("This notebook could not be read, so it was left unchanged. Use “Open as Markdown” to look at the file.") + " " +
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
    if (clear) this.revealed.clear();
    this.applyLook();
    this.renderCardsBtn();
  }

  clear() {
    this.nb = emptyNotebook();
    this.rawBroken = null;
    this.lock = null;
    this.sealed = null;
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
    this.sheetEl.dataset.binding = this.look.binding;
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
    this.warnPlain("The exported PDF is not encrypted.");
    await this.host.exportPdf(this.getDisplayText(), this.nb, this.look);
  }

  // ---- UI -----------------------------------------------------------------

  private ensureUi() {
    if (this.built) return;
    this.built = true;
    const root = this.contentEl;
    root.empty();
    root.addClass("defter-root");
    // Focusable, so shortcuts work while drawing (the canvas itself takes no focus).
    root.tabIndex = -1;
    this.errorEl = root.createDiv("defter-error");
    this.errorEl.toggle(false);
    this.lockEl = root.createDiv("defter-lock-screen");
    this.lockEl.toggle(false);

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
    this.registerDomEvent(this.objHighEl, "click", (e) => this.onObjectClick(e));

    this.buildDock(root);
    this.buildDrawer(root);

    this.registerDomEvent(this.textEl, "input", (e) => this.onTextInput(e as InputEvent));
    this.registerDomEvent(this.textEl, "keydown", (e) => this.onTextKey(e));
    this.registerDomEvent(this.textEl, "click", (e) => this.onTextClick(e));
    this.registerDomEvent(this.inkCanvas, "pointerdown", (e) => this.onPointerDown(e));
    this.registerDomEvent(this.inkCanvas, "pointermove", (e) => this.onPointerMove(e));
    // A palm lifting while the stylus draws must not end the line.
    const up = (e: PointerEvent) => !(e.pointerType === "touch" && this.stylusSeen) && this.onPointerUp();
    this.registerDomEvent(this.inkCanvas, "pointerup", up);
    this.registerDomEvent(this.inkCanvas, "pointercancel", up);
    this.registerDomEvent(this.inkCanvas, "dblclick", (e) => this.onDoubleClick(e));
    this.registerDomEvent(this.inkCanvas, "contextmenu", (e) => e.preventDefault());
    this.registerDomEvent(root, "keydown", (e) => this.onKeyDown(e));
    this.registerDomEvent(root, "pointerdown", () => (this.lastActive = Date.now()), { capture: true });
    this.registerDomEvent(root, "keydown", () => (this.lastActive = Date.now()), { capture: true });
    this.registerDomEvent(root, "paste", (e) => this.onPaste(e));
    this.registerDomEvent(this.deskEl, "wheel", (e) => this.onWheel(e), { passive: false });

    // Resizing in the next frame avoids a ResizeObserver feedback loop warning.
    const ro = new ResizeObserver(() => requestAnimationFrame(() => (this.fitToPane(), this.placePad())));
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
    this.toolButtons.write = this.iconButton(tools, "type", T("Write (Alt+1)"), () => this.setTool("write"));
    this.toolButtons.pen = this.iconButton(tools, "pen-line", T("Pen (Alt+2)"), () => this.setTool("pen"));
    this.toolButtons.hl = this.iconButton(tools, "highlighter", T("Highlighter (Alt+3)"), () => this.setTool("hl"));
    this.toolButtons.shape = this.iconButton(tools, "minus", T("Shapes: line, arrow, box (Alt+5)"), (e) => this.shapeMenu(e));
    this.toolButtons.erase = this.iconButton(tools, "eraser", T("Eraser (Alt+4)"), () => this.setTool("erase"));
    this.toolButtons.select = this.iconButton(tools, "lasso-select", T("Select and move (Alt+6)"), () => this.setTool("select"));
    this.toolButtons.pad = this.iconButton(tools, "signature", T("Write pad: write with the mouse or touchpad (Alt+7)"), () => this.setTool(this.tool === "pad" ? "write" : "pad"));
    this.iconButton(tools, "sigma", T("Maths: symbols, shortcuts, calculator"), () => this.toggleMathPanel());
    this.iconButton(tools, "plus-square", T("Insert: picture, sticky note, tape, sticker, formula, PDF, template, bookmark"), (e) => this.insertMenu(e));

    this.swatchesEl = this.dockEl.createDiv("defter-group defter-swatches");
    this.widthsEl = this.dockEl.createDiv("defter-group");

    const history = this.dockEl.createDiv("defter-group");
    this.iconButton(history, "undo-2", T("Undo drawing (Ctrl+Z)"), () => this.undo());
    this.iconButton(history, "redo-2", T("Redo drawing (Ctrl+Y)"), () => this.redo());

    const nav = this.dockEl.createDiv("defter-group");
    this.iconButton(nav, "chevron-left", T("Previous page (Page Up)"), () => this.goTo(this.pageIndex - 1));
    this.counterEl = nav.createSpan("defter-counter");
    this.iconButton(nav, "chevron-right", T("Next page (Page Down)"), () => this.goTo(this.pageIndex + 1));
    this.iconButton(nav, "plus", T("New page after this one"), () => this.addPage());
    this.zoomEl = nav.createEl("button", { cls: "defter-zoom", attr: { "aria-label": T("Zoom (Ctrl+wheel). Click to fit the page."), "data-tooltip-position": "top" } });
    this.registerDomEvent(this.zoomEl, "click", (e) => this.zoomMenu(e));
    this.iconButton(nav, "help-circle", T("Keyboard shortcuts (F1)"), () => new HelpModal(this.app).open());
  }

  private zoomMenu(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(T("Fit the page (Ctrl+0)")).setIcon("maximize-2").onClick(() => this.setZoom(1)));
    for (const z of ZOOMS) menu.addItem((i) => i.setTitle(Math.round(z * 100) + "%").setChecked(Math.abs(z - this.zoom) < 0.01).onClick(() => this.setZoom(z)));
    menu.showAtMouseEvent(e);
  }

  private setZoom(z: number, at?: { x: number; y: number }) {
    const desk = this.deskEl;
    const before = this.holderEl.getBoundingClientRect();
    const d = desk.getBoundingClientRect();
    const ax = at?.x ?? d.left + d.width / 2;
    const ay = at?.y ?? d.top + d.height / 2;
    // Keep the point under the cursor in place.
    const fx = (ax - before.left) / Math.max(1, before.width);
    const fy = (ay - before.top) / Math.max(1, before.height);
    this.zoom = Math.max(0.5, Math.min(3, z));
    this.fitToPane();
    const after = this.holderEl.getBoundingClientRect();
    desk.scrollLeft += after.left + fx * after.width - ax;
    desk.scrollTop += after.top + fy * after.height - ay;
    this.pad?.draw();
  }

  private onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0022), { x: e.clientX, y: e.clientY });
  }

  private shapeMenu(e: MouseEvent) {
    const menu = new Menu();
    for (const s of SHAPE_DEFS) {
      menu.addItem((i) =>
        i
          .setTitle(T(s.label))
          .setIcon(s.icon)
          .setChecked(this.tool === "shape" && this.shapeKind === s.id)
          .onClick(() => {
            this.shapeKind = s.id;
            this.setTool("shape");
          })
      );
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(T("Shift: straight lines, squares, circles")).setDisabled(true));
    menu.addItem((i) => i.setTitle(T("Tip: with the pen, draw a shape and hold still")).setDisabled(true));
    menu.showAtMouseEvent(e);
  }

  private insertMenu(e: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(T("Picture…")).setIcon("image").setSection("insert").onClick(() => this.pickImage()));
    menu.addItem((i) => i.setTitle(T("Sticky note")).setIcon("sticky-note").setSection("insert").onClick(() => this.addNote()));
    menu.addItem((i) => i.setTitle(T("Hide tape (click to reveal)")).setIcon("rectangle-horizontal").setSection("insert").onClick(() => this.addTape()));
    menu.addItem((i) => i.setTitle(T("Stickers and stamps…")).setIcon("sticker").setSection("insert").onClick(() => this.openStickers()));
    menu.addItem((i) => i.setTitle(T("Formula…")).setIcon("sigma").setSection("insert").onClick(() => this.addFormula()));
    menu.addItem((i) => i.setTitle(T("PDF pages…")).setIcon("file-input").setSection("insert").onClick(() => this.importPdf()));
    menu.addItem((i) => i.setTitle(T("Tip: paste a screenshot with Ctrl+V")).setDisabled(true).setSection("insert"));
    for (const t of [null, ...TEMPLATES]) {
      menu.addItem((i) =>
        i
          .setTitle(t ? T("Template: {name}", { name: T(t.label) }) : T("Template: plain page"))
          .setIcon("layout-template")
          .setSection("template")
          .setChecked((this.page.tpl ?? null) === (t?.id ?? null))
          .onClick(() => this.setTemplate(t?.id))
      );
    }
    for (const c of MARK_COLORS) {
      menu.addItem((i) => {
        i.setTitle(T(this.page.mark === c ? "Bookmarked" : "Bookmark this page")).setIcon("bookmark").setSection("mark").onClick(() => this.setMark(c));
        const icon = (i as unknown as { iconEl?: HTMLElement }).iconEl;
        if (icon) icon.style.color = c;
      });
    }
    if (this.page.mark) menu.addItem((i) => i.setTitle(T("Remove bookmark")).setIcon("bookmark-minus").setSection("mark").onClick(() => this.setMark(undefined)));
    menu.showAtMouseEvent(e);
  }

  /** Keeps the write pad just above the pencil case, however tall it wraps. */
  private placePad() {
    if (this.pad) this.pad.el.style.bottom = this.dockEl.offsetHeight + 26 + "px";
  }

  private renderDockOptions() {
    requestAnimationFrame(() => this.placePad());
    this.swatchesEl.empty();
    this.widthsEl.empty();
    const colored = this.tool === "pen" || this.tool === "hl" || this.tool === "shape" || this.tool === "pad";
    this.swatchesEl.toggle(colored);
    this.widthsEl.toggle(this.tool === "pen" || this.tool === "shape" || this.tool === "pad");
    setIcon(this.toolButtons.shape!, SHAPE_DEFS.find((s) => s.id === this.shapeKind)!.icon);
    if (!colored) return;
    const hl = this.tool === "hl";
    const colors = hl ? HIGHLIGHTS : INKS.map((i) => i.id);
    const current = hl ? this.hlColor : this.penColor;
    for (const c of colors) {
      const b = this.swatchesEl.createEl("button", { cls: "defter-swatch" });
      b.style.setProperty("--swatch", hl ? c : inkFor(c, this.look.tone));
      b.setAttr("aria-label", T(hl ? "Highlighter colour" : INKS.find((i) => i.id === c)!.label));
      b.toggleClass("is-active", c === current);
      b.onclick = () => {
        if (hl) this.hlColor = c;
        else this.penColor = c;
        this.renderDockOptions();
      };
    }
    if (this.tool === "pen" || this.tool === "pad") {
      const def = PEN_DEFS.find((p) => p.id === this.penKind)!;
      const b = this.iconButton(this.widthsEl, def.icon, T("Pen: {name}", { name: T(def.label) }), (e) => {
        const menu = new Menu();
        for (const p of PEN_DEFS) {
          menu.addItem((i) =>
            i
              .setTitle(T(p.label))
              .setIcon(p.icon)
              .setChecked(p.id === this.penKind)
              .onClick(() => {
                this.penKind = p.id;
                this.renderDockOptions();
              })
          );
        }
        menu.showAtMouseEvent(e);
      });
      b.addClass("defter-penkind");
    }
    PEN_WIDTHS.forEach((w, i) => {
      const b = this.widthsEl.createEl("button", { cls: "defter-width" });
      b.style.setProperty("--dot", w * 2 + "px");
      b.setAttr("aria-label", T(["Fine", "Medium", "Bold"][i]));
      b.toggleClass("is-active", w === this.penWidth);
      b.onclick = () => {
        this.penWidth = w;
        this.renderDockOptions();
      };
    });
  }

  private setTool(tool: Tool) {
    if (tool !== "select") this.clearSelection();
    if (tool !== "pad" && this.pad) this.pad.close();
    this.tool = tool;
    if (tool === "pad" && !this.pad) this.openPad();
    for (const id of Object.keys(this.toolButtons) as Tool[]) this.toolButtons[id]!.toggleClass("is-active", id === tool);
    this.sheetEl.dataset.tool = tool;
    this.renderDockOptions();
    if (tool === "write") this.textEl.focus({ preventScroll: true });
    else {
      this.textEl.blur();
      this.contentEl.focus({ preventScroll: true });
    }
  }

  private sizeCanvases() {
    for (const c of [this.hlCanvas, this.inkCanvas]) {
      if (c.width === this.dims.w * 2 && c.height === this.dims.h * 2) continue;
      c.width = this.dims.w * 2;
      c.height = this.dims.h * 2;
      c.getContext("2d")!.setTransform(2, 0, 0, 2, 0, 0);
    }
  }

  /** Two pages side by side? */
  private wantSpread(): boolean {
    const mode = this.host.settings.spread;
    if (mode === "single") return false;
    if (mode === "spread") return true;
    const avail = this.deskEl.clientWidth - 48 - 40;
    return avail >= this.dims.w * 2 * 0.62 + 24;
  }

  private fitToPane() {
    const avail = this.deskEl.clientWidth - 48 - 40; // room for bookmark tabs
    if (avail <= 0) return;
    const spread = this.wantSpread();
    const per = spread ? (avail - 24) / 2 : avail;
    // Same zoom for every page size, so text looks the same and an A5 is a smaller page.
    const fit = Math.min(1.35, Math.max(0.3, per / 820), per / this.dims.w);
    const s = fit * this.zoom;
    this.sheetEl.style.transform = `scale(${s})`;
    const w = this.dims.w * s;
    this.holderEl.style.width = (spread ? w * 2 + 24 : w) + "px";
    this.holderEl.style.height = this.dims.h * s + "px";
    this.holderEl.toggleClass("is-spread", spread);
    this.deskEl.toggleClass("is-zoomed", this.zoom > 1.001);
    if (this.zoomEl) this.zoomEl.setText(Math.round(this.zoom * 100) + "%");
    this.layoutSpread(s);
  }

  // ---- Pages drawer (list + search) ----------------------------------------

  private buildDrawer(root: HTMLElement) {
    this.drawerEl = root.createDiv("defter-drawer");
    this.drawerEl.toggle(false);
    const head = this.drawerEl.createDiv("defter-drawer-head");
    this.searchEl = head.createEl("input", { type: "search", cls: "defter-search", attr: { placeholder: T("Search this notebook…") } });
    this.iconButton(head, "x", T("Close"), () => this.drawerEl.toggle(false));
    this.drawerTabs = this.drawerEl.createDiv("defter-drawer-tabs");
    for (const [id, label] of [["pages", "Pages"], ["grid", "Thumbnails"], ["todos", "To-dos"]] as const) {
      const b = this.drawerTabs.createEl("button", { text: T(label), attr: { "data-mode": id } });
      this.registerDomEvent(b, "click", () => {
        this.drawerMode = id;
        this.renderList();
      });
    }
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
    const mode = q ? "pages" : this.drawerMode;
    for (const b of Array.from(this.drawerTabs.children) as HTMLElement[]) b.toggleClass("is-active", b.dataset.mode === mode);
    this.listEl.toggleClass("is-grid", mode === "grid");
    if (mode === "grid") return this.renderGrid();
    if (mode === "todos") return this.renderTodos();
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
      const title = pageTitle(p.text) || T(p.ink.length || p.obj?.length ? "Drawing" : "Empty page");
      body.createDiv({ cls: "defter-page-title", text: title });
      if (p.date) body.createDiv({ cls: "defter-page-snippet", text: fmtDate(p.date, "ddd, D MMM YYYY") });
      if (q && at !== -1) {
        const from = Math.max(0, at - 24);
        const snip = body.createDiv("defter-page-snippet");
        snip.appendText((from ? "…" : "") + p.text.slice(from, at).replace(/\n/g, " "));
        snip.createEl("mark", { text: p.text.slice(at, at + q.length) });
        snip.appendText(p.text.slice(at + q.length, at + q.length + 40).replace(/\n/g, " "));
      } else if (q) {
        body.createDiv({ cls: "defter-page-snippet", text: T("Found in a sticky note") });
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
          const b = this.iconButton(tools, icon, T(t), (e) => {
            e.stopPropagation();
            fn();
          });
          b.toggleClass("is-disabled", !enabled);
        };
        btn("arrow-up", "Move up", () => this.movePage(i, -1), i > 0);
        btn("arrow-down", "Move down", () => this.movePage(i, 1), i < this.nb.pages.length - 1);
        btn("copy", "Duplicate page", () => this.duplicatePage(i), true);
        btn("trash-2", "Remove page (only when empty)", () => this.removePage(i), this.nb.pages.length > 1);
      }
    });
    if (!shown) this.listEl.createDiv({ cls: "defter-empty", text: q ? "No page contains this." : "No pages." });
  }

  /** Small pictures of every page, drawn when they scroll into view. */
  private renderGrid() {
    const scale = 0.17;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tile = en.target as HTMLElement;
        io.unobserve(tile);
        const i = Number(tile.dataset.i);
        const page = this.nb.pages[i];
        if (!page) continue;
        const sheet = renderStaticPage(this.app, tile.createDiv("defter-thumb-inner"), this.getDisplayText(), page, i + 1, this.look);
        sheet.style.transform = `scale(${scale})`;
      }
    }, { root: this.listEl });
    this.register(() => io.disconnect());
    this.nb.pages.forEach((p, i) => {
      const cell = this.listEl.createDiv("defter-thumb-cell");
      cell.toggleClass("is-current", i === this.pageIndex);
      const tile = cell.createDiv("defter-thumb");
      tile.style.width = this.dims.w * scale + "px";
      tile.style.height = this.dims.h * scale + "px";
      tile.dataset.i = String(i);
      if (p.mark) cell.style.setProperty("--mark", p.mark);
      cell.toggleClass("has-mark", !!p.mark);
      cell.createDiv({ cls: "defter-thumb-no", text: p.date ? `${i + 1} · ${fmtDate(p.date, "D MMM")}` : String(i + 1) });
      this.registerDomEvent(cell, "click", () => {
        this.goTo(i);
        this.renderList();
      });
      io.observe(tile);
    });
    (this.listEl.querySelector(".is-current") as HTMLElement | null)?.scrollIntoView({ block: "center" });
  }

  /** Every "[ ] item" in the notebook, open ones first. */
  private renderTodos() {
    const items: { page: number; at: number; text: string; done: boolean }[] = [];
    this.nb.pages.forEach((p, page) => {
      let at = 0;
      for (const line of p.text.split("\n")) {
        const m = /^(\s*(?:[-*] )?)\[([ xX])\] (.*)$/.exec(line);
        if (m) items.push({ page, at: at + m[1].length, text: m[3].replace(/\*\*|==|\[\[|\]\]/g, ""), done: m[2] !== " " });
        at += line.length + 1;
      }
    });
    if (!items.length) {
      this.listEl.createDiv({ cls: "defter-empty", text: T("No to-dos yet. Start a line with [ ] to make one.") });
      return;
    }
    items.sort((a, b) => Number(a.done) - Number(b.done) || a.page - b.page);
    const open = items.filter((t) => !t.done).length;
    this.listEl.createDiv({ cls: "defter-todo-sum", text: T("{open} open · {done} done", { open, done: items.length - open }) });
    for (const t of items) {
      const row = this.listEl.createDiv("defter-todo-row");
      row.toggleClass("is-done", t.done);
      const box = row.createEl("input", { type: "checkbox" });
      box.checked = t.done;
      this.registerDomEvent(box, "click", (e) => {
        e.stopPropagation();
        this.toggleCheckbox(t.page, t.at);
        this.renderList();
      });
      row.createSpan({ cls: "defter-todo-text", text: t.text || "(empty)" });
      row.createSpan({ cls: "defter-page-no", text: String(t.page + 1) });
      this.registerDomEvent(row, "click", () => {
        this.goTo(t.page);
        this.setTool("write");
        this.textEl.focus({ preventScroll: true });
        this.textEl.setSelectionRange(t.at + 4, t.at + 4);
      });
    }
  }

  // ---- Pages --------------------------------------------------------------

  private redrawObjects() {
    this.objEls = drawObjects(this.app, this.objLowEl, this.objHighEl, this.page, inkFor(this.look.ink, this.look.tone));
  }

  private showPage(i: number, direction?: number) {
    this.finishStroke();
    this.clearSelection();
    if (direction && i !== this.pageIndex) this.turnPage(direction);
    this.pageIndex = i;
    const page = this.page;
    applyBox(this.sheetEl, pageBox(page, this.dims));
    if (page.tpl) this.sheetEl.dataset.tpl = page.tpl;
    else delete this.sheetEl.dataset.tpl;
    drawDecor(this.app, this.decorEl, page, this.dims, this.getDisplayText());
    if (page.bg) this.sheetEl.dataset.bg = "1";
    else delete this.sheetEl.dataset.bg;
    this.redrawObjects();
    this.renderTabs();
    const text = page.text;
    this.textEl.value = text;
    this.prevText = text;
    this.textEl.placeholder =
      i === 0 && this.nb.pages.length === 1 && !page.tpl ? T("Start writing… (# heading, **bold**, ==mark==, - list, [[link]], [ ] to-do, front :: back card)") : "";
    this.mirrorEl.empty();
    this.spans = [];
    this.spliceSpans(0, 0, text, false);
    this.restyle(0, text.length);
    this.redrawInk();
    this.updateCounter();
    this.pageNoEl.setText(String(i + 1));
    if (this.file) this.host.rememberPage(this.file.path, i);
    this.applyStudy();
    this.renderPartner();
    // A larger font or a template can push text past the bottom: carry it on.
    this.fitText(false);
    this.renderList();
  }

  private updateCounter() {
    const label = `${this.pageIndex + 1} / ${this.nb.pages.length}`;
    this.counterEl.setText(label);
    const date = this.page.date;
    this.chipEl?.setText(date ? `${fmtDate(date, "D MMM")} · ${label}` : T("p. {n}", { n: label }));
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
      tab.setAttr("aria-label", pageTitle(p.text) || T("Page {n}", { n: i + 1 }));
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

  private goTo(i: number, turn = true) {
    if (i < 0 || i >= this.nb.pages.length || i === this.pageIndex) return;
    // Within an open spread the other page is already in view: no page turn.
    const sameSpread = this.partnerEl && Math.floor(i / 2) === Math.floor(this.pageIndex / 2);
    this.showPage(i, turn && !sameSpread ? (i > this.pageIndex ? 1 : -1) : undefined);
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
      new Notice(T("Clear the page before removing it."));
      return;
    }
    this.nb.pages.splice(i, 1);
    this.undoStack = [];
    this.redoStack = [];
    this.requestSave();
    this.showPage(Math.min(i <= this.pageIndex ? Math.max(0, this.pageIndex - 1) : this.pageIndex, this.nb.pages.length - 1), -1);
  }

  private duplicatePage(i: number) {
    const copy = clone(this.nb.pages[i]);
    delete copy.mark;
    this.nb.pages.splice(i + 1, 0, copy);
    this.undoStack = [];
    this.redoStack = [];
    this.requestSave();
    this.goTo(i + 1);
    new Notice(T("Page {n} duplicated.", { n: i + 1 }));
  }

  /** A page that only holds text carried over from the page before. */
  private isPlainText(p: Page, date: string | undefined) {
    return !p.ink.length && !p.obj?.length && !p.tpl && !p.mark && !p.bg && p.date === date;
  }

  /**
   * After the text got smaller or the page bigger, pulls the text of the
   * following text-only pages back and lets it flow over the pages again.
   */
  private reflow() {
    const i = this.pageIndex;
    const pages = this.nb.pages;
    const date = this.page.date;
    let text = this.page.text;
    let n = 0;
    while (pages[i + 1 + n] && this.isPlainText(pages[i + 1 + n], date)) {
      const next = pages[i + 1 + n].text;
      // A page split inside a paragraph ends with the space before the next word.
      text = text.endsWith(" ") || !text ? text + next : text + "\n" + next;
      n++;
    }
    if (!n) {
      new Notice(T("The next page has drawings, a template or a bookmark, so nothing was moved."));
      return;
    }
    const before = pages.length;
    pages.splice(i + 1, n);
    this.page.text = text;
    this.undoStack = [];
    this.redoStack = [];
    this.showPage(i);
    // Let the text flow over as many pages as it needs (never more than before).
    for (let j = i + 1; j < pages.length && j <= i + n; j++) {
      if (!this.isPlainText(pages[j], date)) break;
      this.showPage(j);
    }
    this.showPage(i);
    this.requestSave();
    new Notice(before - pages.length > 0 ? T("Done: {n} page(s) fewer.", { n: before - pages.length }) : T("Done: pages refilled."));
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
        if (/\b(sup|sub)\b/.test(flags[i])) el.dataset.c = el.textContent ?? "";
        else delete el.dataset.c;
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

  private onTextInput(e?: InputEvent) {
    // Maths shortcuts: \sqrt → √, <= → ≤ … (typing only, never on paste).
    if ((e?.inputType === "insertText" || e?.inputType === "insertLineBreak") && this.host.settings.mathShortcuts) {
      const ta = this.textEl;
      const r = shortcutAt(ta.value, ta.selectionStart);
      if (r && ta.selectionStart === ta.selectionEnd) {
        const after = ta.selectionStart - r[1]; // the typed terminator, if any
        ta.setSelectionRange(r[0], r[1]);
        // execCommand keeps the text field's own undo working.
        document.execCommand("insertText", false, r[2]);
        const caret = r[0] + r[2].length + after;
        ta.setSelectionRange(caret, caret);
        return;
      }
    }
    if (e?.inputType === "insertText" && e.data?.trim()) this.host.sound.stroke(this.host.settings.penSound, this.host.settings.penVolume);
    this.syncMirror(true);
    this.fitText(true);
    this.requestSave();
    this.renderCardsBtn();
    if (this.studyMode) this.applyStudy();
  }

  /** Tab after "12*3+4 =" writes the result. */
  private onTextKey(e: KeyboardEvent) {
    if (e.key !== "Tab" || e.shiftKey || e.ctrlKey || e.altKey || !this.host.settings.calculator) return;
    const ta = this.textEl;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return;
    const start = ta.value.lastIndexOf("\n", pos - 1) + 1;
    const res = calcLine(ta.value.slice(start, pos));
    if (!res) return;
    e.preventDefault();
    const gap = ta.value[pos - 1] === " " ? "" : " ";
    document.execCommand("insertText", false, gap + res.answer);
  }

  /** Inserts text at the caret (switching to writing), caret moved back by `back`. */
  insertAtCaret(text: string, back = 0) {
    if (this.tool !== "write") this.setTool("write");
    const ta = this.textEl;
    ta.focus({ preventScroll: true });
    document.execCommand("insertText", false, text);
    if (back) ta.setSelectionRange(ta.selectionStart - back, ta.selectionStart - back);
  }

  private mathPanel: HTMLElement | null = null;

  /** The Σ panel: symbols to click, grouped, with their typing shortcuts. */
  private toggleMathPanel() {
    if (this.mathPanel) {
      this.mathPanel.remove();
      this.mathPanel = null;
      return;
    }
    const panel = this.contentEl.createDiv("defter-math-panel");
    this.mathPanel = panel;
    const short: Record<string, string> = {};
    for (const [k, v] of Object.entries(MATH_NAMED)) short[v] ??= "\\" + k;
    for (const [op, sym] of MATH_OPERATORS) short[sym] ??= op;
    const groups: [string, string[]][] = [
      ["Basic", ["√()", "∛()", "x²", "x³", "^", "_", "½", "π", "°", "±", "×", "÷", "·", "%"]],
      ["Compare", ["=", "≠", "≈", "<", ">", "≤", "≥", "∞"]],
      ["Logic and sets", ["→", "⇒", "⇔", "∈", "∉", "⊂", "∪", "∩", "∅", "∀", "∃", "ℝ", "ℕ", "ℤ", "ℚ"]],
      ["Geometry", ["∠", "⊥", "∥", "△", "°"]],
      ["Greek", ["α", "β", "γ", "δ", "Δ", "θ", "λ", "μ", "σ", "Σ", "ω", "Ω", "φ", "ε", "∑", "∫"]],
    ];
    for (const [title, syms] of groups) {
      panel.createDiv({ cls: "defter-math-title", text: T(title) });
      const grid = panel.createDiv("defter-math-grid");
      for (const sym of syms) {
        const b = grid.createEl("button", { cls: "defter-math-key", text: sym.replace("x²", "x²").replace("()", "") });
        const tip = short[sym.replace("()", "")];
        if (tip) b.setAttr("aria-label", tip);
        b.onmousedown = (e) => e.preventDefault();
        b.onclick = () => {
          if (sym.endsWith("()")) this.insertAtCaret(sym, 1);
          else if (sym === "x²") this.insertAtCaret("²");
          else if (sym === "x³") this.insertAtCaret("³");
          else this.insertAtCaret(sym);
        };
      }
    }
    const foot = panel.createDiv("defter-math-foot");
    foot.createDiv({ text: T("Type \\sqrt, \\pi, <=, != … and they turn into symbols. x^2 is drawn small and high.") });
    if (this.host.settings.calculator) foot.createDiv({ text: T("Calculator: write 12*3+4 = and press Tab.") });
    const f = foot.createEl("button", { text: T("Formula…") });
    f.onclick = () => {
      this.toggleMathPanel();
      this.addFormula();
    };
  }

  private toggleCheckbox(page: number, at: number) {
    const p = this.nb.pages[page];
    const mark = p.text[at + 1] === " " ? "x" : " ";
    p.text = p.text.slice(0, at + 1) + mark + p.text.slice(at + 2);
    if (page === this.pageIndex) {
      const ta = this.textEl;
      const [a, b] = [ta.selectionStart, ta.selectionEnd];
      ta.value = p.text;
      this.syncMirror(false);
      ta.setSelectionRange(a, b);
    }
    this.requestSave();
  }

  private onTextClick(e: MouseEvent) {
    const pos = this.textEl.selectionStart;
    if (this.textEl.selectionEnd === pos && !e.shiftKey) {
      const box = checkboxAt(this.textEl.value, pos);
      if (box !== null) {
        this.toggleCheckbox(this.pageIndex, box);
        this.textEl.setSelectionRange(box + 4, box + 4);
        return;
      }
      if (this.studyMode && this.revealAt(pos, e)) return;
    }
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
    if (this.partnerIndex === this.pageIndex + 1) this.renderPartner();
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
    this.warnPlain("This notebook is private, but pictures are saved as separate files and are not encrypted.");
    try {
      const img = await saveImage(this.app, blob, this.file);
      const s = Math.min(1, (this.dims.w * 0.6) / img.w, (this.dims.h * 0.5) / img.h);
      const w = Math.round(img.w * s);
      const h = Math.round(img.h * s);
      const [cx, cy] = this.visibleCentre();
      this.addObject({ k: "img", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, v: img.path });
    } catch (e) {
      new Notice(T("Could not add the picture: ") + (e as Error).message);
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
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (clipboard && text === CLIP_MARK + clipboard.id) {
      e.preventDefault();
      this.pasteClipboard();
      return;
    }
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

  private addTape() {
    const [cx, cy] = this.visibleCentre();
    this.addObject({ k: "tape", x: Math.round(cx - 150), y: Math.round(cy - 20), w: 300, h: 40, v: "", c: TAPE_COLORS[0] });
  }

  /** Tape is clicked open and shut in every tool but select. */
  private onObjectClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest(".defter-obj-tape") as HTMLElement | null;
    if (!el || this.tool === "select") return;
    el.toggleClass("is-open", !el.hasClass("is-open"));
  }

  private openStickers() {
    new StickerModal(
      this.app,
      this.host.settings.stickers,
      this.look.tone,
      (p) => {
        const [cx, cy] = this.visibleCentre();
        if ("stamp" in p) {
          const sym = [...p.stamp].length <= 2;
          const h = sym ? 64 : 52;
          const w = sym ? 64 : Math.max(90, Math.round(p.stamp.length * h * 0.42 * 0.68 + 36));
          this.addObject({ k: "stamp", x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, v: p.stamp, c: p.color });
          return;
        }
        this.pasteItems(clone(p.sticker.ink), clone(p.sticker.obj), cx - p.sticker.w / 2, cy - p.sticker.h / 2, true);
      },
      (st) => {
        this.host.settings.stickers = this.host.settings.stickers.filter((x) => x.id !== st.id);
        void this.host.saveSettings();
      }
    ).open();
  }

  private saveSticker() {
    const b = this.selectionBounds();
    if (!b) return;
    const ink = clone([...this.sel.strokes]);
    const obj = clone([...this.sel.objs]);
    const dx = -b.x1, dy = -b.y1;
    for (const st of ink) for (let i = 0; i < st.p.length; i += 2) (st.p[i] += dx), (st.p[i + 1] += dy);
    for (const o of obj) (o.x += dx), (o.y += dy);
    const sticker: Sticker = { id: Date.now().toString(36), ink, obj, w: Math.round(b.x2 - b.x1), h: Math.round(b.y2 - b.y1) };
    this.host.settings.stickers.push(sticker);
    void this.host.saveSettings();
    new Notice(T("Saved as a sticker. Find it under Insert → Stickers, in every notebook."));
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
      menu.addItem((i) => i.setTitle(T("Edit text")).setIcon("pencil").onClick(() => this.editNote(o)));
      for (const c of NOTE_COLORS) {
        menu.addItem((i) => {
          i.setTitle(T("Note colour")).setIcon("square").setSection("colour").onClick(() => {
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
    if (o.k === "tape" || o.k === "stamp") {
      for (const c of o.k === "tape" ? TAPE_COLORS : STAMP_COLORS) {
        menu.addItem((i) => {
          i.setTitle(T(o.k === "tape" ? "Tape colour" : "Stamp colour")).setIcon("square").setSection("colour").onClick(() => {
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
        i.setTitle(T("Edit formula")).setIcon("pencil").onClick(() =>
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
        .setTitle(T("Delete"))
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
    if (!this.drag) this.selectionBar(b);
    this.selEl.toggle(true);
  }

  /** Floating bar over a selection: colour, copy, duplicate, sticker, delete. */
  private selectionBar(b: { x1: number; y1: number; x2: number; y2: number }) {
    const bar = this.selEl.createDiv("defter-sel-bar");
    bar.style.left = Math.max(4, b.x1) + "px";
    bar.style.top = (b.y1 > 60 ? b.y1 - 52 : b.y2 + 10) + "px";
    const stop = (el: HTMLElement) => el.addEventListener("pointerdown", (e) => e.stopPropagation());
    stop(bar);
    if (this.sel.strokes.size) {
      for (const ink of INKS) {
        const sw = bar.createEl("button", { cls: "defter-swatch", attr: { "aria-label": T("Recolour: {name}", { name: T(ink.label) }) } });
        sw.style.setProperty("--swatch", inkFor(ink.id, this.look.tone));
        sw.onclick = () => this.recolor(ink.id);
      }
    }
    const btn = (icon: string, label: string, fn: () => void) => {
      const el = bar.createEl("button", { cls: "defter-btn clickable-icon", attr: { "aria-label": T(label) } });
      setIcon(el, icon);
      el.onclick = fn;
    };
    btn("copy", "Copy (Ctrl+C)", () => this.copySelection());
    btn("copy-plus", "Duplicate (Ctrl+D)", () => this.duplicateSelection());
    btn("sticker", "Save as sticker", () => this.saveSticker());
    btn("trash-2", "Delete", () => this.deleteSelection());
  }

  private recolor(color: string) {
    this.snapshot();
    for (const st of this.sel.strokes) if (st.t === "pen") st.c = color;
    this.requestSave();
    this.redrawInk();
    this.renderSelection();
  }

  private copySelection() {
    if (!this.sel.strokes.size && !this.sel.objs.size) return;
    const id = Date.now().toString(36);
    clipboard = { id, ink: clone([...this.sel.strokes]), obj: clone([...this.sel.objs]) };
    // The system clipboard gets a marker, so Ctrl+V knows our drawing is the newest copy.
    void navigator.clipboard.writeText(CLIP_MARK + id).catch(() => undefined);
    new Notice(T("Copied. Paste with Ctrl+V on any page."));
  }

  private duplicateSelection() {
    if (!this.sel.strokes.size && !this.sel.objs.size) return;
    this.pasteItems(clone([...this.sel.strokes]), clone([...this.sel.objs]), 24, 24, false);
  }

  /** Adds strokes and objects, moved by dx,dy (or placed with their corner at dx,dy). */
  private pasteItems(ink: Stroke[], obj: PageObject[], dx: number, dy: number, absolute: boolean) {
    if (absolute) {
      const pts: number[] = [];
      for (const st of ink) pts.push(...strokePoints(st));
      for (const o of obj) pts.push(o.x, o.y, o.x + o.w, o.y + o.h);
      const bb = pts.length ? bounds(pts) : { x1: 0, y1: 0 };
      dx -= bb.x1;
      dy -= bb.y1;
    }
    this.snapshot();
    for (const st of ink) for (let i = 0; i < st.p.length; i += 2) (st.p[i] += dx), (st.p[i + 1] += dy);
    for (const o of obj) (o.x = Math.round(o.x + dx)), (o.y = Math.round(o.y + dy));
    this.page.ink.push(...ink);
    if (obj.length) (this.page.obj ??= []).push(...obj);
    this.requestSave();
    this.redrawInk();
    this.redrawObjects();
    this.setTool("select");
    this.sel = { strokes: new Set(ink), objs: new Set(obj) };
    this.renderSelection();
  }

  /**
   * Ctrl+V outside the text: the newest copy wins. A picture copied after our
   * drawing is pasted as a picture, otherwise the copied drawing.
   */
  private async pasteFromKeyboard() {
    let image: Blob | null = null;
    let text = "";
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type && !image) image = await item.getType(type);
        if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      }
    } catch {
      /* clipboard not readable: fall back to our own copy */
    }
    if (clipboard && (text === CLIP_MARK + clipboard.id || !image)) this.pasteClipboard();
    else if (image) await this.placeImage(image);
  }

  private pasteClipboard() {
    if (!clipboard) return;
    const ink = clone(clipboard.ink);
    const obj = clone(clipboard.obj);
    // Same page: offset so the copy is visible; another page: same place.
    const here = this.page.ink.some((st) => ink.some((c) => JSON.stringify(c.p) === JSON.stringify(st.p)));
    this.pasteItems(ink, obj, here ? 24 : 0, here ? 24 : 0, false);
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

  /** Once a stylus was used, fingers scroll and palms are ignored. */
  private stylusSeen = false;

  private onPointerDown(e: PointerEvent) {
    if (e.pointerType === "pen" && !this.stylusSeen) {
      this.stylusSeen = true;
      this.sheetEl.dataset.stylus = "1";
    }
    if (e.pointerType === "touch" && this.stylusSeen) return;
    if (this.tool === "write") return;
    if (this.tool === "pad") {
      const [x, y] = this.point(e);
      if (e.button === 0) this.pad?.setTarget(x, y);
      return;
    }
    if (e.button === 2) {
      const [x, y] = this.point(e);
      const hit = hitObject(this.page.obj ?? [], x, y);
      if (hit) this.objectMenu(e, hit.obj);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    this.contentEl.focus({ preventScroll: true });
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
    this.snapped = false;
    if (this.tool === "shape" || (this.tool === "pen" && e.shiftKey)) {
      this.stroke = this.newPenStroke(x, y);
      this.stroke.s = this.tool === "shape" ? this.shapeKind : "line";
      this.stroke.p = [x, y, x, y];
      if (this.stroke.y === "fountain") delete this.stroke.y;
    } else if (this.tool === "hl") {
      this.stroke = { t: "hl", c: this.hlColor, w: HL_WIDTH, p: [x, y] };
    } else {
      this.stroke = this.newPenStroke(x, y);
      if (e.pointerType === "pen" && e.pressure > 0) this.stroke.q = [Math.round(e.pressure * 100) / 100];
      this.armHold();
    }
    this.queueDraw();
  }

  private newPenStroke(x: number, y: number): Stroke {
    const st: Stroke = { t: "pen", c: this.penColor, w: this.penWidth, p: [x, y] };
    if (this.penKind !== "ball") st.y = this.penKind;
    return st;
  }

  /** Draw and hold still: the freehand line becomes a clean shape. */
  private armHold() {
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => {
      const st = this.stroke;
      if (!st || st.s || st.t !== "pen" || this.snapped) return;
      const shape = recognizeShape(st.p);
      if (!shape) return;
      st.s = shape.s;
      st.p = shape.p;
      delete st.q;
      if (st.y === "fountain") delete st.y;
      this.snapped = true;
      this.queueDraw();
    }, HOLD_MS);
  }

  private onPointerMove(e: PointerEvent) {
    if (e.pointerType === "touch" && this.stylusSeen) return;
    if (this.drag) {
      this.onDragMove(e);
      return;
    }
    if (this.erasing) {
      const [x, y] = this.point(e);
      this.eraseAlong(x, y);
      return;
    }
    if (!this.stroke || this.snapped) return;
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
        if (dx * dx + dy * dy >= 2.25) {
          p.push(x, y);
          this.stroke.q?.push(Math.round((ev.pressure || 0.5) * 100) / 100);
        }
      }
      this.host.sound.stroke(this.host.settings.penSound, this.host.settings.penVolume * (this.stroke.t === "hl" ? 0.6 : 1), 1.4);
      // Still moving: restart the hold timer.
      if (this.stroke.t === "pen") this.armHold();
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
    window.clearTimeout(this.holdTimer);
    if (!this.stroke) return;
    const s = this.stroke;
    this.stroke = null;
    if (!s.s && s.t === "pen" && !s.q) s.p = smoothPoints(s.p);
    if (s.s && s.s !== "poly" && Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]) < 3) {
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
    if ((e.target as HTMLElement).hasClass?.("defter-note-edit")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && ["1", "2", "3", "4", "5", "6", "7"].includes(e.key)) {
      e.preventDefault();
      this.setTool((["write", "pen", "hl", "erase", "shape", "select", "pad"] as Tool[])[Number(e.key) - 1]);
      return;
    }
    if (e.altKey && !mod && e.code === "KeyF") {
      e.preventDefault();
      this.toggleFocus();
      return;
    }
    if (e.altKey && !mod && e.code === "KeyS") {
      e.preventDefault();
      this.toggleStudy();
      return;
    }
    if (e.key === "F1") {
      e.preventDefault();
      new HelpModal(this.app).open();
      return;
    }
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      this.setZoom(this.zoom * 1.2);
      return;
    }
    if (mod && e.key === "-") {
      e.preventDefault();
      this.setZoom(this.zoom / 1.2);
      return;
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      this.setZoom(1);
      return;
    }
    if (this.tool !== "write" && mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void this.pasteFromKeyboard();
      return;
    }
    if (this.tool === "select" && mod) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        e.preventDefault();
        this.copySelection();
        return;
      }
      if (k === "d") {
        e.preventDefault();
        this.duplicateSelection();
        return;
      }

      if (k === "a") {
        e.preventDefault();
        this.sel = { strokes: new Set(this.page.ink), objs: new Set(this.page.obj ?? []) };
        this.renderSelection();
        return;
      }
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
      if (this.focusMode) this.toggleFocus();
      else if (this.drawerEl.isShown()) this.drawerEl.toggle(false);
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

  /** Opens a page from outside (flashcard source link). */
  jumpTo(page: number) {
    if (page >= 0 && page < this.nb.pages.length) this.goTo(page);
  }

  // ---- Study tools ------------------------------------------------------------

  private renderCardsBtn() {
    const n = parseCards(this.nb.pages).length;
    this.cardsBtn?.toggleClass("has-count", n > 0);
    this.cardsBtn?.setAttr("data-count", n ? String(n) : "");
  }

  private studyCards() {
    if (!this.file) return;
    const path = this.file.path;
    const cards = parseCards(this.nb.pages);
    if (!cards.length) {
      new Notice(T("No flashcards yet. Write a line like “mol :: 6.02 × 10²³ particles”, then press this again."), 8000);
      return;
    }
    const today = todayStr();
    const due = cards.filter((c) => isDue(this.host.cardState(path, c.front), today));
    if (!due.length) {
      new Notice(T("All {n} cards are learned for today. Come back tomorrow.", { n: cards.length }));
      return;
    }
    new StudyModal(this.app, due.map((card) => ({ card, path, notebook: this.getDisplayText() })), this.host).open();
  }

  private toggleStudy() {
    this.studyMode = !this.studyMode;
    this.revealed.clear();
    this.studyBtn?.toggleClass("is-active", this.studyMode);
    this.sheetEl.toggleClass("is-study", this.studyMode);
    this.applyStudy();
    new Notice(T(this.studyMode ? "Study mode: highlighted text and card answers are hidden. Click to reveal." : "Study mode off."));
  }

  /** Character ranges hidden in study mode: ==marks==, card answers and text under highlighter. */
  private hiddenRuns(): { key: string; from: number; to: number }[] {
    const text = this.textEl.value;
    const runs: { key: string; from: number; to: number }[] = [];
    let at = 0;
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(/==(?=\S)(.+?)==/g)) runs.push({ key: "t" + (at + m.index!), from: at + m.index! + 2, to: at + m.index! + m[0].length - 2 });
      const c = line.indexOf(" :: ");
      if (c > 0) runs.push({ key: "t" + (at + c), from: at + c + 4, to: at + line.length });
      at += line.length + 1;
    }
    // Letters under a highlighter stroke.
    const hl = this.page.ink.filter((st) => st.t === "hl");
    if (hl.length) {
      const sheet = this.sheetEl.getBoundingClientRect();
      const scale = sheet.width / this.dims.w || 1;
      hl.forEach((st, k) => {
        // Sample the line every few units: a straight swipe has only two points.
        const raw = strokePoints(st);
        const pts: number[] = [];
        for (let j = 0; j + 3 < raw.length || j === 0; j += 2) {
          const [ax, ay, bx, by] = [raw[j], raw[j + 1], raw[j + 2] ?? raw[j], raw[j + 3] ?? raw[j + 1]];
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
          for (let k = 0; k <= n; k++) pts.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
          if (raw.length <= 2) break;
        }
        const r = st.w / 2 + 2;
        let from = -1, to = -1;
        this.spans.forEach((sp, i) => {
          if (!sp.textContent?.trim()) return;
          const b = sp.getBoundingClientRect();
          const cx = (b.left + b.width / 2 - sheet.left) / scale;
          const cy = (b.top + b.height * 0.55 - sheet.top) / scale;
          for (let j = 0; j < pts.length; j += 2) {
            if (Math.abs(pts[j] - cx) <= r && Math.abs(pts[j + 1] - cy) <= r) {
              if (from === -1) from = i;
              to = i + 1;
              return;
            }
          }
        });
        if (from !== -1) runs.push({ key: "s" + k, from, to });
      });
    }
    return runs;
  }

  private applyStudy() {
    for (const sp of this.spans) sp.removeClass("is-hidden");
    if (!this.studyMode) {
      this.redrawInk();
      return;
    }
    for (const r of this.hiddenRuns()) {
      if (this.revealed.has(r.key)) continue;
      for (let i = r.from; i < r.to; i++) this.spans[i]?.addClass("is-hidden");
    }
    this.redrawInk();
  }

  private revealAt(pos: number, e: MouseEvent): boolean {
    for (const r of this.hiddenRuns()) {
      if (pos < r.from - 1 || pos > r.to + 1) continue;
      if (this.revealed.has(r.key)) this.revealed.delete(r.key);
      else this.revealed.add(r.key);
      this.applyStudy();
      e.preventDefault();
      return true;
    }
    return false;
  }

  // ---- View modes -------------------------------------------------------------

  private toggleFocus() {
    this.focusMode = !this.focusMode;
    this.containerEl.toggleClass("defter-focus", this.focusMode);
    if (this.focusMode) new Notice(T("Focus mode. Esc or Alt+F to leave."));
    requestAnimationFrame(() => this.fitToPane());
  }

  // ---- PDF pages and page images ----------------------------------------------------

  private importPdf() {
    if (!this.file) return;
    this.warnPlain("This notebook is private, but imported PDF pages are saved as pictures and are not encrypted.");
    importPdf(this.app, this.file, (imported) => {
      if (!imported.length) return;
      const empty = this.nb.pages.length === 1 && !this.page.text.trim() && !this.page.ink.length && !this.page.obj?.length && !this.page.bg;
      const pages: Page[] = imported.map((im) => ({ text: T(""), ink: [], bg: im.path }));
      if (empty) this.nb.pages.splice(0, 1, ...pages);
      else this.nb.pages.splice(this.pageIndex + 1, 0, ...pages);
      this.undoStack = [];
      this.redoStack = [];
      this.requestSave();
      const first = empty ? 0 : this.pageIndex + 1;
      if (empty) this.showPage(0);
      else this.goTo(first);
      new Notice(T("{n} PDF page(s) added. Write or draw on them like any page.", { n: imported.length }));
    });
  }

  /** Copies the page to the clipboard or saves it next to the notebook as a PNG. */
  private async pageImage(mode: "copy" | "save") {
    this.warnPlain("The page image is not encrypted.");
    const remote = getRemote();
    if (!remote) {
      new Notice(T("Page images need the Obsidian desktop app."));
      return;
    }
    this.finishStroke();
    const cover = document.body.createDiv("defter-capture");
    try {
      const sheet = renderStaticPage(this.app, cover, this.getDisplayText(), this.page, this.pageIndex + 1, this.look);
      const s = Math.min((window.innerWidth - 40) / this.dims.w, (window.innerHeight - 40) / this.dims.h);
      sheet.style.transform = `scale(${s})`;
      await document.fonts.ready;
      await Promise.all([...cover.querySelectorAll("img")].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
      await new Promise((r) => setTimeout(r, 120));
      const r = sheet.getBoundingClientRect();
      const img = await remote.getCurrentWebContents().capturePage({ x: Math.round(r.left), y: Math.round(r.top), width: Math.floor(r.width), height: Math.floor(r.height) });
      const png = img.toPNG();
      if (mode === "copy") {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
        } catch {
          // The web clipboard needs a focused window; Electron's own does not.
          this.electronCopy(png);
        }
        new Notice(T("Page copied as an image."));
      } else if (this.file) {
        const name = `${this.getDisplayText()} p${this.pageIndex + 1}.png`;
        const path = await this.app.fileManager.getAvailablePathForAttachment(name, this.file.path);
        await this.app.vault.createBinary(normalizePath(path), new Uint8Array(png).buffer);
        new Notice(T("Saved {path}", { path }));
      }
    } catch (e) {
      new Notice(T("Could not make the image: ") + (e as Error).message);
    } finally {
      cover.remove();
    }
  }

  private electronCopy(png: Uint8Array) {
    if (!Platform.isDesktopApp) return;
    const electron = (window as unknown as { require: (m: string) => ElectronClip }).require("electron");
    const buf = (window as unknown as { require: (m: string) => { Buffer: { from(a: Uint8Array): unknown } } }).require("buffer").Buffer.from(png);
    electron.clipboard.writeImage(electron.nativeImage.createFromBuffer(buf));
  }

  // ---- Write pad ---------------------------------------------------------------

  private openPad() {
    this.drawerEl.toggle(false);
    this.pad = new WritePad(this.contentEl, {
      sheetEl: this.sheetEl,
      dims: () => this.dims,
      page: () => this.page,
      tone: () => this.look.tone,
      startAt: () => {
        const box = pageBox(this.page, this.dims);
        // First line under the typed text and under any ink.
        const textLines = Math.ceil((this.mirrorEl.scrollHeight || 0) / LINE);
        let inkBottom = 0;
        for (const st of this.page.ink) for (let i = 1; i < st.p.length; i += 2) inkBottom = Math.max(inkBottom, st.p[i]);
        const inkRow = inkBottom ? Math.ceil((inkBottom - TEXT_TOP) / LINE) : 0;
        const row = Math.min(Math.max(textLines, inkRow, 0), box.lines - 1);
        return { left: box.left, row };
      },
      beginStroke: (x, y) => {
        this.snapshot();
        this.stroke = this.newPenStroke(x, y);
        this.queueDraw();
      },
      extendStroke: (x, y) => {
        const st = this.stroke;
        if (!st) return;
        const p = st.p;
        const dx = x - p[p.length - 2];
        const dy = y - p[p.length - 1];
        if (dx * dx + dy * dy >= 0.36) p.push(x, y);
        this.queueDraw();
      },
      endStroke: () => {
        const st = this.stroke;
        if (!st) return null;
        if (st.p.length === 2) st.p.push(st.p[0] + 0.5, st.p[1]);
        const right = Math.max(...st.p.filter((_, i) => i % 2 === 0));
        this.finishStroke();
        return right;
      },
      liveStroke: () => this.stroke,
      undo: () => this.undo(),
      speed: () => this.host.settings.padSpeed,
      closed: () => {
        this.pad = null;
        if (this.tool === "pad") this.setTool("write");
      },
    });
    this.placePad();
  }

  // ---- Spread and page turn ------------------------------------------------------

  /** The facing page of a two-page spread, drawn read-only; click it to write there. */
  private renderPartner() {
    const spread = this.holderEl.hasClass("is-spread");
    const partner = this.pageIndex % 2 === 0 ? this.pageIndex + 1 : this.pageIndex - 1;
    if (!spread) {
      this.partnerEl?.remove();
      this.partnerEl = null;
      this.partnerIndex = -1;
      this.sheetEl.removeClass("is-right");
      return;
    }
    this.partnerEl?.remove();
    this.partnerIndex = partner;
    const wrap = this.holderEl.createDiv("defter-partner");
    this.partnerEl = wrap;
    const page = this.nb.pages[partner];
    if (page) {
      renderStaticPage(this.app, wrap, this.getDisplayText(), page, partner + 1, this.look);
      wrap.setAttr("aria-label", T("Page {n}: click to write here", { n: partner + 1 }));
      wrap.onclick = () => this.goTo(partner, false);
    } else {
      const blank = wrap.createDiv("defter-sheet defter-static-sheet defter-blank-page");
      applyDims(blank, this.dims);
      blank.dataset.paper = this.look.paper;
      blank.dataset.tone = this.look.tone;
      blank.createDiv({ cls: "defter-blank-hint", text: T("+ New page") });
      wrap.onclick = () => this.addPage();
    }
    this.layoutSpread();
  }

  private layoutSpread(scale?: number) {
    const spread = this.holderEl.hasClass("is-spread");
    if (!spread) {
      this.sheetEl.style.left = "0px";
      if (this.partnerEl) this.renderPartner();
      return;
    }
    if (!this.partnerEl) {
      this.renderPartner();
      return;
    }
    const s = scale ?? (this.sheetEl.getBoundingClientRect().width / this.dims.w || 1);
    const w = this.dims.w * s;
    const right = this.pageIndex % 2 === 1;
    this.sheetEl.toggleClass("is-right", right);
    this.sheetEl.style.left = (right ? w + 24 : 0) + "px";
    const inner = this.partnerEl.firstElementChild as HTMLElement | null;
    this.partnerEl.style.left = (right ? 0 : w + 24) + "px";
    this.partnerEl.style.width = w + "px";
    this.partnerEl.style.height = this.dims.h * s + "px";
    this.partnerEl.toggleClass("is-left", right);
    if (inner) inner.style.transform = `scale(${s})`;
  }

  /** A copy of the old page swings over its spine edge while the new one shows. */
  private turnPage(direction: number) {
    if (!this.host.settings.pageTurn || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!this.sheetEl.isShown() || !this.nb.pages[this.pageIndex]) return;
    this.turnEl?.remove();
    const r = this.sheetEl.getBoundingClientRect();
    const h = this.holderEl.getBoundingClientRect();
    const wrap = this.holderEl.createDiv("defter-turn " + (direction > 0 ? "is-next" : "is-prev"));
    wrap.style.left = r.left - h.left + "px";
    wrap.style.top = r.top - h.top + "px";
    wrap.style.width = r.width + "px";
    wrap.style.height = r.height + "px";
    const sheet = renderStaticPage(this.app, wrap, this.getDisplayText(), this.page, this.pageIndex + 1, this.look);
    sheet.style.transform = `scale(${r.width / this.dims.w})`;
    this.turnEl = wrap;
    wrap.addEventListener("animationend", () => wrap.remove(), { once: true });
    setTimeout(() => wrap.remove(), 900);
  }

  // ---- Private notebooks ------------------------------------------------------

  get isPrivate() {
    return !!this.lock;
  }

  private showLockScreen(data: string) {
    this.errorEl.toggle(false);
    this.deskEl.toggle(false);
    this.dockEl.toggle(false);
    this.drawerEl.toggle(false);
    this.lockBtn?.toggle(false);
    this.pad?.close();
    // Nothing about the pages shows while locked.
    this.chipEl?.setText(T("Locked"));
    this.cardsBtn?.setAttr("data-count", "");
    this.cardsBtn?.removeClass("has-count");
    this.calendarBtn?.toggle(false);
    const el = this.lockEl;
    el.empty();
    el.toggle(true);
    let parsed: ReturnType<typeof parseLocked>;
    try {
      parsed = parseLocked(data);
    } catch (e) {
      el.createDiv({ cls: "defter-lock-error", text: (e as Error).message });
      return;
    }
    const card = el.createDiv("defter-lock-card");
    setIcon(card.createDiv("defter-lock-icon"), "lock");
    card.createDiv({ cls: "defter-lock-title", text: this.getDisplayText() });
    card.createDiv({ cls: "defter-lock-sub", text: T("Private notebook") });
    if (parsed.data.hint) card.createDiv({ cls: "defter-lock-hint", text: T("Hint: {hint}", { hint: parsed.data.hint }) });
    let recovery = false;
    const input = card.createEl("input", { type: "password", cls: "defter-lock-input", attr: { placeholder: T("Password"), autocomplete: "off" } });
    const error = card.createDiv("defter-lock-error");
    const btn = card.createEl("button", { cls: "mod-cta", text: T("Unlock") });
    const forgot = card.createEl("a", { cls: "defter-lock-forgot", text: T("Forgot the password? Use the recovery key") });
    const go = async () => {
      if (!input.value) return;
      btn.disabled = true;
      btn.setText(T("Unlocking…"));
      error.setText("");
      try {
        const r = recovery ? await unlockWithRecovery(parsed.data, input.value) : await unlockWithPassword(parsed.data, input.value);
        this.unlocked(r.session, r.text, data);
        if (recovery) {
          new Notice(T("Opened with the recovery key. Choose a new password."));
          this.changePassword();
        }
      } catch (e) {
        error.setText(e instanceof WrongSecretError ? T(recovery ? "That recovery key is not right." : "Wrong password.") : (e as Error).message);
        input.select();
      } finally {
        btn.disabled = false;
        btn.setText(T("Unlock"));
      }
    };
    btn.onclick = () => void go();
    input.addEventListener("keydown", (e) => e.key === "Enter" && void go());
    forgot.onclick = () => {
      recovery = !recovery;
      input.type = recovery ? "text" : "password";
      input.placeholder = T(recovery ? "Recovery key, e.g. ABCD-EFGH-…" : "Password");
      forgot.setText(T(recovery ? "Use the password instead" : "Forgot the password? Use the recovery key"));
      input.value = "";
      input.focus();
    };
    setTimeout(() => input.focus(), 50);
  }

  private unlocked(session: LockSession, text: string, sealed: string) {
    this.lock = session;
    this.sealed = sealed;
    this.rawBroken = null;
    this.lastActive = Date.now();
    this.lockEl.toggle(false);
    this.loadText(text, true);
  }

  /** The file changed while open (another device, our own save): read it again. */
  private async reopenLocked(data: string) {
    const lock = this.lock;
    if (!lock) return;
    try {
      const session = { key: lock.key, data: parseLocked(data).data };
      const text = await openNotebookText(session);
      this.lock = session;
      this.sealed = data;
      this.rawBroken = null;
      this.loadText(text, false);
    } catch {
      this.lock = null;
      this.wipe();
      this.showLockScreen(data);
    }
  }

  async lockNow() {
    if (!this.lock) return;
    this.finishStroke();
    this.pad?.close();
    await this.save();
    const sealed = this.sealed;
    // Without a sealed copy we cannot lock safely: stay open rather than save an empty notebook.
    if (!sealed) return;
    this.lock = null;
    this.wipe();
    this.rawBroken = sealed;
    this.showLockScreen(sealed);
  }

  private makePrivate() {
    new PasswordModal(this.app, "Make this notebook private", (pw, hint) => {
      void (async () => {
        const { session, recovery } = await createLock(pw, hint || undefined);
        const pictures = this.nb.pages.some((p) => p.bg || p.obj?.some((o) => o.k === "img"));
        new RecoveryModal(
          this.app,
          recovery,
          () => {
            void (async () => {
              this.lock = session;
              this.lockBtn?.toggle(true);
              await this.save();
              new Notice(T("This notebook is now private. Its pages are encrypted in the file."));
            })();
          },
          pictures ? T("Pictures and PDF pages are separate files in the vault and are not encrypted.") : undefined
        ).open();
      })();
    }).open();
  }

  private changePassword() {
    const lock = this.lock;
    if (!lock) return;
    new PasswordModal(this.app, "Change password", (pw, hint) => {
      void (async () => {
        if (this.lock !== lock) return void new Notice(T("The notebook was locked meanwhile. Nothing was changed."));
        this.lastActive = Date.now();
        await changePassword(lock, pw, hint || undefined);
        await this.save();
        new Notice(T("Password changed. Your recovery key still works."));
      })();
    }).open();
  }

  private async newRecovery() {
    const lock = this.lock;
    if (!lock) return;
    // Work on a copy: closing the window without confirming keeps the old key.
    const draft: LockSession = { key: lock.key, data: { ...lock.data } };
    const code = await renewRecovery(draft);
    new RecoveryModal(this.app, code, () => {
      if (this.lock !== lock) return void new Notice(T("The notebook was locked meanwhile. Nothing was changed."));
      this.lastActive = Date.now();
      lock.data.wr = draft.data.wr;
      void this.save().then(() => new Notice(T("New recovery key saved. The old one no longer works.")));
    }).open();
  }

  private removeLock() {
    new PasswordConfirm(this.app, () => {
      void (async () => {
        this.lock = null;
        this.sealed = null;
        this.nb.frontmatter = setProp(this.nb.frontmatter, LOCK_KEY, null);
        this.lockBtn?.toggle(false);
        await this.save();
        new Notice(T("The password was removed. This notebook is a normal file again."));
      })();
    }).open();
  }
}

/** "Are you sure?" before a private notebook becomes plain text again. */
class PasswordConfirm extends Modal {
  private ok: () => void;
  constructor(app: App, ok: () => void) {
    super(app);
    this.ok = ok;
  }
  onOpen() {
    this.titleEl.setText(T("Remove the password?"));
    this.contentEl.createEl("p", { text: T("The notebook will be saved as plain text again. Anyone with access to the vault can read it.") });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(T("Cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(T("Remove password"))
          .setWarning()
          .onClick(() => {
            this.close();
            this.ok();
          })
      );
  }
  onClose() {
    this.contentEl.empty();
  }
}
