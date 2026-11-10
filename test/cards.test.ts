import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, grade, isDue, parseCards } from "../src/cards.ts";

test("cards are front :: back lines, marks stripped, first copy wins", () => {
  const cards = parseCards([
    { text: "# Kimya\n- **mol** :: 6,02 × 10^23 tane\nno card here\n:: no front" },
    { text: "[ ] pH :: -log[H+]\nmol :: duplicate" },
  ]);
  assert.deepEqual(cards, [
    { front: "mol", back: "6,02 × 10^23 tane", page: 0 },
    { front: "pH", back: "-log[H+]", page: 1 },
  ]);
});

test("Leitner schedule", () => {
  const t = "2026-11-10";
  assert.equal(isDue(undefined, t), true);
  const a = grade(undefined, "good", t);
  assert.deepEqual(a, { b: 1, d: "2026-11-11" });
  assert.equal(isDue(a, t), false);
  const b = grade(a, "good", "2026-11-11");
  assert.deepEqual(b, { b: 2, d: "2026-11-13" });
  assert.deepEqual(grade(b, "easy", "2026-11-13"), { b: 4, d: "2026-11-21" });
  assert.deepEqual(grade(b, "again", "2026-11-13"), { b: 1, d: "2026-11-13" });
  assert.deepEqual(grade({ b: 5, d: t }, "easy", t), { b: 5, d: "2026-11-26" });
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});
