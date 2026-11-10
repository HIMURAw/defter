import { ItemView, Menu, Modal, Notice, Setting, TFile, TFolder, debounce, moment, normalizePath, setIcon, setTooltip, type App, type WorkspaceLeaf } from "obsidian";
import { COVERS, defaultCover } from "./settings";
import { fmtMinutes, weekMinutes } from "./timer";
import { T } from "./i18n";

export const SHELF_VIEW = "defter-shelf";

export interface ShelfHost {
  app: App;
  settings: {
    bookcases: string[];
    caseOrder: string[];
    bookOrder: Record<string, string[]>;
    study: Record<string, Record<string, number>>;
    showPrivate: boolean;
  };
  isPrivate(f: TFile): boolean;
  saveSettings(): Promise<void>;
  notebookFiles(): TFile[];
  openNotebook(file: TFile): void;
  newNotebook(folder: TFolder): void;
}

const SLOT = 212; // height of one shelf row (tallest book + headroom)

function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Asks for a single line of text. */
class PromptModal extends Modal {
  private title: string;
  private value: string;
  private done: (v: string) => void;
  private extra?: (el: HTMLElement) => void;
  constructor(app: App, title: string, value: string, done: (v: string) => void, extra?: (el: HTMLElement) => void) {
    super(app);
    this.title = title;
    this.value = value;
    this.done = done;
    this.extra = extra;
  }
  onOpen() {
    this.titleEl.setText(T(this.title));
    let v = this.value;
    const submit = () => {
      if (!v.trim()) return;
      this.close();
      this.done(v.trim());
    };
    new Setting(this.contentEl).setName(T("Name")).addText((t) => {
      t.setValue(v).onChange((x) => (v = x));
      t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      setTimeout(() => t.inputEl.select(), 0);
    });
    this.extra?.(this.contentEl);
    new Setting(this.contentEl).addButton((b) => b.setButtonText(T("Save")).setCta().onClick(submit));
  }
  onClose() {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  private text: string;
  private action: string;
  private done: () => void;
  constructor(app: App, text: string, action: string, done: () => void) {
    super(app);
    this.text = text;
    this.action = action;
    this.done = done;
  }
  onOpen() {
    this.titleEl.setText(T("Are you sure?"));
    this.contentEl.createEl("p", { text: this.text });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(T("Cancel")).onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.action)
          .setWarning()
          .onClick(() => {
            this.close();
            this.done();
          })
      );
  }
}

