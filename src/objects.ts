// Pictures, sticky notes and formulas placed on a page.
import { Modal, Setting, finishRenderMath, loadMathJax, renderMath, type App, type TFile } from "obsidian";

/** Obsidian loads MathJax on demand; formulas wait for it. */
let mathReady: Promise<void> | null = null;
export function ensureMath(): Promise<void> {
  mathReady ??= loadMathJax();
  return mathReady;
}
import type { PageObject } from "./format";
import { T } from "./i18n";
import { easyToTex } from "./math";

export const NOTE_COLORS = ["#fff27a", "#ffc4dd", "#c8f5b4", "#bfe3ff"];
export const TAPE_COLORS = ["#f4c95d", "#f29bb7", "#8fd0a8", "#93bfef", "#b9b0a2"];
export const STAMP_COLORS = ["#c42b2b", "#1d3a8f", "#1f7a4d", "#6b3fa0"];
/** Ready-made stamps: symbol stamps are round, word stamps are framed. */
export const STAMPS = ["✓", "✗", "★", "!", "?", "IMPORTANT", "REVIEW", "EXAM", "LEARNED", "ASK"];

/** Draws one object into a page layer. */
export function renderObject(app: App, layer: HTMLElement, o: PageObject, ink: string): HTMLElement {
  const el = layer.createDiv("defter-obj defter-obj-" + o.k);
  el.style.left = o.x + "px";
  el.style.top = o.y + "px";
  el.style.width = o.w + "px";
  el.style.height = o.h + "px";
  if (o.k === "img") {
    const f = app.vault.getAbstractFileByPath(o.v);
    if (f) el.createEl("img", { attr: { src: app.vault.getResourcePath(f as TFile), draggable: "false" } });
    else el.createDiv({ cls: "defter-obj-missing", text: T("Missing image: ") + o.v });
  } else if (o.k === "tape") {
    el.style.setProperty("--tape", o.c ?? TAPE_COLORS[0]);
    el.setAttr("aria-label", T("Click to show or hide what is under the tape"));
  } else if (o.k === "stamp") {
    el.style.setProperty("--stamp", o.c ?? STAMP_COLORS[0]);
    el.toggleClass("is-symbol", [...o.v].length <= 2);
    const t = el.createDiv({ cls: "defter-stamp-text", text: o.v });
    t.style.fontSize = Math.round(o.h * ([...o.v].length <= 2 ? 0.62 : 0.42)) + "px";
  } else if (o.k === "note") {
    el.style.setProperty("--note", o.c ?? NOTE_COLORS[0]);
    el.createDiv({ cls: "defter-note-text", text: o.v });
  } else {
    el.style.color = ink;
    const inner = el.createDiv("defter-tex");
    void ensureMath().then(async () => {
      inner.appendChild(renderMath(o.v, true));
      await finishRenderMath();
      // Scale the formula to the box it was given (resizing scales it).
      requestAnimationFrame(() => {
        const w = inner.scrollWidth || 1;
        const h = inner.scrollHeight || 1;
        inner.style.transform = `scale(${Math.min(o.w / w, o.h / h)})`;
      });
    });
  }
  return el;
}

export function hitObject(objs: PageObject[], x: number, y: number): { obj: PageObject; corner: boolean } | null {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) {
      return { obj: o, corner: x > o.x + o.w - 18 && y > o.y + o.h - 18 };
    }
  }
  return null;
}

/** Saves a pasted or picked image into the vault next to the notebook's attachments. */
export async function saveImage(app: App, blob: Blob, notebook: TFile): Promise<{ path: string; w: number; h: number }> {
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const name = `Defter ${window.moment().format("YYYY-MM-DD HH.mm.ss")}.${ext}`;
  const path = await app.fileManager.getAvailablePathForAttachment(name, notebook.path);
  await app.vault.createBinary(path, await blob.arrayBuffer());
  const bmp = await createImageBitmap(blob);
  const size = { w: bmp.width, h: bmp.height };
  bmp.close();
  return { path, ...size };
}

/** Asks for LaTeX with a live preview. */
export class TexModal extends Modal {
  private value: string;
  private done: (tex: string, w: number, h: number) => void;
  /** Easy: sqrt(x)/2, x^2, pi … LaTeX: the real thing. New formulas start easy. */
  private easy: boolean;

  constructor(app: App, value: string, done: (tex: string, w: number, h: number) => void) {
    super(app);
    this.value = value;
    this.done = done;
    this.easy = !value;
  }

  private get tex() {
    return this.easy ? easyToTex(this.value) : this.value;
  }

  onOpen() {
    this.titleEl.setText(T("Formula"));
    this.modalEl.addClass("defter-tex-modal");
    const modes = this.contentEl.createDiv("defter-tex-modes");
    const preview = this.contentEl.createDiv("defter-tex-preview");
    const help = this.contentEl.createDiv("defter-tex-help");
    const draw = async () => {
      await ensureMath();
      preview.empty();
      help.setText(
        this.easy
          ? T("Write it the everyday way: sqrt(x+1)/2, x^2, x^(n+1), a_1, pi, <=, !=, abs(x), sin(x), sum, int, inf")
          : T("Type LaTeX, e.g. \\frac{a}{b}, x^2, \\sqrt{3}, \\int_0^1 f(x)\\,dx")
      );
      if (!this.value.trim()) return;
      try {
        preview.appendChild(renderMath(this.tex, true));
        void finishRenderMath();
      } catch {
        preview.setText("…");
      }
    };
    let input: HTMLTextAreaElement;
    const modeBtn = (easy: boolean, label: string) => {
      const b = modes.createEl("button", { cls: "defter-seg", text: T(label) });
      b.toggleClass("is-active", this.easy === easy);
      b.onclick = () => {
        if (this.easy === easy) return;
        // Switching to LaTeX keeps what was written, translated.
        if (!easy) this.value = easyToTex(this.value);
        this.easy = easy;
        if (easy) this.value = "";
        input.value = this.value;
        for (const el of Array.from(modes.children)) el.toggleClass("is-active", el === b);
        void draw();
        input.focus();
      };
    };
    modeBtn(true, "Easy");
    modeBtn(false, "LaTeX");
    new Setting(this.contentEl).addTextArea((t) => {
      input = t.inputEl;
      t.setValue(this.value).onChange((v) => {
        this.value = v;
        void draw();
      });
      t.inputEl.rows = 3;
      t.inputEl.addClass("defter-tex-input");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) place();
      });
      setTimeout(() => t.inputEl.focus(), 0);
    });
    const place = () => {
      if (!this.value.trim()) return;
      const math = (preview.querySelector("mjx-container") as HTMLElement | null) ?? preview;
      const r = math.getBoundingClientRect();
      this.close();
      this.done(this.tex.trim(), Math.max(40, Math.round(r.width)), Math.max(30, Math.round(r.height)));
    };
    new Setting(this.contentEl).addButton((b) => b.setButtonText(T("Place on page")).setCta().onClick(place));
    void draw();
  }

  onClose() {
    this.contentEl.empty();
  }
}
