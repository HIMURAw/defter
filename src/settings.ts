import { App, PluginSettingTab, Setting } from "obsidian";
import { getProp, type PageObject, type Stroke } from "./format";
import type { CardState } from "./cards";
import { LANGUAGES, T, setLanguage } from "./i18n";

/** A drawing saved for reuse, stored with its top-left corner at 0,0. */
export interface Sticker {
  id: string;
  ink: Stroke[];
  obj: PageObject[];
  w: number;
  h: number;
}

export type SpreadMode = "auto" | "single" | "spread";

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
  /** Flashcard progress: notebook path → card front → state. */
  cards: Record<string, Record<string, CardState>>;
  /** Study minutes: notebook path → day → minutes. */
  study: Record<string, Record<string, number>>;
  stickers: Sticker[];
  /** Write pad: touchpad speed multiplier. */
  padSpeed: number;
  /** Language of written dates: "" follows Obsidian. */
  dateLocale: string;
  pageTurn: boolean;
  spread: SpreadMode;
  /** Interface language: "auto" follows Obsidian. */
  language: string;
  /** Maths: \\sqrt → √, <= → ≤ while typing. */
  mathShortcuts: boolean;
  /** Maths: Tab after "12*3 =" writes the result. */
  calculator: boolean;
  /** Library shows private (locked) notebooks. */
  showPrivate: boolean;
  /** Private notebooks lock after this many idle minutes (0 = only when closed). */
  lockMinutes: number;
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
  cards: {},
  study: {},
  stickers: [],
  padSpeed: 1,
  dateLocale: "",
  pageTurn: true,
  spread: "auto",
  language: "auto",
  mathShortcuts: true,
  calculator: true,
  showPrivate: false,
  lockMinutes: 10,
};

/** Settings fields that hold objects and must not be shared with the defaults. */
export function freshSettings(saved: Partial<DefterSettings> | null): DefterSettings {
  const s = { ...DEFAULT_SETTINGS, ...(saved ?? {}) } as DefterSettings;
  s.lastPage = { ...(s.lastPage ?? {}) };
  s.bookcases = [...(s.bookcases ?? [])];
  s.caseOrder = [...(s.caseOrder ?? [])];
  s.bookOrder = { ...(s.bookOrder ?? {}) };
  s.cards = { ...(s.cards ?? {}) };
  s.study = { ...(s.study ?? {}) };
  s.stickers = [...(s.stickers ?? [])];
  return s;
}

let dateLocale = "";
export function setDateLocale(l: string) {
  dateLocale = l;
}
/** Formats a YYYY-MM-DD day in the chosen date language. */
export function fmtDate(day: string, format: string): string {
  const m = window.moment(day, "YYYY-MM-DD");
  if (!m.isValid()) return day;
  if (dateLocale) m.locale(dateLocale);
  return m.format(format);
}