class CoverModal extends Modal {
  private file: TFile;
  constructor(app: App, file: TFile) {
    super(app);
    this.file = file;
  }
  onOpen() {
    this.titleEl.setText(T("Cover of “{name}”", { name: this.file.basename }));
    const row = this.contentEl.createDiv("defter-set-row");
    for (const c of COVERS) {
      const b = row.createEl("button", { cls: "defter-swatch defter-swatch-lg defter-swatch-cover", attr: { "aria-label": T("Cover colour") } });
      b.style.setProperty("--swatch", c);
      b.onclick = async () => {
        await this.app.fileManager.processFrontMatter(this.file, (fm) => {
          fm["defter-cover"] = c;
        });
        this.close();
      };
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}

/**
 * The library: each bookcase is a folder, each notebook a book standing on a
 * wooden shelf. Dragging a book to another bookcase moves the file.
 */
export class ShelfView extends ItemView {
  private host: ShelfHost;
  private refresh = debounce(() => void this.render(), 250, true);
  private dragging: TFile | null = null;

  constructor(leaf: WorkspaceLeaf, host: ShelfHost) {
    super(leaf);
    this.host = host;
  }

  getViewType() {
    return SHELF_VIEW;
  }
  getDisplayText() {
    return T("Library");
  }
  getIcon() {
    return "library";
  }

  async onOpen() {
    this.contentEl.addClass("defter-library");
    this.registerEvent(this.app.vault.on("create", () => this.refresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
    await this.render();
  }

  private folder(path: string): TFolder | null {
    const f = path === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }

  /** Bookcases: folders holding notebooks plus empty ones the user created. */
  private bookcases(files: TFile[]): TFolder[] {
    const s = this.host.settings;
    const paths = new Set<string>(s.bookcases.filter((p) => this.folder(p)));
    for (const f of files) paths.add(f.parent?.path ?? "/");
    const collator = new Intl.Collator("tr", { numeric: true });
    const order = (p: string) => {
      const i = s.caseOrder.indexOf(p);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...paths]
      .sort((a, b) => order(a) - order(b) || collator.compare(a, b))
      .map((p) => this.folder(p)!)
      .filter(Boolean);
  }

  private orderedBooks(folder: TFolder, files: TFile[]): TFile[] {
    const saved = this.host.settings.bookOrder[folder.path] ?? [];
    const collator = new Intl.Collator("tr", { numeric: true });
    const rank = (f: TFile) => {
      const i = saved.indexOf(f.name);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return files
      .filter((f) => (f.parent?.path ?? "/") === folder.path)
      .sort((a, b) => rank(a) - rank(b) || collator.compare(a.basename, b.basename));
  }

  private async render() {
    const root = this.contentEl;
    const scroll = root.scrollTop;
    const files = this.host.notebookFiles().filter((f) => this.host.settings.showPrivate || !this.host.isPrivate(f));
    const pages = new Map<TFile, number>();
    await Promise.all(files.map(async (f) => pages.set(f, ((await this.app.vault.cachedRead(f)).match(/^<!-- defter:page(?: [^\n>]*)? -->$/gm) ?? []).length || 1)));

    root.empty();
    const head = root.createDiv("defter-lib-head");
    head.createEl("h2", { text: T("Library") });
    head.createSpan({ cls: "defter-lib-count", text: files.length === 1 ? "1 notebook" : `${files.length} notebooks` });
    const week = Object.values(this.host.settings.study).reduce((sum, days) => sum + weekMinutes(days), 0);
    if (week) head.createSpan({ cls: "defter-lib-count defter-lib-week", text: T("Studied this week: {time}", { time: fmtMinutes(week) }) });
    const add = head.createEl("button", { cls: "mod-cta", text: T("New bookcase") });
    add.onclick = () => this.newBookcase();

    const cases = this.bookcases(files);
    if (!cases.length) {
      root.createDiv({ cls: "defter-lib-empty", text: T("No notebooks yet. Create a bookcase, then add notebooks to it.") });
      return;
    }
    cases.forEach((folder, ci) => this.renderCase(root, folder, this.orderedBooks(folder, files), pages, ci, cases));
    root.scrollTop = scroll;
  }

  private renderCase(root: HTMLElement, folder: TFolder, books: TFile[], pages: Map<TFile, number>, index: number, all: TFolder[]) {
    const cabinet = root.createDiv("defter-case");
    const top = cabinet.createDiv("defter-case-top");
    const name = top.createDiv("defter-case-name");
    name.createSpan({ text: folder.isRoot() ? T("Vault") : folder.name });
    if (folder.parent && !folder.parent.isRoot()) name.createSpan({ cls: "defter-case-path", text: folder.parent.path });
    const more = top.createEl("button", { cls: "defter-case-more clickable-icon", attr: { "aria-label": T("Bookcase options") } });
    setIcon(more, "more-horizontal");
    more.onclick = (e) => this.caseMenu(e, folder, books.length, index, all);

    const inner = cabinet.createDiv("defter-case-inner");
    inner.style.setProperty("--slot", SLOT + "px");
    for (const f of books) this.renderBook(inner, f, pages.get(f) ?? 1, folder);

    const plus = inner.createEl("button", { cls: "defter-spine defter-spine-new" });
    setTooltip(plus, T("New notebook here"));
    setIcon(plus, "plus");
    plus.onclick = () => this.host.newNotebook(folder);

    // Dropping on the shelf (not on a book) puts the book at the end.
    inner.addEventListener("dragover", (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      inner.addClass("is-drop");
    });
    inner.addEventListener("dragleave", (e) => {
      if (!inner.contains(e.relatedTarget as Node)) inner.removeClass("is-drop");
    });
    inner.addEventListener("drop", (e) => {
      e.preventDefault();
      inner.removeClass("is-drop");
      if (this.dragging) void this.place(this.dragging, folder, null, false);
    });
  }

  private renderBook(inner: HTMLElement, f: TFile, n: number, folder: TFolder) {
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const cover = typeof fm?.["defter-cover"] === "string" ? fm["defter-cover"] : defaultCover(f.basename);
    const h = hash(f.basename);
    const book = inner.createEl("button", { cls: "defter-spine" });
    book.style.setProperty("--cover", cover);
    book.style.setProperty("--w", Math.min(64, 30 + Math.round(Math.sqrt(n) * 6)) + "px");
    book.style.setProperty("--h", 150 + (h % 5) * 9 + "px");
    book.toggleClass("has-bands", h % 3 !== 0);
    book.createDiv({ cls: "defter-spine-title", text: f.basename });
    if (this.host.isPrivate(f)) {
      book.addClass("is-private");
      setIcon(book.createDiv("defter-spine-lock"), "lock");
    }
    const week = weekMinutes(this.host.settings.study[f.path]);
    setTooltip(
      book,
      `${f.basename} · ${T(n === 1 ? "{n} page" : "{n} pages", { n })} · ${moment(f.stat.mtime).fromNow()}` + (week ? " · " + T("this week {time}", { time: fmtMinutes(week) }) : ""),
      { placement: "top" }
    );
    if (week) book.createDiv("defter-study-dot");
    book.draggable = true;
    book.onclick = () => this.host.openNotebook(f);
    book.oncontextmenu = (e) => {
      e.preventDefault();
      this.bookMenu(e, f, folder);
    };
    book.addEventListener("dragstart", (e) => {
      this.dragging = f;
      book.addClass("is-dragging");
      e.dataTransfer?.setData("text/plain", f.path);
    });
    book.addEventListener("dragend", () => {
      this.dragging = null;
      book.removeClass("is-dragging");
    });
    book.addEventListener("dragover", (e) => {
      if (!this.dragging || this.dragging === f) return;
      e.preventDefault();
      e.stopPropagation();
      const r = book.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      book.toggleClass("drop-before", !after);
      book.toggleClass("drop-after", after);
    });
    book.addEventListener("dragleave", () => book.removeClass("drop-before", "drop-after"));
    book.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = book.hasClass("drop-after");
      book.removeClass("drop-before", "drop-after");
      inner.removeClass("is-drop");
      if (this.dragging && this.dragging !== f) void this.place(this.dragging, folder, f, after);
    });
  }

  /** Puts a book into a bookcase, next to another book; moves the file if needed. */
  private async place(file: TFile, folder: TFolder, near: TFile | null, after: boolean) {
    let target = file;
    if ((file.parent?.path ?? "/") !== folder.path) {
      const dest = normalizePath(`${folder.isRoot() ? "" : folder.path + "/"}${file.name}`);
      if (this.app.vault.getAbstractFileByPath(dest)) {
        new Notice(T("“{folder}” already has a notebook named “{name}”.", { folder: folder.name, name: file.basename }));
        return;
      }
      await this.app.fileManager.renameFile(file, dest);
      target = this.app.vault.getAbstractFileByPath(dest) as TFile;
    }
    const files = this.host.notebookFiles();
    const names = this.orderedBooks(folder, files).map((f) => f.name).filter((n) => n !== target.name);
    const at = near ? names.indexOf(near.name) + (after ? 1 : 0) : names.length;
    names.splice(at < 0 ? names.length : at, 0, target.name);
    this.host.settings.bookOrder[folder.path] = names;
    await this.host.saveSettings();
    this.refresh();
  }

  private bookMenu(e: MouseEvent, f: TFile, folder: TFolder) {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(T("Open")).setIcon("book-open").onClick(() => this.host.openNotebook(f)));
    menu.addItem((i) =>
      i.setTitle(T("Rename")).setIcon("pencil").onClick(() =>
        new PromptModal(this.app, "Rename notebook", f.basename, async (v) => {
          const dest = normalizePath(`${f.parent && !f.parent.isRoot() ? f.parent.path + "/" : ""}${v}.md`);
          if (this.app.vault.getAbstractFileByPath(dest)) return new Notice(T("A note with that name already exists."));
          const order = this.host.settings.bookOrder[folder.path];
          const idx = order?.indexOf(f.name) ?? -1;
          await this.app.fileManager.renameFile(f, dest);
          if (order && idx !== -1) order[idx] = `${v}.md`;
          await this.host.saveSettings();
        }).open()
      )
    );
    menu.addItem((i) => i.setTitle(T("Cover colour")).setIcon("palette").onClick(() => new CoverModal(this.app, f).open()));
    menu.addSeparator();
    for (const target of this.bookcases(this.host.notebookFiles())) {
      if (target === folder) continue;
      menu.addItem((i) =>
        i
          .setTitle(T("Move to {place}", { place: target.isRoot() ? T("Vault") : target.name }))
          .setIcon("folder-input")
          .setSection("move")
          .onClick(() => void this.place(f, target, null, false))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle(T("Delete notebook"))
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() =>
          new ConfirmModal(this.app, T("“{name}” will be moved to the trash.", { name: f.basename }), T("Delete"), () => void this.app.fileManager.trashFile(f)).open()
        )
    );
    menu.showAtMouseEvent(e);
  }

  private caseMenu(e: MouseEvent, folder: TFolder, count: number, index: number, all: TFolder[]) {
    const s = this.host.settings;
    const menu = new Menu();
    const move = async (dir: number) => {
      const order = all.map((f) => f.path);
      const j = index + dir;
      if (j < 0 || j >= order.length) return;
      [order[index], order[j]] = [order[j], order[index]];
      s.caseOrder = order;
      await this.host.saveSettings();
      this.refresh();
    };
    menu.addItem((i) => i.setTitle(T("New notebook here")).setIcon("plus").onClick(() => this.host.newNotebook(folder)));
    if (!folder.isRoot()) {
      menu.addItem((i) =>
        i.setTitle(T("Rename bookcase")).setIcon("pencil").onClick(() =>
          new PromptModal(this.app, "Rename bookcase", folder.name, async (v) => {
            const dest = normalizePath(`${folder.parent && !folder.parent.isRoot() ? folder.parent.path + "/" : ""}${v}`);
            if (this.app.vault.getAbstractFileByPath(dest)) return new Notice(T("A folder with that name already exists."));
            const old = folder.path;
            await this.app.fileManager.renameFile(folder, dest);
            const swap = (p: string) => (p === old ? dest : p);
            s.bookcases = s.bookcases.map(swap);
            s.caseOrder = s.caseOrder.map(swap);
            if (s.bookOrder[old]) {
              s.bookOrder[dest] = s.bookOrder[old];
              delete s.bookOrder[old];
            }
            await this.host.saveSettings();
          }).open()
        )
      );
    }
    menu.addItem((i) => i.setTitle(T("Move up")).setIcon("arrow-up").setDisabled(index === 0).onClick(() => void move(-1)));
    menu.addItem((i) => i.setTitle(T("Move down")).setIcon("arrow-down").setDisabled(index === all.length - 1).onClick(() => void move(1)));
    if (count === 0 && !folder.isRoot()) {
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle(T("Remove bookcase"))
          .setIcon("trash-2")
          .setWarning(true)
          .onClick(async () => {
            s.bookcases = s.bookcases.filter((p) => p !== folder.path);
            s.caseOrder = s.caseOrder.filter((p) => p !== folder.path);
            await this.host.saveSettings();
            // The folder itself is only deleted when it is completely empty.
            if (!folder.children.length) await this.app.fileManager.trashFile(folder);
            this.refresh();
          })
      );
    }
    menu.showAtMouseEvent(e);
  }

  private newBookcase() {
    const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && !f.path.startsWith("."));
    let parent = this.host.notebookFiles()[0]?.parent?.parent?.path ?? "/";
    new PromptModal(
      this.app,
      "New bookcase",
      "",
      async (name) => {
        const base = parent === "/" ? "" : parent + "/";
        const path = normalizePath(base + name);
        if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
        const s = this.host.settings;
        if (!s.bookcases.includes(path)) s.bookcases.push(path);
        await this.host.saveSettings();
        this.refresh();
      },
      (el) =>
        new Setting(el)
          .setName(T("Inside folder"))
          .setDesc(T("The bookcase is a folder; its notebooks are the notes in it."))
          .addDropdown((d) => {
            d.addOption("/", T("Vault (top level)"));
            for (const f of folders) if (!f.isRoot()) d.addOption(f.path, f.path);
            d.setValue(parent).onChange((v) => (parent = v));
          })
    ).open();
  }
}
