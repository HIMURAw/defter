// Flashcards written in a notebook as `front :: back` lines, reviewed with a
// five-box Leitner schedule. Pure functions, tested with plain Node.

// Same as stripColors in format.ts (kept here so this file has no imports).
const stripColors = (t: string) => t.replace(/\u2063[\ufe00-\ufe0f]?|\u2064/g, "");

export interface Card {
  front: string;
  back: string;
  /** Page index (0-based) the card is written on. */
  page: number;
}

export interface CardState {
  /** Leitner box, 1..5. */
  b: number;
  /** Next review day, YYYY-MM-DD. */
  d: string;
}

export type Grade = "again" | "good" | "easy";

/** Days until the next review for each box. */
export const BOX_DAYS = [0, 1, 2, 4, 8, 16];

const strip = (s: string) =>
  stripColors(s)
    .replace(/^\s*(?:#{1,3} |[-*] |\[[ xX]\] )+/, "")
    .replace(/\*\*|==|\[\[|\]\]/g, "")
    .trim();

export function parseCards(pages: { text: string }[]): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  pages.forEach((p, page) => {
    for (const line of p.text.split("\n")) {
      const at = line.indexOf(" :: ");
      if (at <= 0) continue;
      const front = strip(line.slice(0, at));
      const back = strip(line.slice(at + 4));
      if (!front || !back || seen.has(front)) continue;
      seen.add(front);
      out.push({ front, back, page });
    }
  });
  return out;
}

/** Short stable key for a card (FNV-1a), so card text is not stored in settings. */
export function cardKey(front: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < front.length; i++) {
    h ^= front.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "c" + h.toString(36);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function isDue(state: CardState | undefined, today: string): boolean {
  return !state || state.d <= today;
}

export function grade(state: CardState | undefined, g: Grade, today: string): CardState {
  const box = state?.b ?? 0;
  const next = g === "again" ? 1 : Math.min(5, Math.max(1, box + (g === "easy" ? 2 : 1)));
  return { b: next, d: g === "again" ? today : addDays(today, BOX_DAYS[next]) };
}
