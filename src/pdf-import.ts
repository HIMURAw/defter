// Imports PDF pages as page backgrounds: each page is drawn once with
// Obsidian's own pdf.js and saved as a picture next to the notebook.
import { Modal, Notice, Setting, SuggestModal, TFile, loadPdfJs, type App } from "obsidian";
import { T } from "./i18n";

interface PdfSource {
  label: string;
  file?: TFile;
}

class PdfPicker extends SuggestModal<PdfSource> {
  private pick: (s: PdfSource) => void;
  constructor(app: App, pick: (s: PdfSource) => void) {
    super(app);
    this.pick = pick;
    this.setPlaceholder(T("Choose a PDF from the vault, or pick one from your computer"));
  }
  getSuggestions(q: string): PdfSource[] {
    const query = q.toLocaleLowerCase();
    const files = this.app.vault
      .getFiles()
      .filter((f) => f.extension.toLowerCase() === "pdf" && f.path.toLocaleLowerCase().includes(query))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 50)
      .map((file) => ({ label: file.path, file }));
    return [{ label: T("From my computer…") }, ...files];
  }
  renderSuggestion(s: PdfSource, el: HTMLElement) {
    el.setText(s.label);
    if (!s.file) el.addClass("defter-suggest-strong");
  }
  onChooseSuggestion(s: PdfSource) {
    this.pick(s);
  }
}

class RangeModal extends Modal {
  private count: number;
  private name: string;
  private done: (pages: number[]) => void;
  constructor(app: App, name: string, count: number, done: (pages: number[]) => void) {
    super(app);
    this.name = name;
    this.count = count;
    this.done = done;
  }
  onOpen() {
    this.titleEl.setText(T("Import {name}", { name: this.name }));
    let value = `1-${this.count}`;
    const go = () => {
      const pages = parseRange(value, this.count);
      if (!pages.length) {
        new Notice(T("No pages in that range."));
        return;
      }
      this.close();
      this.done(pages);
    };
    new Setting(this.contentEl)
      .setName(T("Pages"))
      .setDesc(T("This PDF has {n} pages. Examples: 1-5, 2, 7-9", { n: this.count }))
      .addText((t) => {
        t.setValue(value).onChange((v) => (value = v));
        t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && go());
        setTimeout(() => t.inputEl.select(), 0);
      });
    new Setting(this.contentEl)
      .setDesc(T("Each PDF page becomes a notebook page you can write and draw on. The pages are saved as pictures next to the notebook."))
      .addButton((b) => b.setButtonText(T("Import")).setCta().onClick(go));
  }
  onClose() {
    this.contentEl.empty();
  }
}

export function parseRange(src: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of src.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(max, Math.max(a, b)); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

function pickFromComputer(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.body.createEl("input", { type: "file", attr: { accept: "application/pdf,.pdf" } });
    input.style.display = "none";
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    input.click();
  });
}

export interface ImportedPage {
  path: string;
  w: number;
  h: number;
}

/** Asks for a PDF and a page range, then saves each page as a picture. */
export function importPdf(app: App, notebook: TFile, done: (pages: ImportedPage[]) => void) {
  new PdfPicker(app, (src) => {
    void (async () => {
      let data: ArrayBuffer;
      let name: string;
      if (src.file) {
        data = await app.vault.readBinary(src.file);
        name = src.file.basename;
      } else {
        const f = await pickFromComputer();
        if (!f) return;
        data = await f.arrayBuffer();
        name = f.name.replace(/\.pdf$/i, "");
      }
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
      new RangeModal(app, name, doc.numPages, (pages) => {
        void (async () => {
          const notice = new Notice(T("Importing…"), 0);
          const out: ImportedPage[] = [];
          try {
            for (const [k, n] of pages.entries()) {
              notice.setMessage(T("Importing page {n} of {total}…", { n: k + 1, total: pages.length }));
              const page = await doc.getPage(n);
              const base = page.getViewport({ scale: 1 });
              // About 2× the notebook page width, so it stays sharp when zoomed in.
              const scale = Math.min(4, 1640 / base.width);
              const vp = page.getViewport({ scale });
              const canvas = document.createElement("canvas");
              canvas.width = Math.round(vp.width);
              canvas.height = Math.round(vp.height);
              const ctx = canvas.getContext("2d")!;
              ctx.fillStyle = "#fff";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              await page.render({ canvasContext: ctx, viewport: vp }).promise;
              const blob = await new Promise<Blob>((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error("Could not draw the page"))), "image/jpeg", 0.9));
              const path = await app.fileManager.getAvailablePathForAttachment(`${name} p${n}.jpg`, notebook.path);
              await app.vault.createBinary(path, await blob.arrayBuffer());
              out.push({ path, w: canvas.width, h: canvas.height });
            }
            done(out);
          } catch (e) {
            new Notice(T("PDF import failed: ") + (e as Error).message);
            if (out.length) done(out);
          } finally {
            notice.hide();
            void doc.destroy?.();
          }
        })();
      }).open();
    })().catch((e) => new Notice(T("Could not open the PDF: ") + (e as Error).message));
  }).open();
}
