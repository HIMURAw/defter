// First run: a short tour, and a welcome notebook that shows every feature
// on real pages (in the interface language).
import { Modal, setIcon, type App } from "obsidian";
import { emptyNotebook, serializeNotebook, setProp, type Page } from "./format";
import { T, language } from "./i18n";

interface Step {
  icon: string;
  title: string;
  text: string;
}

const STEPS: Step[] = [
  {
    icon: "library",
    title: "Your notebooks live in a library",
    text: "Open the library from the left ribbon. Every folder is a bookcase; add a notebook with the + book. Each notebook is a normal Markdown file.",
  },
  {
    icon: "type",
    title: "Type, and it appears in handwriting",
    text: "Just type. # makes a heading, **bold**, ==marker==, - lists, [ ] to-dos. Writing goes on to the next page by itself.",
  },
  {
    icon: "pen-line",
    title: "A pencil case for the mouse",
    text: "Pen, highlighter, shapes, eraser and lasso are in the pencil case at the bottom. Draw a shape and hold still to make it neat. The write pad (Alt+7) lets you write with the mouse or touchpad.",
  },
  {
    icon: "graduation-cap",
    title: "Made for studying",
    text: "Write “question :: answer” for flashcards, press Alt+S to hide answers, start a Pomodoro from the header. Maths: \\sqrt, \\pi, x^2, and 12*3 = then Tab. Press F1 for every shortcut.",
  },
];

export class WelcomeModal extends Modal {
  private step = 0;
  private openWelcome: () => void;

  constructor(app: App, openWelcome: () => void) {
    super(app);
    this.openWelcome = openWelcome;
  }

