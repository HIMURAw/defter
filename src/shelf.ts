import { ItemView, TFile, TFolder, debounce, moment, setIcon, type WorkspaceLeaf } from "obsidian";
import { PAGE_MARKER } from "./format";
import { defaultCover } from "./settings";

export const SHELF_VIEW = "defter-shelf";

export interface ShelfHost {
  notebookFiles(): TFile[];
  openNotebook(file: TFile): void;
  createNotebook(folder: TFolder): Promise<void>;
}

/** Every notebook in the vault as a book on a shelf, grouped by folder. */
export class ShelfView extends ItemView {
  private host: ShelfHost;
  private refresh = debounce(() => void this.render(), 300, true);

  constructor(leaf: WorkspaceLeaf, host: ShelfHost) {
    super(leaf);
    this.host = host;
  }

  getViewType() {
    return SHELF_VIEW;
  }
  getDisplayText() {
    return "Notebooks";
  }
  getIcon() {
    return "library";
  }

  async onOpen() {
    this.contentEl.addClass("defter-shelf");
    this.registerEvent(this.app.vault.on("create", () => this.refresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
    await this.render();
  }

  private async render() {
    const root = this.contentEl;
    const files = this.host.notebookFiles();
    const pages = new Map<TFile, number>();
    await Promise.all(
      files.map(async (f) => pages.set(f, (await this.app.vault.cachedRead(f)).split(PAGE_MARKER).length - 1 || 1))
    );

    root.empty();
    const head = root.createDiv("defter-shelf-head");
    head.createEl("h2", { text: "Notebooks" });
    head.createSpan({ cls: "defter-shelf-count", text: files.length === 1 ? "1 notebook" : `${files.length} notebooks` });

    if (!files.length) {
      const empty = root.createDiv("defter-shelf-empty");
      empty.createEl("p", { text: "No notebooks yet. Start one here, or right-click any folder → New notebook." });
      const b = empty.createEl("button", { cls: "mod-cta", text: "New notebook" });
      b.onclick = () => void this.host.createNotebook(this.app.vault.getRoot());
      return;
    }

    const groups = new Map<TFolder, TFile[]>();
    for (const f of files) {
      const parent = f.parent ?? this.app.vault.getRoot();
      groups.set(parent, [...(groups.get(parent) ?? []), f]);
    }
    const collator = new Intl.Collator("tr", { numeric: true });
    const sorted = [...groups.entries()].sort(([a], [b]) => collator.compare(a.path, b.path));

    for (const [folder, list] of sorted) {
      const group = root.createDiv("defter-shelf-group");
      const title = group.createDiv("defter-shelf-folder");
      title.createSpan({ text: folder.isRoot() ? "Vault" : folder.name });
      if (!folder.isRoot() && folder.parent && !folder.parent.isRoot()) {
        title.createSpan({ cls: "defter-shelf-path", text: folder.parent.path });
      }
      const row = group.createDiv("defter-shelf-row");
      for (const f of list.sort((a, b) => collator.compare(a.basename, b.basename))) {
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        const cover = typeof fm?.["defter-cover"] === "string" ? fm["defter-cover"] : defaultCover(f.basename);
        const book = row.createEl("button", { cls: "defter-book", attr: { "aria-label": `Open ${f.basename}` } });
        book.style.setProperty("--cover", cover);
        book.createDiv("defter-book-spine");
        const label = book.createDiv("defter-book-label");
        label.createDiv({ cls: "defter-book-title", text: f.basename });
        const n = pages.get(f) ?? 1;
        const meta = book.createDiv("defter-book-meta");
        meta.createDiv({ text: `${n} ${n === 1 ? "page" : "pages"}` });
        meta.createDiv({ text: moment(f.stat.mtime).fromNow() });
        book.onclick = () => this.host.openNotebook(f);
      }
      const add = row.createEl("button", { cls: "defter-book defter-book-new", attr: { "aria-label": `New notebook in ${folder.isRoot() ? "vault" : folder.name}` } });
      setIcon(add.createDiv("defter-book-plus"), "plus");
      add.createDiv({ cls: "defter-book-meta", text: "New notebook" });
      add.onclick = () => void this.host.createNotebook(folder);
    }
  }
}
