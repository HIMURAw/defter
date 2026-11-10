// The write pad: a magnified strip at the bottom of the pane. Letters written
// large in the strip land small on the page inside the frame, which moves on
// as the line fills up. In touchpad mode the cursor is captured, the finger
// moves the pen and ink flows while Space (or the touchpad button) is held.
import { setIcon } from "obsidian";
import type { Page, Stroke } from "./format";
import { LINE, TEXT_TOP, drawStrokes, type PageDims } from "./render";
import type { Tone } from "./settings";

export interface PadHost {
  sheetEl: HTMLElement;
  dims(): PageDims;
  page(): Page;
  tone(): Tone;
  /** Left edge of the text area and the first empty line under the text. */
  startAt(): { left: number; row: number };
  beginStroke(x: number, y: number): void;
  extendStroke(x: number, y: number): void;
  /** Ends the stroke and returns its right edge in page units, or null when nothing was drawn. */
  endStroke(): number | null;
  /** The stroke being drawn, if any. */
  liveStroke(): Stroke | null;
  undo(): void;
  speed(): number;
  closed(): void;
}

const ROWS = 2;
const RULE_OFFSET = 35;

export class WritePad {
  private host: PadHost;
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private frame: HTMLElement;
  private lockBtn: HTMLElement;
  private hint: HTMLElement;
  private tx = 0;
  private row = 0;
  private drawing = false;
  private maxX = -Infinity;
  private locked = false;
  /** Touchpad mode without pointer lock: the normal cursor, ink while Space is held. */
  private hover = false;
  private cursor = { x: 40, y: 0 };
  private spaceDown = false;
  private buttonDown = false;
  private cleanup: (() => void)[] = [];

  constructor(root: HTMLElement, host: PadHost) {
    this.host = host;
    this.el = root.createDiv("defter-pad");
    const bar = this.el.createDiv("defter-pad-bar");
    const button = (icon: string, label: string, fn: () => void) => {
      const b = bar.createEl("button", { cls: "defter-btn clickable-icon", attr: { "aria-label": label, "data-tooltip-position": "top" } });
      setIcon(b, icon);
      b.onclick = (e) => {
        e.preventDefault();
        fn();
      };
      return b;
    };
    this.hint = bar.createSpan("defter-pad-hint");
    button("arrow-left", "Move the frame left (←)", () => this.move(-0.5));
    button("arrow-right", "Move the frame right (→)", () => this.move(0.5));
    button("corner-down-left", "Next line (Enter)", () => this.newLine());
    button("undo-2", "Undo (Ctrl+Z)", () => {
      this.host.undo();
      this.draw();
    });
    this.lockBtn = button("mouse-pointer-2", "Touchpad mode: the finger moves the pen, hold Space to write", () => this.toggleLock());
    button("x", "Close the write pad (Esc)", () => this.close());
    this.canvas = this.el.createEl("canvas", { cls: "defter-pad-canvas" });
    this.frame = host.sheetEl.createDiv("defter-pad-frame");

    const c = this.canvas;
    const on = <K extends keyof DocumentEventMap>(t: Document | HTMLElement, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on(c, "pointerdown", (e) => this.down(e as PointerEvent));
    on(c, "pointermove", (e) => this.moveEvt(e as PointerEvent));
    on(c, "pointerleave", () => {
      if (this.hover && !this.drawing) this.draw();
    });
    on(c, "pointerup", () => this.up("button"));
    on(c, "pointercancel", () => this.up("button"));
    on(document, "mousemove", (e) => this.lockedMove(e));
    on(document, "keydown", (e) => this.keyDown(e), { capture: true });
    on(document, "keyup", (e) => this.keyUp(e), { capture: true });
    on(document, "pointerlockchange", () => this.lockChanged());
    const ro = new ResizeObserver(() => this.layout());
    ro.observe(this.el);
    this.cleanup.push(() => ro.disconnect());

    const start = host.startAt();
    this.tx = Math.max(0, start.left - 16);
    this.row = start.row;
    this.layout();
    this.updateHint();
  }

  /** Size of the strip in CSS px, and page units per px. */
  private get k() {
    return this.canvas.clientHeight / (ROWS * LINE) || 1;
  }
  private get tw() {
    return this.canvas.clientWidth / this.k;
  }
  private get ty() {
    return TEXT_TOP + this.row * LINE - LINE / 2;
  }

  private layout() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.cursor.y = this.canvas.clientHeight / 2;
    this.placeFrame();
    this.draw();
  }

