import { FuzzySuggestModal, MarkdownView, Notice, type App, Plugin, TFile, TFolder, WorkspaceLeaf, debounce, normalizePath, type ViewState } from "obsidian";
import { DefterView, VIEW_TYPE, type DefterHost } from "./view";
import { FRONTMATTER_KEY, emptyNotebook, fromLegacy, isNotebookText, parseNotebook, serializeNotebook, type Notebook } from "./format";
import { DefterSettingTab, freshSettings, setDateLocale, type DefterSettings, type NotebookLook } from "./settings";
import { SHELF_VIEW, ShelfView, type ShelfHost } from "./shelf";
import { exportPdf } from "./pdf";
import { NewNotebookModal, todayStr } from "./new-notebook";
import { StudyTimer } from "./timer";
import { isDue, parseCards, type CardState } from "./cards";
import { StudyModal, type StudyItem } from "./study-modal";
import { LOCK_KEY } from "./lock";
import { cardKey } from "./cards";
import { T, setLanguage } from "./i18n";

const LEGACY_EXT = "defter";

export default class DefterPlugin extends Plugin implements DefterHost, ShelfHost {
  settings: DefterSettings = freshSettings(null);
  /** Leaves where the user chose "Open as Markdown", with the file they chose it for. */
  private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
  private switching = new WeakSet<WorkspaceLeaf>();
  private saveSoon = debounce(() => void this.saveSettings(), 1500, true);
  timer!: StudyTimer;

