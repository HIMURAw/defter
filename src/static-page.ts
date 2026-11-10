// A read-only page drawn with the same layers as the live one. Used for PDF
// export, page images, thumbnails, the facing page of a spread and page turns.
import type { App } from "obsidian";
import type { Notebook } from "./format";
import { applyBox, drawDecor, drawObjects, pageBox } from "./page-decor";
import { applyDims, drawStrokes, fontMetrics, lineFormats, pageDims, wobble } from "./render";
import { inkFor, type NotebookLook } from "./settings";

export function renderStaticPage(app: App, root: HTMLElement, title: string, page: Notebook["pages"][number], n: number, look: NotebookLook) {
  const { text, ink } = page;
  const sheet = root.createDiv("defter-sheet defter-static-sheet");
  const d = pageDims(look.page);
  applyDims(sheet, d);
  applyBox(sheet, pageBox(page, d));
  if (page.tpl) sheet.dataset.tpl = page.tpl;
  drawDecor(app, sheet.createDiv("defter-decor"), page, d, title);
  if (page.bg) sheet.dataset.bg = "1";
  sheet.dataset.paper = look.paper;
  sheet.dataset.binding = look.binding;
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
      if (/\b(sup|sub)\b/.test(flags[i])) span.dataset.c = line[i];
    }
    mirror.appendText("\n");
  }
  const low = sheet.createDiv("defter-objs defter-objs-low");
  layer("pen");
  const high = sheet.createDiv("defter-objs defter-objs-high");
  drawObjects(app, low, high, page, inkFor(look.ink, look.tone));
  sheet.createDiv({ cls: "defter-pageno", text: String(n) });
  return sheet;
}