  private placeFrame() {
    const d = this.host.dims();
    this.tx = Math.max(0, Math.min(this.tx, d.w - this.tw));
    const s = this.frame.style;
    s.left = this.tx + "px";
    s.top = this.ty + "px";
    s.width = this.tw + "px";
    s.height = ROWS * LINE + "px";
  }

  /** Puts the frame where the user clicked on the page. */
  setTarget(x: number, y: number) {
    this.row = Math.max(0, Math.round((y - TEXT_TOP - LINE / 2) / LINE));
    this.tx = Math.max(0, x - 20);
    this.placeFrame();
    this.draw();
  }

  private move(f: number) {
    this.tx += this.tw * f;
    this.placeFrame();
    this.draw();
  }

  private newLine() {
    this.tx = Math.max(0, this.host.startAt().left - 16);
    this.row++;
    const d = this.host.dims();
    if (this.ty + ROWS * LINE > d.h - 20) this.row = Math.max(0, this.row - 1);
    this.placeFrame();
    this.draw();
  }

  draw() {
    const ctx = this.canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const k = this.k;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.host.sheetEl);
    ctx.fillStyle = css.getPropertyValue("--paper").trim() || "#fbf7ec";
    ctx.fillRect(0, 0, w, h);
    // The writing zone: the frame moves on once ink reaches it.
    ctx.fillStyle = "rgba(120,120,120,0.07)";
    ctx.fillRect(w * 0.72, 0, w * 0.28, h);
    // Ruled lines of the page.
    ctx.strokeStyle = css.getPropertyValue("--rule").trim() || "#c9d6ea";
    ctx.lineWidth = 1.5;
    for (let r = this.row - 1; r <= this.row + 2; r++) {
      const y = (TEXT_TOP + r * LINE + RULE_OFFSET - this.ty) * k;
      if (y < 0 || y > h) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // Ink already on the page in this part of it, at the strip's zoom.
    ctx.setTransform(dpr * k, 0, 0, dpr * k, -this.tx * k * dpr, -this.ty * k * dpr);
    const page = this.host.page();
    drawStrokes(ctx, page.ink, this.host.tone());
    const live = this.host.liveStroke();
    if (live) drawStrokes(ctx, [live], this.host.tone());
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.locked || this.hover) {
      ctx.beginPath();
      ctx.arc(this.cursor.x, this.cursor.y, this.drawing ? 3 : 5, 0, Math.PI * 2);
      ctx.fillStyle = this.drawing ? "rgba(220,60,60,0.9)" : "rgba(60,90,200,0.55)";
      ctx.fill();
    }
  }

  private toPage(px: number, py: number): [number, number] {
    const k = this.k;
    return [Math.round((this.tx + px / k) * 2) / 2, Math.round((this.ty + py / k) * 2) / 2];
  }

  private begin(px: number, py: number) {
    this.drawing = true;
    const [x, y] = this.toPage(px, py);
    this.maxX = x;
    this.host.beginStroke(x, y);
    this.draw();
  }

  private extend(px: number, py: number) {
    if (!this.drawing) return;
    const [x, y] = this.toPage(px, py);
    this.maxX = Math.max(this.maxX, x);
    this.host.extendStroke(x, y);
    this.draw();
  }

  private end() {
    if (!this.drawing) return;
    this.drawing = false;
    const right = this.host.endStroke();
    if (right !== null) this.maxX = Math.max(this.maxX, right);
    // Ink in the writing zone: move the frame on, like sliding the paper left.
    const edge = this.tx + this.tw * 0.72;
    if (this.maxX > edge) {
      const d = this.host.dims();
      const shift = this.maxX - (this.tx + this.tw * 0.3);
      if (this.tx + shift > d.w - 40 - this.tw * 0.45) {
        this.newLine();
        this.cursor.x = 40;
      } else {
        this.tx += shift;
        if (this.locked) this.cursor.x = Math.max(10, this.cursor.x - shift * this.k);
        this.placeFrame();
      }
    }
    this.draw();
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (this.locked || this.hover) {
      this.buttonDown = true;
      this.begin(this.cursor.x, this.cursor.y);
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    this.begin(e.offsetX, e.offsetY);
  }

  private moveEvt(e: PointerEvent) {
    if (this.locked) return;
    if (this.hover) {
      this.cursor.x = e.offsetX;
      this.cursor.y = e.offsetY;
      if (this.drawing) {
        const list = e.getCoalescedEvents?.() ?? [];
        for (const ev of list.length ? list : [e]) this.extend(ev.offsetX, ev.offsetY);
      } else this.draw();
      return;
    }
    if (!this.drawing) return;
    const list = e.getCoalescedEvents?.() ?? [];
    for (const ev of list.length ? list : [e]) this.extend(ev.offsetX, ev.offsetY);
  }

  private up(src: "button" | "space") {
    if (src === "button") this.buttonDown = false;
    if (src === "space") this.spaceDown = false;
    if (!this.buttonDown && !this.spaceDown) this.end();
  }

  // ---- Touchpad mode ----

  private toggleLock() {
    if (this.locked) {
      document.exitPointerLock();
      return;
    }
    if (this.hover) {
      this.setHover(false);
      return;
    }
    // Pointer lock lets the finger write on and on; some systems refuse it,
    // then the normal cursor is used and Space still makes the ink flow.
    const fallback = () => {
      if (!this.locked) this.setHover(true);
    };
    try {
      const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === "function") void r.catch(fallback);
      setTimeout(fallback, 250);
    } catch {
      fallback();
    }
  }

  private setHover(on: boolean) {
    this.hover = on;
    this.lockBtn.toggleClass("is-active", on);
    this.el.toggleClass("is-locked", on);
    if (!on) {
      this.spaceDown = false;
      this.buttonDown = false;
      this.end();
    }
    this.updateHint();
    this.draw();
  }

  private lockChanged() {
    this.locked = document.pointerLockElement === this.canvas;
    this.lockBtn.toggleClass("is-active", this.locked);
    this.el.toggleClass("is-locked", this.locked);
    if (!this.locked) {
      this.spaceDown = false;
      this.buttonDown = false;
      this.end();
    }
    this.updateHint();
    this.draw();
  }

  private lockedMove(e: MouseEvent) {
    if (!this.locked) return;
    const sp = this.host.speed();
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.cursor.x = Math.max(2, Math.min(w - 2, this.cursor.x + e.movementX * sp));
    this.cursor.y = Math.max(2, Math.min(h - 2, this.cursor.y + e.movementY * sp));
    if (this.drawing) this.extend(this.cursor.x, this.cursor.y);
    else this.draw();
  }

  private keyDown(e: KeyboardEvent) {
    if (!this.el.isConnected) return;
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && !this.locked && !this.hover;
    if (typing) return;
    if (e.key === " " && (this.locked || this.hover)) {
      e.preventDefault();
      e.stopPropagation();
      if (!this.spaceDown && !e.repeat) {
        this.spaceDown = true;
        if (!this.drawing) this.begin(this.cursor.x, this.cursor.y);
      }
      return;
    }
    if (!this.el.closest(".workspace-leaf.mod-active") && !this.locked) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "ArrowRight") (handled(), this.move(0.5));
    else if (e.key === "ArrowLeft") (handled(), this.move(-0.5));
    else if (e.key === "ArrowDown" || e.key === "Enter") (handled(), this.newLine());
    else if (e.key === "ArrowUp") {
      handled();
      this.row = Math.max(0, this.row - 1);
      this.placeFrame();
      this.draw();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      handled();
      this.host.undo();
      this.draw();
    } else if (e.key === "Escape" && !this.locked) {
      handled();
      if (this.hover) this.setHover(false);
      else this.close();
    }
  }

  private keyUp(e: KeyboardEvent) {
    if (e.key === " " && this.spaceDown) {
      e.preventDefault();
      this.up("space");
    }
  }

  private updateHint() {
    this.hint.setText(
      this.locked
        ? "Touchpad mode: move your finger to move the pen, hold Space to write. Esc leaves."
        : this.hover
        ? "Touchpad mode: move the cursor over the strip, hold Space to write, release to lift the pen. Esc leaves."
        : "Write large here; it lands small in the frame on the page. Click the page to move the frame."
    );
  }

  close() {
    if (this.locked) document.exitPointerLock();
    this.end();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.el.remove();
    this.frame.remove();
    this.host.closed();
  }
}
