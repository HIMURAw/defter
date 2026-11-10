import { test } from "node:test";
import assert from "node:assert/strict";
import { calcLine, easyToTex, evaluate, formatResult, shortcutAt } from "../src/math.ts";

const typeAll = (input: string) => {
  let text = "";
  for (const ch of input) {
    text += ch;
    const r = shortcutAt(text, text.length);
    if (r) text = text.slice(0, r[0]) + r[2] + text.slice(r[1]);
  }
  return text;
};

test("shortcuts while typing", () => {
  assert.equal(typeAll("\\sqrt(2) "), "√(2) ");
  assert.equal(typeAll("x <= 3 and y != 0 -> ok"), "x ≤ 3 and y ≠ 0 → ok");
  assert.equal(typeAll("\\pi r^2"), "π r^2");
  assert.equal(typeAll("\\alpha+\\beta=90\\deg."), "α+β=90°.");
  assert.equal(typeAll("\\unknown "), "\\unknown ");
  assert.equal(typeAll("a <=> b"), "a ⇔ b");
  assert.equal(typeAll("12*3+4"), "12×3+4");
  assert.equal(typeAll("**bold** 2*x"), "**bold** 2*x");
  // Plain Turkish text is never touched.
  assert.equal(typeAll("Sınav için çalış, ilerle."), "Sınav için çalış, ilerle.");
});

test("calculator", () => {
  assert.equal(evaluate("12*3+4"), 40);
  assert.equal(evaluate("2(3+4)"), 14);
  assert.equal(evaluate("√16 + 2^3"), 12);
  assert.equal(evaluate("-2^2"), -4);
  assert.equal(evaluate("50%*80"), 40);
  assert.equal(evaluate("5!"), 120);
  assert.equal(formatResult(evaluate("sin(30)"), false), "0.5");
  assert.equal(formatResult(evaluate("0.1+0.2"), false), "0.3");
  assert.equal(formatResult(evaluate("2π"), false), "6.283185307");
  assert.equal(evaluate("10÷4×2"), 5);
  assert.throws(() => evaluate("1/0"), /zero/);
  assert.throws(() => evaluate("2+"), /Incomplete/);
});

test("calculator lines", () => {
  assert.deepEqual(calcLine("12*3+4 ="), { expr: "12*3+4", answer: "40" });
  assert.deepEqual(calcLine("- Alan = 3,5*2 ="), { expr: "3,5*2", answer: "7" });
  assert.deepEqual(calcLine("1,5+1 ="), { expr: "1,5+1", answer: "2,5" });
  assert.deepEqual(calcLine("Toplam: √(9)+1="), { expr: "√(9)+1", answer: "4" });
  assert.equal(calcLine("a = b ="), null);
  assert.equal(calcLine("no equals"), null);
});

test("easy formula syntax", () => {
  assert.equal(easyToTex("sqrt(x+1)/2"), "\\frac{\\sqrt{x + 1}}{2}");
  assert.equal(easyToTex("x^2 + y^(n+1)"), "x^{2} + y^{n + 1}");
  assert.equal(easyToTex("(a+b)/(c-d)"), "\\frac{a + b}{c - d}");
  assert.equal(easyToTex("pi*r^2"), "\\pi \\cdot r^{2}");
  assert.equal(easyToTex("a_1 <= b"), "a_{1} \\le b");
  assert.equal(easyToTex("1/2"), "\\frac{1}{2}");
});
