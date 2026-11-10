// Small windows: the sticker drawer and the keyboard shortcut list.
import { Modal, setIcon, type App } from "obsidian";
import { drawStrokes } from "./render";
import { NOTE_COLORS, STAMPS, STAMP_COLORS } from "./objects";
import type { Sticker, Tone } from "./settings";

export type StickerPick = { stamp: string; color: string } | { sticker: Sticker };

export class StickerModal extends Modal {
  private stickers: Sticker[];
  private tone: Tone;
  private pick: (p: StickerPick) => void;
  private remove: (s: Sticker) => void;
  private color = STAMP_COLORS[0];

  constructor(app: App, stickers: Sticker[], tone: Tone, pick: (p: StickerPick) => void, remove: (s: Sticker) => void) {
    super(app);
    this.stickers = stickers;
    this.tone = tone;
    this.pick = pick;
    this.remove = remove;
  }

  onOpen() {
    this.modalEl.addClass("defter-sticker-modal");
    this.titleEl.setText("Stickers");
    this.render();
  }

  private choose(p: StickerPick) {
    this.close();
    this.pick(p);
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "defter-set-label", text: "Stamps" });
    const colors = contentEl.createDiv("defter-set-row");
    for (const c of STAMP_COLORS) {
      const b = colors.createEl("button", { cls: "defter-swatch defter-swatch-lg", attr: { "aria-label": "Stamp colour" } });
      b.style.setProperty("--swatch", c);
      b.toggleClass("is-active", c === this.color);
      b.onclick = () => {
        this.color = c;
        this.render();
      };
    }
    const grid = contentEl.createDiv("defter-stamp-grid");
    for (const s of STAMPS) {
      const b = grid.createEl("button", { cls: "defter-stamp-pick" });
      const el = b.createDiv("defter-obj defter-obj-stamp");
      el.style.setProperty("--stamp", this.color);
      el.toggleClass("is-symbol", [...s].length <= 2);
      el.createDiv({ cls: "defter-stamp-text", text: s });
      b.onclick = () => this.choose({ stamp: s, color: this.color });
    }
    const custom = contentEl.createDiv("defter-stamp-custom");
    const input = custom.createEl("input", { type: "text", attr: { placeholder: "Your own stamp, e.g. DONE", maxlength: "18" } });
    const add = custom.createEl("button", { text: "Add stamp" });
    const go = () => input.value.trim() && this.choose({ stamp: input.value.trim().toLocaleUpperCase(), color: this.color });
    add.onclick = go;
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());

    contentEl.createDiv({ cls: "defter-set-label", text: "My stickers" });
    if (!this.stickers.length) {
      contentEl.createDiv({
        cls: "defter-empty",
        text: "Select a drawing with the lasso and press “Save as sticker” to reuse it in any notebook.",
      });
      return;
    }
    const mine = contentEl.createDiv("defter-sticker-grid");
    for (const st of this.stickers) {
      const cell = mine.createDiv("defter-sticker-cell");
      const canvas = cell.createEl("canvas");
      const size = 96;
      canvas.width = size * 2;
      canvas.height = size * 2;
      const ctx = canvas.getContext("2d")!;
      const s = Math.min((size - 8) / Math.max(1, st.w), (size - 8) / Math.max(1, st.h));
      ctx.setTransform(2 * s, 0, 0, 2 * s, ((size - st.w * s) / 2) * 2, ((size - st.h * s) / 2) * 2);
      for (const o of st.obj) {
        ctx.fillStyle = o.k === "note" ? (o.c ?? NOTE_COLORS[0]) : "rgba(128,128,128,0.25)";
        ctx.fillRect(o.x, o.y, o.w, o.h);
      }
      drawStrokes(ctx, st.ink, this.tone);
      canvas.onclick = () => this.choose({ sticker: st });
      const del = cell.createEl("button", { cls: "defter-sticker-del clickable-icon", attr: { "aria-label": "Delete sticker" } });
      setIcon(del, "x");
      del.onclick = () => {
        this.remove(st);
        this.stickers = this.stickers.filter((x) => x !== st);
        this.render();
      };
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Tools",
    [
      ["Alt+1", "Write (type in handwriting)"],
      ["Alt+2", "Pen"],
      ["Alt+3", "Highlighter"],
      ["Alt+4", "Eraser"],
      ["Alt+5", "Shapes"],
      ["Alt+6", "Select and move (lasso)"],
      ["Alt+7", "Write pad (write with the mouse or touchpad)"],
      ["Shift + draw", "Straight line with the pen; square, circle with shapes"],
      ["Draw and hold", "Turns the line into a clean line, triangle, box or circle"],
    ],
  ],
  [
    "Writing",
    [
      ["# text", "Heading"],
      ["**text**", "Bold"],
      ["==text==", "Marker"],
      ["- text", "List"],
      ["[ ] text", "To-do box (click it to tick)"],
      ["front :: back", "Flashcard"],
      ["[[note]]", "Link (Ctrl+click opens)"],
    ],
  ],
  [
    "Selection",
    [
      ["Ctrl+C / Ctrl+V", "Copy and paste, also to another page or notebook"],
      ["Ctrl+D", "Duplicate"],
      ["Ctrl+A", "Select everything on the page"],
      ["Delete", "Delete"],
    ],
  ],
  [
    "Pages and view",
    [
      ["Page Down / Page Up", "Next / previous page"],
      ["Ctrl+wheel, Ctrl+= / Ctrl+-", "Zoom"],
      ["Ctrl+0", "Fit the page"],
      ["Ctrl+F", "Search this notebook"],
      ["Alt+F", "Focus mode"],
      ["Alt+S", "Study mode: hide highlighted text and card answers"],
      ["Ctrl+Z / Ctrl+Y", "Undo / redo drawing"],
      ["F1", "This list"],
    ],
  ],
  [
    "Write pad, touchpad mode",
    [
      ["Hold Space", "Ink flows while the finger moves"],
      ["← → Enter", "Move the frame, next line"],
      ["Esc", "Leave touchpad mode, then close the pad"],
    ],
  ],
];

export class HelpModal extends Modal {
  onOpen() {
    this.modalEl.addClass("defter-help-modal");
    this.titleEl.setText("Keyboard shortcuts");
    for (const [group, rows] of SHORTCUTS) {
      this.contentEl.createDiv({ cls: "defter-set-label", text: group });
      const table = this.contentEl.createDiv("defter-help-table");
      for (const [k, v] of rows) {
        table.createEl("kbd", { text: k });
        table.createSpan({ text: v });
      }
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}
