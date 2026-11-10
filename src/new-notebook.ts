import { Modal, Setting, TFolder, normalizePath, type App } from "obsidian";
import { emptyNotebook, serializeNotebook, setProp } from "./format";
import { COVERS, PAGE_SIZES, PAPERS, defaultCover, type DefterSettings } from "./settings";
import { T } from "./i18n";

export function todayStr(): string {
  return window.moment().format("YYYY-MM-DD");
}

export interface NewNotebookResult {
  path: string;
}

/** One window for everything a new notebook needs: name, kind, place, size, paper, cover. */
export class NewNotebookModal extends Modal {
  private folder: TFolder;
  private settings: DefterSettings;
  private done: (path: string) => void;
  private journal: boolean;

  constructor(app: App, folder: TFolder, settings: DefterSettings, done: (path: string) => void, journal = false) {
    super(app);
    this.folder = folder;
    this.settings = settings;
    this.done = done;
    this.journal = journal;
  }

  onOpen() {
    this.modalEl.addClass("defter-settings-modal");
    this.titleEl.setText(T(this.journal ? "New journal" : "New notebook"));
    let name = this.journal ? T("Journal") : "";
    let folder = this.folder.path;
    let page = this.settings.page as string;
    let paper = this.settings.paper as string;
    let cover = "";
    let journal = this.journal;
    const { contentEl } = this;

    new Setting(contentEl).setName(T("Name")).addText((t) => {
      t.setPlaceholder(T("e.g. Matematik")).setValue(name).onChange((v) => (name = v));
      t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && void create());
      setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(contentEl)
      .setName(T("Journal"))
      .setDesc(T("One page per day; opens on today's page with the date written at the top."))
      .addToggle((t) => t.setValue(journal).onChange((v) => (journal = v)));
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.path.startsWith("."))
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b, "tr"));
    new Setting(contentEl)
      .setName(T("Bookcase"))
      .setDesc(T("The folder the notebook is saved in."))
      .addDropdown((d) => {
        for (const p of folders) d.addOption(p, p === "/" ? T("Vault (top level)") : p);
        d.setValue(folder).onChange((v) => (folder = v));
      });
    new Setting(contentEl).setName(T("Page size")).addDropdown((d) => {
      for (const p of PAGE_SIZES) d.addOption(p.id, T(p.label));
      d.setValue(page).onChange((v) => (page = v));
    });
    new Setting(contentEl).setName(T("Paper")).addDropdown((d) => {
      for (const p of PAPERS) d.addOption(p.id, T(p.label));
      d.setValue(paper).onChange((v) => (paper = v));
    });
    const coverRow = new Setting(contentEl).setName(T("Cover")).controlEl;
    coverRow.addClass("defter-set-row");
    const drawCovers = () => {
      coverRow.empty();
      const current = cover || defaultCover(name || "Untitled");
      for (const c of COVERS) {
        const b = coverRow.createEl("button", { cls: "defter-swatch defter-swatch-lg defter-swatch-cover", attr: { "aria-label": T("Cover colour") } });
        b.style.setProperty("--swatch", c);
        b.toggleClass("is-active", c === current);
        b.onclick = () => {
          cover = c;
          drawCovers();
        };
      }
    };
    drawCovers();

    const create = async () => {
      const base = (name.trim() || T(journal ? "Journal" : "Untitled notebook")).replace(/[\\/:*?"<>|#^[\]]/g, "");
      const dir = folder === "/" ? "" : folder + "/";
      let file = base;
      for (let i = 2; this.app.vault.getAbstractFileByPath(normalizePath(`${dir}${file}.md`)); i++) file = `${base} ${i}`;
      const nb = emptyNotebook();
      if (page !== this.settings.page) nb.frontmatter = setProp(nb.frontmatter, "defter-page", page);
      if (paper !== this.settings.paper) nb.frontmatter = setProp(nb.frontmatter, "defter-paper", paper);
      if (cover) nb.frontmatter = setProp(nb.frontmatter, "defter-cover", cover);
      if (journal) {
        nb.frontmatter = setProp(nb.frontmatter, "defter-journal", "true");
        nb.pages[0].date = todayStr();
      }
      const path = normalizePath(`${dir}${file}.md`);
      await this.app.vault.create(path, serializeNotebook(nb));
      this.close();
      this.done(path);
    };
    new Setting(contentEl).addButton((b) => b.setButtonText(T("Create")).setCta().onClick(() => void create()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Month view: days with journal pages are marked, click to jump. */
export class CalendarModal extends Modal {
  private dates: Set<string>;
  private month: moment.Moment;
  private pick: (date: string) => void;

  constructor(app: App, dates: string[], current: string | undefined, pick: (date: string) => void) {
    super(app);
    this.dates = new Set(dates);
    this.month = window.moment(current ?? todayStr()).startOf("month");
    this.pick = pick;
  }

  onOpen() {
    this.modalEl.addClass("defter-cal-modal");
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(this.month.format("MMMM YYYY"));
    const nav = contentEl.createDiv("defter-cal-nav");
    const prev = nav.createEl("button", { text: T("‹") });
    const today = nav.createEl("button", { text: T("Today") });
    const next = nav.createEl("button", { text: T("›") });
    prev.onclick = () => ((this.month = this.month.clone().subtract(1, "month")), this.render());
    next.onclick = () => ((this.month = this.month.clone().add(1, "month")), this.render());
    today.onclick = () => {
      this.close();
      this.pick(todayStr());
    };
    const grid = contentEl.createDiv("defter-cal-grid");
    const start = this.month.clone().startOf("week");
    for (let i = 0; i < 7; i++) grid.createDiv({ cls: "defter-cal-dow", text: start.clone().add(i, "day").format("dd") });
    const end = this.month.clone().endOf("month").endOf("week");
    const t = todayStr();
    for (let d = start.clone(); d.isSameOrBefore(end, "day"); d.add(1, "day")) {
      const key = d.format("YYYY-MM-DD");
      const cell = grid.createEl("button", { cls: "defter-cal-day", text: d.format("D") });
      cell.toggleClass("is-other", d.month() !== this.month.month());
      cell.toggleClass("has-page", this.dates.has(key));
      cell.toggleClass("is-today", key === t);
      const can = this.dates.has(key) || key === t;
      cell.disabled = !can;
      if (can)
        cell.onclick = () => {
          this.close();
          this.pick(key);
        };
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
