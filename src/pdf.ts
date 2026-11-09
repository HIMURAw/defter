import { Notice, type App } from "obsidian";
import { applyBox, drawDecor, drawObjects, pageBox } from "./page-decor";
import type { Notebook } from "./format";
import { applyDims, drawStrokes, fontMetrics, lineFormats, pageDims, wobble } from "./render";
import { inkFor, type NotebookLook } from "./settings";

interface Remote {
  getCurrentWebContents(): { printToPDF(o: unknown): Promise<Uint8Array> };
  dialog: { showSaveDialog(o: unknown): Promise<{ canceled: boolean; filePath?: string }> };
}

function getRemote(): Remote | null {
  try {
    // Obsidian desktop exposes Electron's remote module to plugins.
    return (window as unknown as { require: (m: string) => { remote?: Remote } }).require("electron").remote ?? null;
  } catch {
    return null;
  }
}

function renderPage(app: App, root: HTMLElement, title: string, page: Notebook["pages"][number], n: number, look: NotebookLook) {
  const { text, ink } = page;
  const sheet = root.createDiv("defter-sheet defter-print-sheet");
  const d = pageDims(look.page);
  applyDims(sheet, d);
  applyBox(sheet, pageBox(page, d));
  if (page.tpl) sheet.dataset.tpl = page.tpl;
  drawDecor(sheet.createDiv("defter-decor"), page, d, title);
  sheet.dataset.paper = look.paper;
  sheet.dataset.tone = look.tone;
  const m = fontMetrics(look.font, look.scale);
  sheet.style.setProperty("--defter-family", `"${look.font.family}"`);
  sheet.style.setProperty("--defter-weight", String(look.font.weight));
  sheet.style.setProperty("--defter-size", m.size + "px");
  sheet.style.setProperty("--defter-top", m.top + "px");
  sheet.style.setProperty("--defter-ink", inkFor(look.ink, look.tone));

  const layer = (kind: "hl" | "pen") => {
    const c = sheet.createEl("canvas", { cls: "defter-layer " + (kind === "hl" ? "defter-hl" : "defter-ink") });
    c.width = d.w * 2;
    c.height = d.h * 2;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawStrokes(ctx, ink.filter((s) => s.t === kind), look.tone);
  };
  layer("hl");
  const mirror = sheet.createDiv("defter-text defter-mirror");
  for (const line of text.split("\n")) {
    const flags = lineFormats(line);
    for (let i = 0; i < line.length; i++) {
      const span = mirror.createSpan({ text: line[i] });
      span.style.top = wobble(line[i], i ? line[i - 1] : "\n") + "px";
      if (flags[i]) span.dataset.f = flags[i];
    }
    mirror.appendText("\n");
  }
  const low = sheet.createDiv("defter-objs defter-objs-low");
  layer("pen");
  const high = sheet.createDiv("defter-objs defter-objs-high");
  drawObjects(app, low, high, page, inkFor(look.ink, look.tone));
  sheet.createDiv({ cls: "defter-pageno", text: String(n) });
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
    nb.pages.forEach((p, i) => renderPage(app, root, title, p, i + 1, look));
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
