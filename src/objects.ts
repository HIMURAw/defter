// Pictures, sticky notes and formulas placed on a page.
import { Modal, Setting, finishRenderMath, loadMathJax, renderMath, type App, type TFile } from "obsidian";

/** Obsidian loads MathJax on demand; formulas wait for it. */
let mathReady: Promise<void> | null = null;
export function ensureMath(): Promise<void> {
  mathReady ??= loadMathJax();
  return mathReady;
}
import type { PageObject } from "./format";

export const NOTE_COLORS = ["#fff27a", "#ffc4dd", "#c8f5b4", "#bfe3ff"];

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
    else el.createDiv({ cls: "defter-obj-missing", text: "Missing image: " + o.v });
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

  constructor(app: App, value: string, done: (tex: string, w: number, h: number) => void) {
    super(app);
    this.value = value;
    this.done = done;
  }

  onOpen() {
    this.titleEl.setText("Formula");
    this.modalEl.addClass("defter-tex-modal");
    const preview = this.contentEl.createDiv("defter-tex-preview");
    const draw = async () => {
      await ensureMath();
      preview.empty();
      if (!this.value.trim()) {
        preview.setText("Type LaTeX, e.g. \\frac{a}{b}, x^2, \\sqrt{3}, \\int_0^1 f(x)\\,dx");
        return;
      }
      preview.appendChild(renderMath(this.value, true));
      void finishRenderMath();
    };
    let input: HTMLTextAreaElement;
    new Setting(this.contentEl).setName("LaTeX").addTextArea((t) => {
      input = t.inputEl;
      t.setValue(this.value).onChange((v) => {
        this.value = v;
        void draw();
      });
      t.inputEl.rows = 3;
      t.inputEl.addClass("defter-tex-input");
      setTimeout(() => t.inputEl.focus(), 0);
    });
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Place on page")
        .setCta()
        .onClick(() => {
          if (!this.value.trim()) return;
          const math = (preview.querySelector("mjx-container") as HTMLElement | null) ?? preview;
          const r = math.getBoundingClientRect();
          this.close();
          this.done(this.value.trim(), Math.max(40, Math.round(r.width)), Math.max(30, Math.round(r.height)));
        })
    );
    void draw();
    void input!;
  }

  onClose() {
    this.contentEl.empty();
  }
}
