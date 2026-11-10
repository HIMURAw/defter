// Page templates: a few guide lines and labels drawn on the paper, and the
// part of the page where typed text goes.
import { LINE, TEXT_TOP, type PageDims } from "./render";
import { T } from "./i18n";

export interface TextBox {
  left: number;
  width: number;
  lines: number;
}

export interface TemplateDef {
  id: string;
  label: string;
  desc: string;
  box(d: PageDims): TextBox;
  draw(el: HTMLElement, d: PageDims, title: string): void;
}

const LEFT = 96;
const RIGHT = 44;

function line(el: HTMLElement, x1: number, y1: number, x2: number, y2: number, cls = "") {
  const l = el.createDiv("defter-tpl-line " + cls);
  l.style.left = Math.min(x1, x2) + "px";
  l.style.top = Math.min(y1, y2) + "px";
  l.style.width = Math.max(2, Math.abs(x2 - x1)) + "px";
  l.style.height = Math.max(2, Math.abs(y2 - y1)) + "px";
}

function label(el: HTMLElement, text: string, x: number, y: number, cls = "") {
  const t = el.createDiv({ cls: "defter-tpl-label " + cls, text });
  t.style.left = x + "px";
  t.style.top = y + "px";
  return t;
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "cornell",
    label: "Cornell notes",
    desc: "Cue column on the left, notes on the right, summary at the bottom.",
    box: (d) => {
      const cue = Math.round(d.w * 0.3);
      return { left: cue + 16, width: d.w - cue - 16 - RIGHT, lines: Math.max(4, d.lines - 5) };
    },
    draw: (el, d) => {
      const cue = Math.round(d.w * 0.3);
      const bottom = TEXT_TOP + (d.lines - 5) * LINE;
      line(el, cue, 40, cue, bottom, "is-strong");
      line(el, 24, bottom, d.w - 24, bottom, "is-strong");
      label(el, T("Cues"), 30, 34);
      label(el, T("Notes"), cue + 16, 34);
      label(el, T("Summary"), 30, bottom + 8);
    },
  },
  {
    id: "qa",
    label: "Question & solution",
    desc: "Write the question on the left, work the solution with the pen on the right.",
    box: (d) => ({ left: LEFT, width: Math.round(d.w / 2) - LEFT - 12, lines: d.lines }),
    draw: (el, d) => {
      const mid = Math.round(d.w / 2);
      line(el, mid, 40, mid, d.h - 40, "is-strong");
      label(el, T("Question"), LEFT, 34);
      label(el, T("Solution"), mid + 16, 34);
    },
  },
  {
    id: "formula",
    label: "Formula sheet",
    desc: "A framed page for formulas and rules, in two columns.",
    box: (d) => ({ left: LEFT, width: d.w - LEFT - RIGHT, lines: d.lines }),
    draw: (el, d) => {
      const f = el.createDiv("defter-tpl-frame");
      f.style.left = "28px";
      f.style.top = "28px";
      f.style.width = d.w - 56 + "px";
      f.style.height = d.h - 56 + "px";
      line(el, Math.round(d.w / 2) + 24, 80, Math.round(d.w / 2) + 24, d.h - 60, "is-dashed");
      label(el, T("Formulas"), LEFT, 34, "is-title");
    },
  },
  {
    id: "cover",
    label: "Cover page",
    desc: "Title page with name, class and subject.",
    box: (d) => ({ left: LEFT, width: d.w - LEFT - RIGHT, lines: Math.max(3, d.lines - 14) }),
    draw: (el, d, title) => {
      const t = label(el, title, 0, Math.round(d.h * 0.62), "is-cover-title");
      t.style.width = d.w + "px";
      const y0 = Math.round(d.h * 0.62) + 90;
      for (const [i, name] of ["Name", "Class", "Subject"].entries()) {
        label(el, name, Math.round(d.w * 0.2), y0 + i * 44);
        line(el, Math.round(d.w * 0.2) + 90, y0 + i * 44 + 34, Math.round(d.w * 0.8), y0 + i * 44 + 34);
      }
    },
  },
];

export function templateOf(id: string | undefined): TemplateDef | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export function defaultBox(d: PageDims): TextBox {
  return { left: LEFT, width: d.tw, lines: d.lines };
}
