import { Modal, type App } from "obsidian";
import { grade, type Card, type CardState, type Grade } from "./cards";
import { todayStr } from "./new-notebook";

export interface StudyItem {
  card: Card;
  path: string;
  notebook: string;
}

export interface StudyHost {
  cardState(path: string, front: string): CardState | undefined;
  setCardState(path: string, front: string, state: CardState): void;
  openAt(path: string, page: number): void;
}

/** One card at a time: front, then back (Space), then Again / Good / Easy (1 2 3). */
export class StudyModal extends Modal {
  private queue: StudyItem[];
  private host: StudyHost;
  private shown = false;
  private done = 0;
  private total: number;

  constructor(app: App, items: StudyItem[], host: StudyHost) {
    super(app);
    // Shuffle so cards are not always asked in page order.
    this.queue = [...items].sort(() => Math.random() - 0.5);
    this.total = items.length;
    this.host = host;
  }

  onOpen() {
    this.modalEl.addClass("defter-study-modal");
    this.scope.register([], " ", (e) => {
      e.preventDefault();
      if (!this.shown) this.reveal();
      return false;
    });
    this.scope.register([], "Enter", (e) => {
      e.preventDefault();
      if (!this.shown) this.reveal();
      else this.answer("good");
      return false;
    });
    for (const [key, g] of [["1", "again"], ["2", "good"], ["3", "easy"]] as const) {
      this.scope.register([], key, () => {
        if (this.shown) this.answer(g);
        return false;
      });
    }
    this.render();
  }

  private reveal() {
    this.shown = true;
    this.render();
  }

  private answer(g: Grade) {
    const item = this.queue.shift();
    if (!item) return;
    const today = todayStr();
    const next = grade(this.host.cardState(item.path, item.card.front), g, today);
    this.host.setCardState(item.path, item.card.front, next);
    // "Again" comes back at the end of this session.
    if (g === "again") this.queue.push(item);
    else this.done++;
    this.shown = false;
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`Study cards · ${this.done} / ${this.total}`);
    const item = this.queue[0];
    if (!item) {
      contentEl.createDiv({ cls: "defter-study-done", text: this.total ? "All done for today." : "No cards are due." });
      contentEl.createDiv({
        cls: "defter-study-hint",
        text: "Cards come back after 1, 2, 4, 8 and 16 days as you know them better.",
      });
      return;
    }
    const card = contentEl.createDiv("defter-study-card");
    card.createDiv({ cls: "defter-study-front", text: item.card.front });
    if (this.shown) {
      card.createDiv("defter-study-rule");
      card.createDiv({ cls: "defter-study-back", text: item.card.back });
    }
    const src = contentEl.createDiv("defter-study-src");
    const link = src.createEl("a", { text: `${item.notebook}, page ${item.card.page + 1}` });
    link.onclick = () => {
      this.close();
      this.host.openAt(item.path, item.card.page);
    };
    const row = contentEl.createDiv("defter-study-buttons");
    if (!this.shown) {
      const b = row.createEl("button", { cls: "mod-cta", text: "Show answer (Space)" });
      b.onclick = () => this.reveal();
      return;
    }
    const btn = (label: string, key: string, g: Grade, cls: string) => {
      const b = row.createEl("button", { cls, text: `${label} (${key})` });
      b.onclick = () => this.answer(g);
    };
    btn("Again", "1", "again", "mod-warning");
    btn("Good", "2", "good", "mod-cta");
    btn("Easy", "3", "easy", "");
  }

  onClose() {
    this.contentEl.empty();
  }
}
