// A study timer: Pomodoro (focus, then a break) or a plain stopwatch. Focus
// minutes are added to the notebook the timer was started from.
import { Menu, Notice } from "obsidian";
import { todayStr } from "./new-notebook";
import { T } from "./i18n";

export type TimerMode = "pomo25" | "pomo50" | "free";

export const TIMER_MODES: { id: TimerMode; label: string; focus: number; rest: number }[] = [
  { id: "pomo25", label: "Pomodoro 25 + 5 min", focus: 25, rest: 5 },
  { id: "pomo50", label: "Pomodoro 50 + 10 min", focus: 50, rest: 10 },
  { id: "free", label: "Stopwatch", focus: 0, rest: 0 },
];

export interface TimerHost {
  addStudyMinute(path: string): void;
}

interface Running {
  mode: TimerMode;
  path: string;
  name: string;
  phase: "focus" | "rest";
  /** Phase start, ms. */
  start: number;
  /** Seconds already counted into study minutes. */
  counted: number;
}

function beep() {
  try {
    const ctx = new AudioContext();
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.25 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.25 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.25);
      o.stop(ctx.currentTime + i * 0.25 + 0.25);
    }
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* no audio: the notice is enough */
  }
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export class StudyTimer {
  private run: Running | null = null;
  private host: TimerHost;
  private listeners = new Set<() => void>();
  readonly el: HTMLElement;

  constructor(host: TimerHost, statusEl: HTMLElement) {
    this.host = host;
    this.el = statusEl;
    this.el.addClass("defter-timer-status", "mod-clickable");
    this.el.onclick = (e) => this.menu(e);
    this.render();
  }

  get running() {
    return this.run;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(mode: TimerMode, path: string, name: string) {
    this.run = { mode, path, name, phase: "focus", start: Date.now(), counted: 0 };
    new Notice(mode === "free" ? T("Stopwatch started for {name}.", { name }) : T("Focus for {n} minutes. You can do it.", { n: TIMER_MODES.find((m) => m.id === mode)!.focus }));
    this.tick();
  }

  stop() {
    if (!this.run) return;
    this.countUpTo(this.elapsed());
    this.run = null;
    this.tick();
  }

  private elapsed() {
    return this.run ? (Date.now() - this.run.start) / 1000 : 0;
  }

  private countUpTo(sec: number) {
    const r = this.run;
    if (!r || r.phase !== "focus") return;
    while (r.counted + 60 <= sec) {
      r.counted += 60;
      this.host.addStudyMinute(r.path);
    }
  }

  /** Called every second by the plugin. */
  tick() {
    const r = this.run;
    if (r) {
      const def = TIMER_MODES.find((m) => m.id === r.mode)!;
      const sec = this.elapsed();
      this.countUpTo(sec);
      if (r.mode !== "free") {
        const limit = (r.phase === "focus" ? def.focus : def.rest) * 60;
        if (sec >= limit) {
          beep();
          if (r.phase === "focus") {
            new Notice(T("Well done: {n} minutes on {name}. Take a {rest} minute break.", { n: def.focus, name: r.name, rest: def.rest }), 8000);
            this.run = { ...r, phase: "rest", start: Date.now(), counted: 0 };
          } else {
            new Notice(T("Break is over. Start the next round when you are ready."), 8000);
            this.run = null;
          }
        }
      }
    }
    this.render();
    for (const fn of this.listeners) fn();
  }

  /** Short label for the status bar and the notebook header. */
  label(): string {
    const r = this.run;
    if (!r) return "";
    const def = TIMER_MODES.find((m) => m.id === r.mode)!;
    const sec = this.elapsed();
    if (r.mode === "free") return `⏱ ${mmss(sec)}`;
    const left = Math.max(0, (r.phase === "focus" ? def.focus : def.rest) * 60 - sec);
    return `${r.phase === "focus" ? "●" : "☕"} ${mmss(left)}`;
  }

  private render() {
    this.el.setText(this.run ? `${this.label()} · ${this.run.name}` : "");
    this.el.toggle(!!this.run);
  }

  menu(e: MouseEvent, path?: string, name?: string) {
    const m = new Menu();
    if (this.run) {
      m.addItem((i) => i.setTitle(T("Stop timer ({name})", { name: this.run!.name })).setIcon("square").onClick(() => this.stop()));
    }
    if (path && name) {
      for (const def of TIMER_MODES) {
        m.addItem((i) =>
          i
            .setTitle(T(def.label))
            .setIcon(def.id === "free" ? "timer" : "alarm-clock")
            .setSection("start")
            .onClick(() => this.start(def.id, path, name))
        );
      }
    }
    m.showAtMouseEvent(e);
  }
}

/** Minutes studied in the last 7 days (today included). */
export function weekMinutes(days: Record<string, number> | undefined): number {
  if (!days) return 0;
  const from = window.moment(todayStr()).subtract(6, "day").format("YYYY-MM-DD");
  return Object.entries(days).reduce((sum, [d, m]) => (d >= from ? sum + m : sum), 0);
}

export function fmtMinutes(min: number): string {
  if (min < 60) return T("{n} min", { n: min });
  return T("{h} h {m} min", { h: Math.floor(min / 60), m: min % 60 });
}
