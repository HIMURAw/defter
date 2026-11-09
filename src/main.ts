import { MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, debounce, normalizePath, type ViewState } from "obsidian";
import { DefterView, VIEW_TYPE, type DefterHost } from "./view";
import { FRONTMATTER_KEY, emptyNotebook, fromLegacy, isNotebookText, serializeNotebook, type Notebook } from "./format";
import { DEFAULT_SETTINGS, DefterSettingTab, type DefterSettings, type NotebookLook } from "./settings";
import { SHELF_VIEW, ShelfView, type ShelfHost } from "./shelf";
import { exportPdf } from "./pdf";
import { NewNotebookModal } from "./new-notebook";

const LEGACY_EXT = "defter";

export default class DefterPlugin extends Plugin implements DefterHost, ShelfHost {
  settings: DefterSettings = { ...DEFAULT_SETTINGS, lastPage: {}, bookcases: [], caseOrder: [], bookOrder: {} };
  /** Leaves where the user chose "Open as Markdown", with the file they chose it for. */
  private markdownLeaves = new WeakMap<WorkspaceLeaf, string>();
  private switching = new WeakSet<WorkspaceLeaf>();
  private saveSoon = debounce(() => void this.saveSettings(), 1500, true);

  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.settings.lastPage ??= {};
    this.settings.bookcases ??= [];
    this.settings.caseOrder ??= [];
    this.settings.bookOrder ??= {};
    this.addSettingTab(new DefterSettingTab(this.app, this));

    this.registerView(VIEW_TYPE, (leaf) => new DefterView(leaf, this));
    this.registerView(SHELF_VIEW, (leaf) => new ShelfView(leaf, this));
    this.interceptOpen();
    this.app.workspace.onLayoutReady(() => {
      void this.switchLeaves();
      this.reportLegacy();
    });

    this.addRibbonIcon("library", "Open library", () => void this.openShelf());

    this.addCommand({ id: "open-shelf", name: "Open library", callback: () => void this.openShelf() });
    this.addCommand({
      id: "new-notebook",
      name: "New notebook",
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        this.newNotebook(active?.parent ?? this.app.vault.getRoot());
      },
    });
    this.addCommand({ id: "open-journal", name: "Open today's journal page", callback: () => this.openJournal() });
    this.addCommand({
      id: "open-as-notebook",
      name: "Open this note as a notebook",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) return false;
        if (!checking) void this.openAsNotebook(view.leaf, view.file);
        return true;
      },
    });
    this.addCommand({
      id: "convert-old-notebooks",
      name: "Convert old .defter notebooks to Markdown",
      callback: () => void this.convertLegacy(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target, _source, leaf) => {
        if (target instanceof TFolder) {
          menu.addItem((item) =>
            item.setTitle("New notebook").setIcon("notebook-pen").onClick(() => this.newNotebook(target))
          );
        } else if (target instanceof TFile && target.extension === "md" && leaf?.view instanceof MarkdownView) {
          menu.addItem((item) =>
            item.setTitle("Open as notebook").setIcon("notebook-pen").onClick(() => void this.openAsNotebook(leaf, target))
          );
        }
      })
    );

    // Keep "last page" entries attached to the right file.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const n = this.settings.lastPage[oldPath];
        if (n === undefined) return;
        delete this.settings.lastPage[oldPath];
        this.settings.lastPage[file.path] = n;
        this.saveSoon();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file.path in this.settings.lastPage) {
          delete this.settings.lastPage[file.path];
          this.saveSoon();
        }
      })
    );
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
    if (n) new Notice(`Defter: ${n} old .defter notebook(s) found. Run “Convert old .defter notebooks to Markdown” from the command palette.`, 10000);
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
    new Notice(`Defter: converted ${done} notebook(s).` + (failed.length ? ` Skipped: ${failed.join(", ")}` : ""), 10000);
    return { done, failed };
  }
}
