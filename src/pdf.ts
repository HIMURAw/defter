import { Notice } from "obsidian";
import type { Notebook } from "./format";
import { H, W, drawStrokes, fontMetrics, lineFormats, wobble } from "./render";
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

function renderPage(root: HTMLElement, text: string, ink: Notebook["pages"][number]["ink"], n: number, look: NotebookLook) {
  const sheet = root.createDiv("defter-sheet defter-print-sheet");
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
    c.width = W * 2;
    c.height = H * 2;
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
  layer("pen");
  sheet.createDiv({ cls: "defter-pageno", text: String(n) });
}

/** Prints every page through Electron and asks where to save the PDF. */
export async function exportPdf(title: string, nb: Notebook, look: NotebookLook) {
  const remote = getRemote();
  if (!remote) {
    new Notice("PDF export needs the Obsidian desktop app.");
    return;
  }
  const notice = new Notice("Preparing PDF…", 0);
  // Obsidian's print stylesheet hides everything in <body> except ".print".
  const root = document.body.createDiv("print defter-print");
  try {
    nb.pages.forEach((p, i) => renderPage(root, p.text, p.ink, i + 1, look));
    await document.fonts.ready;
    document.body.addClass("defter-printing");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const data = await remote.getCurrentWebContents().printToPDF({
      printBackground: true,
      pageSize: { width: W / 96, height: H / 96 },
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
