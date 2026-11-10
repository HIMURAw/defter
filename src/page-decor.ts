// Everything drawn on a page besides text and ink: template, journal date and
// placed objects. Shared by the notebook view and PDF export.
import { TFile, type App } from "obsidian";
import type { Page } from "./format";
import { renderObject } from "./objects";
import { fmtDate } from "./settings";
import { TEXT_TOP, LINE, type PageDims } from "./render";
import { defaultBox, templateOf, type TextBox } from "./templates";

export function pageBox(page: Page, d: PageDims): TextBox {
  return templateOf(page.tpl)?.box(d) ?? defaultBox(d);
}

/** Positions the text area for this page (templates move and shrink it). */
export function applyBox(sheet: HTMLElement, box: TextBox) {
  sheet.style.setProperty("--tl", box.left + "px");
  sheet.style.setProperty("--tw", box.width + "px");
  sheet.style.setProperty("--th", box.lines * LINE + "px");
}

export function drawDecor(app: App, layer: HTMLElement, page: Page, d: PageDims, title: string) {
  layer.empty();
  if (page.bg) {
    const f = app.vault.getAbstractFileByPath(page.bg);
    if (f instanceof TFile) layer.createEl("img", { cls: "defter-bg", attr: { src: app.vault.getResourcePath(f), draggable: "false" } });
    else layer.createDiv({ cls: "defter-obj-missing defter-bg", text: "Missing page background: " + page.bg });
  }
  templateOf(page.tpl)?.draw(layer, d, title);
  if (page.date) {
    const el = layer.createDiv({ cls: "defter-date", text: fmtDate(page.date, "dddd, D MMMM YYYY") });
    el.style.top = TEXT_TOP - 44 + "px";
  }
}

export function drawObjects(app: App, low: HTMLElement, high: HTMLElement, page: Page, ink: string): Map<object, HTMLElement> {
  low.empty();
  high.empty();
  const map = new Map<object, HTMLElement>();
  for (const o of page.obj ?? []) map.set(o, renderObject(app, o.k === "note" || o.k === "tape" ? high : low, o, ink));
  return map;
}
