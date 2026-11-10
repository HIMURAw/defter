// Windows for private notebooks: choose a password, keep the recovery key.
import { Modal, Notice, Setting, setIcon, type App, type ButtonComponent } from "obsidian";
import { T } from "./i18n";

/** Asks for a new password twice, plus an optional hint. */
export class PasswordModal extends Modal {
  private title: string;
  private done: (password: string, hint: string) => void;

  constructor(app: App, title: string, done: (password: string, hint: string) => void) {
    super(app);
    this.title = title;
    this.done = done;
  }

  onOpen() {
    this.modalEl.addClass("defter-lock-modal");
    this.titleEl.setText(T(this.title));
    let pw = "";
    let again = "";
    let hint = "";
    const error = this.contentEl.createDiv("defter-lock-error");
    const go = () => {
      if (pw.length < 6) return error.setText(T("Use at least 6 characters."));
      if (pw !== again) return error.setText(T("The two passwords are not the same."));
      const h = hint.trim().toLowerCase();
      if (h && (h.includes(pw.toLowerCase()) || pw.toLowerCase().includes(h))) return error.setText(T("The hint must not contain the password."));
      this.close();
      this.done(pw, hint.trim());
    };
    const field = (name: string, set: (v: string) => void, type = "password", focus = false) =>
      new Setting(this.contentEl).setName(T(name)).addText((t) => {
        t.inputEl.type = type;
        t.onChange((v) => {
          set(v);
          error.setText("");
        });
        t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && go());
        if (focus) setTimeout(() => t.inputEl.focus(), 0);
      });
    field("Password", (v) => (pw = v), "password", true);
    field("Repeat password", (v) => (again = v));
    field("Hint (optional)", (v) => (hint = v), "text").setDesc(T("Shown on the lock screen. Anyone can read it."));
    this.contentEl.prepend(error);
    new Setting(this.contentEl).addButton((b) => b.setButtonText(T("Continue")).setCta().onClick(go));
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** Shows the recovery key once; Done only after "I have saved it". */
export class RecoveryModal extends Modal {
  private code: string;
  private done: () => void;
  private warning?: string;

  constructor(app: App, code: string, done: () => void, warning?: string) {
    super(app);
    this.code = code;
    this.done = done;
    this.warning = warning;
  }

  onOpen() {
    this.modalEl.addClass("defter-lock-modal");
    this.titleEl.setText(T("Your recovery key"));
    const c = this.contentEl;
    c.createEl("p", {
      text: T("If you ever forget the password, this key opens the notebook and lets you set a new password. Without both, nobody can open it, not even you."),
    });
    const box = c.createDiv("defter-recovery-code");
    box.setText(this.code);
    const row = c.createDiv("defter-recovery-actions");
    const copy = row.createEl("button", { text: T("Copy") });
    setIcon(copy.createSpan({ prepend: true }), "copy");
    copy.onclick = async () => {
      await navigator.clipboard.writeText(this.code);
      new Notice(T("Recovery key copied. Keep it somewhere safe, outside this vault."));
    };
    c.createEl("p", { cls: "defter-lock-note", text: T("Write it on paper or keep it in a password manager. Do not keep it in this vault.") });
    c.createEl("p", {
      cls: "defter-lock-note",
      text: T("Older plain copies may still exist in File recovery, Sync version history or Git. Delete them there if they matter."),
    });
    if (this.warning) c.createEl("p", { cls: "defter-lock-note", text: this.warning });
    let ok = false;
    let btn: ButtonComponent;
    new Setting(c).setName(T("I have saved my recovery key")).addToggle((t) =>
      t.onChange((v) => {
        ok = v;
        btn.setDisabled(!v);
      })
    );
    new Setting(c).addButton((b) => {
      btn = b;
      b.setButtonText(T("Done")).setCta().setDisabled(true).onClick(() => {
        if (!ok) return;
        this.close();
        this.done();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
