import { Modal, type App } from "obsidian";
import { COVERS, FONTS, INKS, PAPERS, SIZES, TONES, inkFor } from "./settings";
import { getProp } from "./format";
import type { DefterView } from "./view";

const SAMPLE = "Türev ve İntegral: ağaç, şeker, ılık";

export class NotebookSettingsModal extends Modal {
  private view: DefterView;

  constructor(app: App, view: DefterView) {
    super(app);
    this.view = view;
  }

  onOpen() {
    this.modalEl.addClass("defter-settings-modal");
    this.titleEl.setText("Notebook settings");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private set(key: string, value: string | null) {
    this.view.setLook(key, value);
    this.render();
  }

  private section(title: string) {
    const s = this.contentEl.createDiv("defter-set-section");
    s.createDiv({ cls: "defter-set-title", text: title });
    return s.createDiv("defter-set-row");
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const look = this.view.look;

    const paper = this.section("Paper");
    for (const p of PAPERS) {
      const tile = paper.createEl("button", { cls: "defter-tile" });
      tile.toggleClass("is-active", look.paper === p.id);
      const sw = tile.createDiv("defter-tile-paper");
      sw.dataset.paper = p.id;
      sw.dataset.tone = look.tone;
      tile.createSpan({ text: p.label });
      tile.onclick = () => this.set("defter-paper", p.id);
    }

    const tone = this.section("Tone");
    for (const t of TONES) {
      const tile = tone.createEl("button", { cls: "defter-tile" });
      tile.toggleClass("is-active", look.tone === t.id);
      const sw = tile.createDiv("defter-tile-paper");
      sw.dataset.paper = look.paper;
      sw.dataset.tone = t.id;
      tile.createSpan({ text: t.label });
      tile.onclick = () => this.set("defter-tone", t.id);
    }

    const font = this.section("Handwriting");
    font.addClass("defter-set-column");
    for (const f of FONTS) {
      const row = font.createEl("button", { cls: "defter-font-row" });
      row.toggleClass("is-active", look.font.id === f.id);
      row.createSpan({ cls: "defter-font-name", text: f.label });
      const sample = row.createSpan({ cls: "defter-font-sample", text: SAMPLE });
      sample.style.fontFamily = `"${f.family}"`;
      sample.style.fontWeight = String(f.weight);
      row.onclick = () => this.set("defter-font", f.id);
    }

    const size = this.section("Text size");
    for (const z of SIZES) {
      const b = size.createEl("button", { cls: "defter-seg", text: z.label });
      b.toggleClass("is-active", Math.abs(look.scale - z.scale) < 0.001);
      b.onclick = () => this.set("defter-size", z.id);
    }

    const ink = this.section("Ink");
    for (const i of INKS) {
      const b = ink.createEl("button", { cls: "defter-swatch defter-swatch-lg", attr: { "aria-label": i.label } });
      b.style.setProperty("--swatch", inkFor(i.id, look.tone));
      b.toggleClass("is-active", look.ink === i.id);
      b.onclick = () => this.set("defter-ink", i.id);
    }

    const cover = this.section("Cover");
    for (const c of COVERS) {
      const b = cover.createEl("button", { cls: "defter-swatch defter-swatch-lg defter-swatch-cover", attr: { "aria-label": "Cover colour" } });
      b.style.setProperty("--swatch", c);
      b.toggleClass("is-active", look.cover === c);
      b.onclick = () => this.set("defter-cover", c);
    }

    const foot = contentEl.createDiv("defter-set-foot");
    foot.createSpan({ cls: "defter-set-hint", text: "Saved in this notebook's properties. Defaults are in Settings → Defter." });
    const reset = foot.createEl("button", { text: "Use defaults" });
    const keys = ["defter-paper", "defter-tone", "defter-font", "defter-size", "defter-ink", "defter-cover"];
    reset.disabled = !keys.some((k) => getProp(this.view.nb.frontmatter, k) !== null);
    reset.onclick = () => {
      for (const k of keys) this.view.nb.frontmatter = this.view.nb.frontmatter.replace(new RegExp(`^${k}:.*\\n?`, "m"), "").replace(/\n$/, "");
      this.set("defter-paper", null);
    };
  }
}
