import { Notice, type App } from "obsidian";
import type { Notebook } from "./format";
import { pageDims } from "./render";
import type { NotebookLook } from "./settings";
import { renderStaticPage } from "./static-page";

export interface Remote {
  getCurrentWebContents(): {
    printToPDF(o: unknown): Promise<Uint8Array>;
    capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{ toPNG(): Uint8Array }>;
  };
  dialog: { showSaveDialog(o: unknown): Promise<{ canceled: boolean; filePath?: string }> };
}

export function getRemote(): Remote | null {
  try {
    // Obsidian desktop exposes Electron's remote module to plugins.
    return (window as unknown as { require: (m: string) => { remote?: Remote } }).require("electron").remote ?? null;
  } catch {
    return null;
  }
}

/** Prints every page through Electron and asks where to save the PDF. */
export async function exportPdf(app: App, title: string, nb: Notebook, look: NotebookLook) {
  const remote = getRemote();
  if (!remote) {
    new Notice("PDF export needs the Obsidian desktop app.");
    return;
  }
  const notice = new Notice("Preparing PDF…", 0);
  // Obsidian's print stylesheet hides everything in <body> except ".print".
  const root = document.body.createDiv("print defter-print");
  try {
    nb.pages.forEach((p, i) => renderStaticPage(app, root, title, p, i + 1, look).addClass("defter-print-sheet"));
    await document.fonts.ready;
    // Let pictures load and formulas lay out before printing.
    await Promise.all([...root.querySelectorAll("img")].map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
    await new Promise((r) => setTimeout(r, 300));
    document.body.addClass("defter-printing");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const data = await remote.getCurrentWebContents().printToPDF({
      printBackground: true,
      pageSize: { width: pageDims(look.page).w / 96, height: pageDims(look.page).h / 96 },
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    document.body.removeClass("defter-printing");
    root.remove();
    notice.hide();
    const res = await remote.dialog.showSaveDialog({
      defaultPath: `${title}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (res.canceled || !res.filePath) return;
    const fs = (window as unknown as { require: (m: string) => { writeFileSync(p: string, d: Uint8Array): void } }).require("fs");
    fs.writeFileSync(res.filePath, data);
    new Notice(`Saved ${res.filePath}`);
  } catch (e) {
    new Notice("PDF export failed: " + (e as Error).message);
  } finally {
    document.body.removeClass("defter-printing");
    root.remove();
    notice.hide();
  }
}