  onOpen() {
    this.modalEl.addClass("defter-welcome-modal");
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(T("Welcome to Defter"));
    const s = STEPS[this.step];
    const card = contentEl.createDiv("defter-welcome-card");
    setIcon(card.createDiv("defter-welcome-icon"), s.icon);
    card.createDiv({ cls: "defter-welcome-title", text: T(s.title) });
    card.createDiv({ cls: "defter-welcome-text", text: T(s.text) });
    const dots = contentEl.createDiv("defter-welcome-dots");
    STEPS.forEach((_, i) => dots.createSpan({ cls: i === this.step ? "is-active" : "" }));
    const row = contentEl.createDiv("defter-welcome-buttons");
    if (this.step > 0) {
      const back = row.createEl("button", { text: T("Back") });
      back.onclick = () => {
        this.step--;
        this.render();
      };
    } else {
      const skip = row.createEl("button", { text: T("Skip") });
      skip.onclick = () => this.close();
    }
    const last = this.step === STEPS.length - 1;
    const next = row.createEl("button", { cls: "mod-cta", text: T(last ? "Open the welcome notebook" : "Next") });
    next.onclick = () => {
      if (!last) {
        this.step++;
        this.render();
        return;
      }
      this.close();
      this.openWelcome();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** The welcome notebook: one page per feature, written in the interface language. */
export function welcomeNotebook(): string {
  const tr = language() === "tr";
  const nb = emptyNotebook();
  nb.frontmatter = setProp(nb.frontmatter, "defter-cover", "#2e6b4f");
  const p = (text: string, extra: Partial<Page> = {}): Page => ({ text, ink: [], ...extra });
  const pages: Page[] = tr
    ? [
        p("", { tpl: "cover" }),
        p(
          "# Defter'e hoş geldin\nKlavyeyle yaz, el yazısı gibi görünsün.\n\n**Kalın**, ==işaret==, [[Bağlantı]]\n- Liste maddesi\n- Bir madde daha\n\n[ ] Yapılacak kutusuna tıkla\n[x] Bitenin üstü çizilir\n\nSayfa dolunca yazı kendiliğinden sonraki sayfaya geçer."
        ),
        p(
          "# Ders çalışmak için\nBilgi kartı: soru :: cevap\nmol :: 6,02 × 10²³ tane\nBaşkent :: Ankara\n\nAlt+S ile cevaplar ve ==işaretli yerler== gizlenir, tıklayınca açılır.\nBaşlıktaki kart düğmesi kartları sorar (1, 2, 4, 8, 16 gün).\nBaşlıktaki saat: Pomodoro."
        ),
        p(
          "# Matematik\n\\sqrt yaz: √(a+b), \\pi yaz: π\nx^2 + y^(n+1), a_1\n<= ≤   != ≠   -> →\n\nHesap makinesi: 12*3+4 = yazıp Tab'a bas\n12×3+4 = 40\n\nΣ düğmesi bütün sembolleri gösterir."
        ),
        p("# Soru ve çözüm\nSoruyu buraya yaz, çözümü sağ tarafa kalemle yap.", { tpl: "qa" }),
        p(
          "# Kalem kutusu\nKalem, fosforlu, şekiller, silgi, kement.\nŞekli çizip bir an bekle: düzgün olur.\nAlt+7 yazma kutusu: fareyle ya da touchpad'le yaz.\n⊞ ile resim, yapışkan not, bant, damga, formül, PDF ekle.\n\nF1: bütün kısayollar."
        ),
      ]
    : [
        p("", { tpl: "cover" }),
        p(
          "# Welcome to Defter\nType with your keyboard; it looks like handwriting.\n\n**Bold**, ==marker==, [[Links]]\n- A list item\n- Another one\n\n[ ] Click a to-do box\n[x] Done ones are crossed out\n\nWhen the page is full, writing goes on to the next page."
        ),
        p(
          "# Made for studying\nFlashcard: question :: answer\nmole :: 6.02 × 10²³ particles\nCapital of France :: Paris\n\nAlt+S hides answers and ==marked text==; click to reveal.\nThe cards button in the header quizzes you (1, 2, 4, 8, 16 days).\nThe clock in the header: Pomodoro."
        ),
        p(
          "# Maths\nType \\sqrt: √(a+b), type \\pi: π\nx^2 + y^(n+1), a_1\n<= ≤   != ≠   -> →\n\nCalculator: type 12*3+4 = and press Tab\n12×3+4 = 40\n\nThe Σ button shows every symbol."
        ),
        p("# Question & solution\nWrite the question here, work the solution with the pen on the right.", { tpl: "qa" }),
        p(
          "# Pencil case\nPen, highlighter, shapes, eraser, lasso.\nDraw a shape and hold still: it snaps neat.\nAlt+7 write pad: write with the mouse or touchpad.\n⊞ adds pictures, sticky notes, tape, stamps, formulas, PDFs.\n\nF1: every shortcut."
        ),
      ];
  // A few drawings so the pages are not bare: an arrow, a circle, a highlight.
  pages[1].ink = [
    { t: "pen", c: "#c42b2b", w: 3.5, p: [560, 380, 660, 330], s: "arrow" },
    { t: "hl", c: "#ffe14d", w: 24, p: [100, 127, 470, 127] },
  ];
  pages[3].ink = [{ t: "pen", c: "#1f7a4d", w: 3.5, p: [520, 470, 760, 560], s: "ellipse" }];
  pages[1].obj = [{ k: "note", x: 520, y: 600, w: 220, h: 170, v: tr ? "Yapışkan not!\nÇift tıkla, düzenle." : "A sticky note!\nDouble-click to edit.", c: "#fff27a" }];
  pages[2].obj = [{ k: "stamp", x: 600, y: 120, w: 150, h: 52, v: tr ? "SINAV" : "EXAM", c: "#c42b2b" }];
  pages[3].obj = [{ k: "tex", x: 120, y: 760, w: 230, h: 70, v: "\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}" }];
  pages[1].mark = "#4f8fe0";
  nb.pages = pages;
  return serializeNotebook(nb);
}