export const DATE_LOCALES: [string, string][] = [
  ["", "Same as Obsidian"],
  ["en", "English"],
  ["tr", "Türkçe"],
  ["de", "Deutsch"],
  ["fr", "Français"],
  ["es", "Español"],
];

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
    new Setting(containerEl)
      .setName(T("Language"))
      .setDesc(T("Language of menus and buttons. Reopen notebooks to see the change everywhere."))
      .addDropdown((d) => {
        for (const [id, label] of LANGUAGES) d.addOption(id, T(label));
        d.setValue(s.language).onChange(async (v) => {
          s.language = v;
          setLanguage(v);
          await save();
          this.display();
        });
      });
    containerEl.createEl("p", {
      text: T("Defaults for notebooks. Each notebook can override these from its own settings (the sliders icon in the notebook header)."),
      cls: "setting-item-description",
    });

    new Setting(containerEl).setName(T("Page size")).addDropdown((d) => {
      for (const p of PAGE_SIZES) d.addOption(p.id, T(p.label));
      d.setValue(s.page).onChange(async (v) => ((s.page = v as PageSize), await save()));
    });
    new Setting(containerEl).setName(T("Paper")).addDropdown((d) => {
      for (const p of PAPERS) d.addOption(p.id, T(p.label));
      d.setValue(s.paper).onChange(async (v) => ((s.paper = v as Paper), await save()));
    });
    new Setting(containerEl).setName(T("Paper tone")).addDropdown((d) => {
      for (const t of TONES) d.addOption(t.id, T(t.label));
      d.setValue(s.tone).onChange(async (v) => ((s.tone = v as Tone), await save()));
    });
    new Setting(containerEl).setName(T("Handwriting")).addDropdown((d) => {
      for (const f of FONTS) d.addOption(f.id, T(f.label));
      d.setValue(s.font).onChange(async (v) => ((s.font = v as FontId), await save()));
    });
    new Setting(containerEl).setName(T("Text size")).addDropdown((d) => {
      for (const z of SIZES) d.addOption(z.id, T(z.label));
      d.setValue(s.size).onChange(async (v) => ((s.size = v as SizeId), await save()));
    });
    new Setting(containerEl).setName(T("Ink colour")).addDropdown((d) => {
      for (const i of INKS) d.addOption(i.id, T(i.label));
      d.setValue(s.ink).onChange(async (v) => ((s.ink = v), await save()));
    });
    new Setting(containerEl)
      .setName(T("Writing animation"))
      .setDesc(T("How fast each letter is drawn as you type."))
      .addDropdown((d) => {
        d.addOption("off", T("Off")).addOption("fast", T("Fast")).addOption("normal", T("Normal")).addOption("slow", T("Slow"));
        d.setValue(s.anim).onChange(async (v) => ((s.anim = v as AnimSpeed), await save()));
      });

    new Setting(containerEl).setName(T("Maths")).setHeading();
    new Setting(containerEl)
      .setName(T("Symbol shortcuts"))
      .setDesc(T("While typing, \\sqrt becomes √, \\pi π, <= ≤, != ≠, -> → and so on."))
      .addToggle((t) => t.setValue(s.mathShortcuts).onChange(async (v) => ((s.mathShortcuts = v), await save())));
    new Setting(containerEl)
      .setName(T("Calculator"))
      .setDesc(T("Write a calculation ending with = (e.g. 12*3+4 =) and press Tab to write the result."))
      .addToggle((t) => t.setValue(s.calculator).onChange(async (v) => ((s.calculator = v), await save())));

    new Setting(containerEl).setName(T("Private notebooks")).setHeading();
    new Setting(containerEl)
      .setName(T("Show private notebooks in the library"))
      .setDesc(T("Private notebooks are hidden from the library unless this is on. “Open private notebook…” in the command palette always works."))
      .addToggle((t) => t.setValue(s.showPrivate).onChange(async (v) => ((s.showPrivate = v), await save())));
    new Setting(containerEl)
      .setName(T("Lock after"))
      .setDesc(T("An open private notebook locks itself after this many minutes without use."))
      .addDropdown((d) => {
        for (const m of [1, 5, 10, 30, 60]) d.addOption(String(m), T("{n} min", { n: m }));
        d.addOption("0", T("Only when closed"));
        d.setValue(String(s.lockMinutes)).onChange(async (v) => ((s.lockMinutes = Number(v)), await save()));
      });

    new Setting(containerEl).setName(T("Pages")).setHeading();
    new Setting(containerEl)
      .setName(T("Two-page spread"))
      .setDesc(T("Show two pages side by side like an open book. Auto does it when the pane is wide enough."))
      .addDropdown((d) => {
        d.addOption("auto", T("Auto")).addOption("single", T("Always one page")).addOption("spread", T("Always two pages"));
        d.setValue(s.spread).onChange(async (v) => ((s.spread = v as SpreadMode), await save()));
      });
    new Setting(containerEl)
      .setName(T("Page turn animation"))
      .addToggle((t) => t.setValue(s.pageTurn).onChange(async (v) => ((s.pageTurn = v), await save())));
    new Setting(containerEl)
      .setName(T("Date language"))
      .setDesc(T("Language of the dates written on journal pages."))
      .addDropdown((d) => {
        for (const [id, label] of DATE_LOCALES) d.addOption(id, T(label));
        d.setValue(s.dateLocale).onChange(async (v) => ((s.dateLocale = v), setDateLocale(v), await save()));
      });
    new Setting(containerEl)
      .setName(T("Touchpad speed"))
      .setDesc(T("How far the pen moves for a finger movement in the write pad's touchpad mode."))
      .addSlider((sl) =>
        sl
          .setLimits(0.4, 2.5, 0.1)
          .setValue(s.padSpeed)
          .setDynamicTooltip()
          .onChange(async (v) => ((s.padSpeed = v), await this.host.saveSettings()))
      );
  }
}
