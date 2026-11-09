import { App, PluginSettingTab, Setting } from "obsidian";
import { getProp } from "./format";

export type Paper = "ruled" | "grid" | "dots" | "blank";
export type Tone = "cream" | "white" | "dark";
export type FontId = "caveat" | "kalam" | "patrick" | "shantell";
export type SizeId = "small" | "medium" | "large";
export type AnimSpeed = "off" | "fast" | "normal" | "slow";
export type PageSize = "a4" | "b5" | "a5" | "square";

export const PAGE_SIZES: { id: PageSize; label: string }[] = [
  { id: "a4", label: "A4" },
  { id: "b5", label: "B5" },
  { id: "a5", label: "A5" },
  { id: "square", label: "Square" },
];

export interface FontDef {
  id: FontId;
  label: string;
  family: string;
  weight: number;
}

export const FONTS: FontDef[] = [
  { id: "caveat", label: "Caveat", family: "Defter Caveat", weight: 500 },
  { id: "kalam", label: "Kalam", family: "Defter Kalam", weight: 400 },
  { id: "patrick", label: "Patrick Hand", family: "Defter Patrick", weight: 400 },
  { id: "shantell", label: "Shantell Sans", family: "Defter Shantell", weight: 400 },
];

export const PAPERS: { id: Paper; label: string }[] = [
  { id: "ruled", label: "Ruled" },
  { id: "grid", label: "Grid" },
  { id: "dots", label: "Dots" },
  { id: "blank", label: "Blank" },
];

export const TONES: { id: Tone; label: string }[] = [
  { id: "cream", label: "Cream" },
  { id: "white", label: "White" },
  { id: "dark", label: "Dark" },
];

export const SIZES: { id: SizeId; label: string; scale: number }[] = [
  { id: "small", label: "Small", scale: 0.88 },
  { id: "medium", label: "Medium", scale: 1 },
  { id: "large", label: "Large", scale: 1.12 },
];

export const ANIM: Record<AnimSpeed, number> = { off: 0, fast: 90, normal: 170, slow: 320 };

/** Ink colours. On dark paper each is drawn with its light partner. */
export const INKS: { id: string; label: string; dark: string }[] = [
  { id: "#1d3a8f", label: "Blue", dark: "#a9bcff" },
  { id: "#1b1b1f", label: "Black", dark: "#ececec" },
  { id: "#c42b2b", label: "Red", dark: "#ff8f8f" },
  { id: "#1f7a4d", label: "Green", dark: "#86e0b0" },
  { id: "#6b3fa0", label: "Purple", dark: "#cfb0ff" },
];

export const HIGHLIGHTS = ["#ffe14d", "#ff9ec7", "#8ee88e", "#8fd3ff"];

export const COVERS = ["#2f4f7f", "#8c2f39", "#2e6b4f", "#b7692c", "#5b3f8c", "#3d3d3d", "#2f7f7a", "#a63d6b"];

/** A cover colour derived from the name, so new notebooks are not all alike. */
export function defaultCover(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COVERS[h % COVERS.length];
}

export function inkFor(color: string, tone: Tone): string {
  if (tone !== "dark") return color;
  return INKS.find((i) => i.id === color)?.dark ?? color;
}

