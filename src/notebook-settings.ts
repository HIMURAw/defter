import { Modal, type App } from "obsidian";
import { BINDINGS, COVERS, COVER_STYLES, FONTS, INKS, PAGE_SIZES, PAPERS, SIZES, TONES, inkFor } from "./settings";
import { getProp } from "./format";
import type { DefterView } from "./view";
import { T } from "./i18n";

const SAMPLE = "Türev ve İntegral: ağaç, şeker, ılık";

export class NotebookSettingsModal extends Modal {
  private view: DefterView;

  constructor(app: App, view: DefterView) {
    super(app);
    this.view = view;
  }

  onOpen() {
    this.modalEl.addClass("defter-settings-modal");
    this.titleEl.setText(T("Notebook settings"));
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
    s.createDiv({ cls: "defter-set-title", text: T(title) });
    return s.createDiv("defter-set-row");
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const look = this.view.look;

    const page = this.section("Page size");
    for (const p of PAGE_SIZES) {
      const b = page.createEl("button", { cls: "defter-seg", text: T(p.label) });
      b.toggleClass("is-active", look.page === p.id);
      b.onclick = () => this.set("defter-page", p.id);
    }

    const paper = this.section("Paper");
    for (const p of PAPERS) {
      const tile = paper.createEl("button", { cls: "defter-tile" });
      tile.toggleClass("is-active", look.paper === p.id);
      const sw = tile.createDiv("defter-tile-paper");
      sw.dataset.paper = p.id;
      sw.dataset.tone = look.tone;
      tile.createSpan({ text: T(p.label) });
      tile.onclick = () => this.set("defter-paper", p.id);
    }

    const tone = this.section("Tone");
    for (const t of TONES) {
      const tile = tone.createEl("button", { cls: "defter-tile" });
      tile.toggleClass("is-active", look.tone === t.id);
      const sw = tile.createDiv("defter-tile-paper");
      sw.dataset.paper = look.paper;
      sw.dataset.tone = t.id;
      tile.createSpan({ text: T(t.label) });
      tile.onclick = () => this.set("defter-tone", t.id);
    }

    const binding = this.section("Binding");
    for (const b of BINDINGS) {
      const btn = binding.createEl("button", { cls: "defter-seg", text: T(b.label) });
      btn.toggleClass("is-active", look.binding === b.id);
      btn.onclick = () => this.set("defter-binding", b.id);
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
      const b = size.createEl("button", { cls: "defter-seg", text: T(z.label) });
      b.toggleClass("is-active", Math.abs(look.scale - z.scale) < 0.001);
      b.onclick = () => this.set("defter-size", z.id);
    }

    const ink = this.section("Ink");
    for (const i of INKS) {
      const b = ink.createEl("button", { cls: "defter-swatch defter-swatch-lg", attr: { "aria-label": T(i.label) } });
      b.style.setProperty("--swatch", inkFor(i.id, look.tone));
      b.toggleClass("is-active", look.ink === i.id);
      b.onclick = () => this.set("defter-ink", i.id);
    }

    const cover = this.section("Cover");
    for (const c of COVERS) {
      const b = cover.createEl("button", { cls: "defter-swatch defter-swatch-lg defter-swatch-cover", attr: { "aria-label": T("Cover colour") } });
      b.style.setProperty("--swatch", c);
      b.toggleClass("is-active", look.cover === c);
      b.onclick = () => this.set("defter-cover", c);
    }

    const style = this.section("Cover style");
    for (const c of COVER_STYLES) {
      const b = style.createEl("button", { cls: "defter-seg", text: T(c.label) });
      b.toggleClass("is-active", look.coverStyle === c.id);
      b.onclick = () => this.set("defter-cover-style", c.id);
    }

    const foot = contentEl.createDiv("defter-set-foot");
    foot.createSpan({ cls: "defter-set-hint", text: T("Saved in this notebook's properties. Defaults are in Settings → Defter.") });
    const reset = foot.createEl("button", { text: T("Use defaults") });
    const keys = ["defter-page", "defter-paper", "defter-tone", "defter-font", "defter-size", "defter-ink", "defter-cover", "defter-binding", "defter-cover-style"];
    reset.disabled = !keys.some((k) => getProp(this.view.nb.frontmatter, k) !== null);
    reset.onclick = () => {
      for (const k of keys) this.view.nb.frontmatter = this.view.nb.frontmatter.replace(new RegExp(`^${k}:.*\\n?`, "m"), "").replace(/\n$/, "");
      this.set("defter-paper", null);
    };
  }
}