  async onload() {
    this.settings = freshSettings(await this.loadData());
    setDateLocale(this.settings.dateLocale);
    setLanguage(this.settings.language);
    this.addSettingTab(new DefterSettingTab(this.app, this));
    this.timer = new StudyTimer(this, this.addStatusBarItem());
    this.registerInterval(window.setInterval(() => this.timer.tick(), 1000));
    this.registerInterval(window.setInterval(() => this.autoLock(), 20_000));
    this.register(() => this.timer.stop());

    this.registerView(VIEW_TYPE, (leaf) => new DefterView(leaf, this));
    this.registerView(SHELF_VIEW, (leaf) => new ShelfView(leaf, this));
    this.interceptOpen();
    this.app.workspace.onLayoutReady(() => {
      void this.switchLeaves();
      this.reportLegacy();
    });

    this.addRibbonIcon("library", T("Open library"), () => void this.openShelf());

    this.addCommand({ id: "open-shelf", name: T("Open library"), callback: () => void this.openShelf() });
    this.addCommand({
      id: "new-notebook",
      name: T("New notebook"),
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        this.newNotebook(active?.parent ?? this.app.vault.getRoot());
      },
    });
    this.addCommand({ id: "open-journal", name: T("Open today's journal page"), callback: () => this.openJournal() });
    this.addCommand({ id: "review-cards", name: T("Study due flashcards in all notebooks"), callback: () => void this.reviewAll() });
    this.addCommand({ id: "open-private", name: T("Open private notebook…"), callback: () => this.openPrivate() });
    this.addCommand({ id: "stop-timer", name: T("Stop the study timer"), callback: () => this.timer.stop() });
    this.addCommand({
      id: "open-as-notebook",
      name: T("Open this note as a notebook"),
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) void this.openAsNotebook(view.leaf, view.file);
        return true;
      },
    });
    this.addCommand({
      id: "convert-old-notebooks",
      name: T("Convert old .defter notebooks to Markdown"),
      callback: () => void this.convertLegacy(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target, _source, leaf) => {
        if (target instanceof TFolder) {
          menu.addItem((item) =>
            item.setTitle(T("New notebook")).setIcon("notebook-pen").onClick(() => this.newNotebook(target))
          );
        } else if (target instanceof TFile && target.extension === "md" && leaf?.view instanceof MarkdownView) {
          menu.addItem((item) =>
            item.setTitle(T("Open as notebook")).setIcon("notebook-pen").onClick(() => void this.openAsNotebook(leaf, target))
          );
        }
      })
    );

    // Keep "last page" entries attached to the right file.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        let changed = false;
        for (const map of [this.settings.lastPage, this.settings.cards, this.settings.study] as Record<string, unknown>[]) {
          if (!(oldPath in map)) continue;
          map[file.path] = map[oldPath];
          delete map[oldPath];
          changed = true;
        }
        if (changed) this.saveSoon();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        // Study minutes stay (they count towards the week); progress and place go.
        let changed = false;
        for (const map of [this.settings.lastPage, this.settings.cards] as Record<string, unknown>[]) {
          if (file.path in map) {
            delete map[file.path];
            changed = true;
          }
        }
        if (changed) this.saveSoon();
      })
    );
  }

  cardState(path: string, front: string): CardState | undefined {
    return this.settings.cards[path]?.[cardKey(front)];
  }

  setCardState(path: string, front: string, state: CardState) {
    // Keyed by a hash: the card text itself never lands in the plugin settings.
    (this.settings.cards[path] ??= {})[cardKey(front)] = state;
    this.saveSoon();
  }

  addStudyMinute(path: string) {
    const day = todayStr();
    const days = (this.settings.study[path] ??= {});
    days[day] = (days[day] ?? 0) + 1;
    this.saveSoon();
  }

  async openAt(path: string, page: number) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    this.settings.lastPage[path] = page;
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => (l.view as DefterView).file?.path === path);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      (existing.view as DefterView).jumpTo(page);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private openPrivate() {
    const files = this.notebookFiles().filter((f) => this.isPrivate(f));
    if (!files.length) {
      new Notice(T("No private notebooks yet. Open a notebook and choose “Make private (password)…” in its ⋯ menu."));
      return;
    }
    new PrivatePicker(this.app, files, (f) => this.openNotebook(f)).open();
  }

  /** Due cards from every notebook, studied in one go. */
  async reviewAll() {
    const today = todayStr();
    const items: StudyItem[] = [];
    for (const f of this.notebookFiles()) {
      const text = await this.app.vault.cachedRead(f);
      if (!text.includes(" :: ")) continue;
      try {
        const cards = parseCards(parseNotebook(text).pages);
        for (const card of cards) if (isDue(this.cardState(f.path, card.front), today)) items.push({ card, path: f.path, notebook: f.basename });
      } catch {
        /* unreadable notebook: skipped */
      }
    }
    if (!items.length) {
      new Notice(T("No flashcards are due. Write cards as “front :: back” lines in any notebook."));
      return;
    }
    new StudyModal(this.app, items, this).open();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) (leaf.view as DefterView).applyLook();
  }

  rememberPage(path: string, page: number) {
    if (this.settings.lastPage[path] === page) return;
    if (page === 0) delete this.settings.lastPage[path];
    else this.settings.lastPage[path] = page;
    this.saveSoon();
  }

  exportPdf(title: string, nb: Notebook, look: NotebookLook) {
    return exportPdf(this.app, title, nb, look);
  }

  notebookFiles(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.app.metadataCache.getFileCache(f)?.frontmatter?.[FRONTMATTER_KEY] === "notebook");
  }

  isPrivate(f: TFile): boolean {
    return !!this.app.metadataCache.getFileCache(f)?.frontmatter?.[LOCK_KEY];
  }

  /** Locks open private notebooks nobody has touched for a while. */
  private autoLock() {
    const min = this.settings.lockMinutes;
    if (!min) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view as DefterView;
      if (v.isPrivate && Date.now() - v.lastActive > min * 60_000) void v.lockNow();
    }
  }

  newNotebook(folder: TFolder, journal = false) {
    new NewNotebookModal(this.app, folder, this.settings, (path) => {
      const leaf = this.app.workspace.getLeaf("tab");
      void leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true });
    }, journal).open();
  }

  /** Opens the journal on today's page; offers to create one if there is none. */
  openJournal() {
    const journal = this.notebookFiles().find((f) => this.app.metadataCache.getFileCache(f)?.frontmatter?.["defter-journal"] === true || this.app.metadataCache.getFileCache(f)?.frontmatter?.["defter-journal"] === "true");
    if (journal) this.openNotebook(journal);
    else this.newNotebook(this.app.workspace.getActiveFile()?.parent ?? this.app.vault.getRoot(), true);
  }

  openNotebook(file: TFile) {
    const leaf = this.app.workspace.getLeaf("tab");
    void leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
  }

  async openShelf() {
    const existing = this.app.workspace.getLeavesOfType(SHELF_VIEW)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    await this.app.workspace.getLeaf("tab").setViewState({ type: SHELF_VIEW, active: true });
  }

  // A notebook opened as Markdown is redirected to the notebook view before the
  // view is created. The "file-open" event is too early: the leaf still shows
  // the previous view then, so switching there silently does nothing.
  private interceptOpen() {
    const plugin = this;
    const proto = WorkspaceLeaf.prototype;
    const original = proto.setViewState;
    let active = true;
    const patched = async function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
      const path = state?.state?.file;
      // "Open as Markdown" holds only while the leaf stays on that file.
      if (typeof path === "string" && plugin.markdownLeaves.get(this) !== path) plugin.markdownLeaves.delete(this);
      if (active && state.type === "markdown" && typeof path === "string" && !plugin.switching.has(this)) {
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile && plugin.markdownLeaves.get(this) !== path && (await plugin.isNotebook(file))) {
          state = { ...state, type: VIEW_TYPE };
        }
      }
      return original.call(this, state, eState);
    };
    proto.setViewState = patched;
    this.register(() => {
      active = false;
      // Only restore if no other plugin wrapped it after us; otherwise stay as a pass-through.
      if (proto.setViewState === patched) proto.setViewState = original;
    });
  }

  private async isNotebook(file: TFile): Promise<boolean> {
    if (file.extension !== "md") return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm && FRONTMATTER_KEY in fm) return fm[FRONTMATTER_KEY] === "notebook";
    // Right after a file is created the metadata cache may not know it yet.
    return isNotebookText(await this.app.vault.cachedRead(file));
  }

  /** Leaves restored from the saved layout that show a notebook as Markdown. */
  private async switchLeaves() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as MarkdownView).file;
      if (!file || this.switching.has(leaf)) continue;
      if (this.markdownLeaves.get(leaf) === file.path) continue;
      if (!(await this.isNotebook(file))) continue;
      await this.setType(leaf, VIEW_TYPE);
    }
  }

  private async setType(leaf: WorkspaceLeaf, type: string) {
    this.switching.add(leaf);
    try {
      await leaf.setViewState({ ...leaf.getViewState(), type });
    } finally {
      this.switching.delete(leaf);
    }
  }

  openAsMarkdown(leaf: WorkspaceLeaf) {
    const file = (leaf.view as DefterView).file;
    if (file) this.markdownLeaves.set(leaf, file.path);
    void this.setType(leaf, "markdown");
  }

  private async openAsNotebook(leaf: WorkspaceLeaf, file: TFile) {
    if (!(await this.isNotebook(file))) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm[FRONTMATTER_KEY] = "notebook";
      });
    }
    this.markdownLeaves.delete(leaf);
    await this.setType(leaf, VIEW_TYPE);
  }

  private uniquePath(folder: TFolder, base: string, ext: string) {
    const dir = folder.isRoot() ? "" : folder.path + "/";
    let name = base;
    for (let i = 2; this.app.vault.getAbstractFileByPath(normalizePath(`${dir}${name}.${ext}`)); i++) name = `${base} ${i}`;
    return normalizePath(`${dir}${name}.${ext}`);
  }

  async createNotebook(folder: TFolder) {
    const file = await this.app.vault.create(this.uniquePath(folder, "Untitled notebook", "md"), serializeNotebook(emptyNotebook()));
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
  }

  private legacyFiles() {
    return this.app.vault.getFiles().filter((f) => f.extension === LEGACY_EXT);
  }

  private reportLegacy() {
    const n = this.legacyFiles().length;
    if (n) new Notice(T("Defter: {n} old .defter notebook(s) found. Run “Convert old .defter notebooks to Markdown” from the command palette.", { n }), 10000);
  }

  // Each old file gets a Markdown twin; the original is kept as .defter.bak.
  async convertLegacy() {
    let done = 0;
    const failed: string[] = [];
    for (const f of this.legacyFiles()) {
      try {
        const nb = fromLegacy(await this.app.vault.read(f));
        const target = normalizePath(f.path.replace(/\.defter$/, ".md"));
        if (this.app.vault.getAbstractFileByPath(target)) throw new Error("a note with that name already exists");
        await this.app.vault.create(target, serializeNotebook(nb));
        await this.app.fileManager.renameFile(f, f.path + ".bak");
        done++;
      } catch (e) {
        failed.push(`${f.path} (${(e as Error).message})`);
      }
    }
    new Notice(T("Defter: converted {n} notebook(s).", { n: done }) + (failed.length ? " " + T("Skipped: {list}", { list: failed.join(", ") }) : ""), 10000);
    return { done, failed };
  }
}

class PrivatePicker extends FuzzySuggestModal<TFile> {
  private files: TFile[];
  private pick: (f: TFile) => void;
  constructor(app: App, files: TFile[], pick: (f: TFile) => void) {
    super(app);
    this.files = files;
    this.pick = pick;
    this.setPlaceholder(T("Private notebook"));
  }
  getItems() {
    return this.files;
  }
  getItemText(f: TFile) {
    return f.basename;
  }
  onChooseItem(f: TFile) {
    this.pick(f);
  }
}