export interface DefterSettings {
  page: PageSize;
  paper: Paper;
  tone: Tone;
  font: FontId;
  size: SizeId;
  ink: string;
  anim: AnimSpeed;
  lastPage: Record<string, number>;
  /** Bookcase folders the user created, kept even while empty. */
  bookcases: string[];
  caseOrder: string[];
  /** Book order per bookcase folder: file names. */
  bookOrder: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: DefterSettings = {
  page: "a4",
  paper: "ruled",
  tone: "cream",
  font: "caveat",
  size: "medium",
  ink: INKS[0].id,
  anim: "normal",
  lastPage: {},
  bookcases: [],
  caseOrder: [],
  bookOrder: {},
};

export interface NotebookLook {
  page: PageSize;
  paper: Paper;
  tone: Tone;
  font: FontDef;
  scale: number;
  ink: string;
  cover: string;
}

const pick = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Per-notebook look: frontmatter wins, plugin settings fill the gaps. */
export function resolveLook(frontmatter: string, name: string, s: DefterSettings): NotebookLook {
  const fontId = pick(getProp(frontmatter, "defter-font"), FONTS.map((f) => f.id), s.font);
  const sizeId = pick(getProp(frontmatter, "defter-size"), SIZES.map((z) => z.id), s.size);
  const ink = getProp(frontmatter, "defter-ink");
  const cover = getProp(frontmatter, "defter-cover");
  return {
    page: pick(getProp(frontmatter, "defter-page"), PAGE_SIZES.map((p) => p.id), s.page),
    paper: pick(getProp(frontmatter, "defter-paper"), PAPERS.map((p) => p.id), s.paper),
    tone: pick(getProp(frontmatter, "defter-tone"), TONES.map((t) => t.id), s.tone),
    font: FONTS.find((f) => f.id === fontId)!,
    scale: SIZES.find((z) => z.id === sizeId)!.scale,
    ink: ink && /^#[0-9a-f]{6}$/i.test(ink) ? ink : s.ink,
    cover: cover && /^#[0-9a-f]{6}$/i.test(cover) ? cover : defaultCover(name),
  };
}

export interface SettingsHost {
  app: App;
  settings: DefterSettings;
  saveSettings(): Promise<void>;
  refreshViews(): void;
}

export class DefterSettingTab extends PluginSettingTab {
  private host: SettingsHost;

  constructor(app: App, plugin: SettingsHost & ConstructorParameters<typeof PluginSettingTab>[1]) {
    super(app, plugin);
    this.host = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.host.settings;
    const save = async () => {
      await this.host.saveSettings();
      this.host.refreshViews();
    };
    containerEl.createEl("p", {
      text: "Defaults for notebooks. Each notebook can override these from its own settings (the sliders icon in the notebook header).",
      cls: "setting-item-description",
    });

    new Setting(containerEl).setName("Page size").addDropdown((d) => {
      for (const p of PAGE_SIZES) d.addOption(p.id, p.label);
      d.setValue(s.page).onChange(async (v) => ((s.page = v as PageSize), await save()));
    });
    new Setting(containerEl).setName("Paper").addDropdown((d) => {
      for (const p of PAPERS) d.addOption(p.id, p.label);
      d.setValue(s.paper).onChange(async (v) => ((s.paper = v as Paper), await save()));
    });
    new Setting(containerEl).setName("Paper tone").addDropdown((d) => {
      for (const t of TONES) d.addOption(t.id, t.label);
      d.setValue(s.tone).onChange(async (v) => ((s.tone = v as Tone), await save()));
    });
    new Setting(containerEl).setName("Handwriting").addDropdown((d) => {
      for (const f of FONTS) d.addOption(f.id, f.label);
      d.setValue(s.font).onChange(async (v) => ((s.font = v as FontId), await save()));
    });
    new Setting(containerEl).setName("Text size").addDropdown((d) => {
      for (const z of SIZES) d.addOption(z.id, z.label);
      d.setValue(s.size).onChange(async (v) => ((s.size = v as SizeId), await save()));
    });
    new Setting(containerEl).setName("Ink colour").addDropdown((d) => {
      for (const i of INKS) d.addOption(i.id, i.label);
      d.setValue(s.ink).onChange(async (v) => ((s.ink = v), await save()));
    });
    new Setting(containerEl)
      .setName("Writing animation")
      .setDesc("How fast each letter is drawn as you type.")
      .addDropdown((d) => {
        d.addOption("off", "Off").addOption("fast", "Fast").addOption("normal", "Normal").addOption("slow", "Slow");
        d.setValue(s.anim).onChange(async (v) => ((s.anim = v as AnimSpeed), await save()));
      });
  }
}
