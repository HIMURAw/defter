// Maths for keyboard students: symbol shortcuts while typing, a small
// calculator for "12*3+4 =" lines, and an easy formula syntax turned into TeX.
// Pure functions, tested with plain Node.

/** \name shortcuts, replaced when the next non-letter is typed. */
export const NAMED: Record<string, string> = {
  sqrt: "√", cbrt: "∛", pi: "π", alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", theta: "θ",
  lambda: "λ", mu: "μ", sigma: "σ", Sigma: "Σ", omega: "ω", Omega: "Ω", phi: "φ", epsilon: "ε",
  sum: "∑", int: "∫", inf: "∞", infty: "∞", deg: "°", times: "×", div: "÷", pm: "±", le: "≤", ge: "≥",
  ne: "≠", approx: "≈", in: "∈", notin: "∉", sub: "⊂", cup: "∪", cap: "∩", empty: "∅", angle: "∠",
  perp: "⊥", parallel: "∥", to: "→", implies: "⇒", iff: "⇔", cdot: "·", forall: "∀", exists: "∃",
  R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", tri: "△", half: "½", deg2: "²", sq: "²", cube: "³",
};

/** Two- and three-letter operators replaced as soon as they are complete. */
export const OPERATORS: [string, string][] = [
  ["<=>", "⇔"],
  ["≤>", "⇔"],
  ["<=", "≤"],
  [">=", "≥"],
  ["!=", "≠"],
  ["=>", "⇒"],
  ["->", "→"],
  ["+-", "±"],
  ["~=", "≈"],
];

/**
 * After a character was typed at `pos` (text already contains it), returns
 * the replacement to make: [from, to, insert], or null.
 */
export function shortcutAt(text: string, pos: number): [number, number, string] | null {
  const typed = text[pos - 1];
  if (!typed) return null;
  for (const [op, sym] of OPERATORS) {
    if (pos >= op.length && text.slice(pos - op.length, pos) === op) {
      // "<=>" wins over "=>" when the arrow was written as <=>, handled by order.
      return [pos - op.length, pos, sym];
    }
  }
  // 12*3 → 12×3 once the digit after the star is typed (not **bold**).
  if (/\d/.test(typed) && text[pos - 2] === "*" && /\d/.test(text[pos - 3] ?? "")) return [pos - 2, pos - 1, "×"];
  if (/[A-Za-z]/.test(typed)) return null;
  const m = /\\([A-Za-z][A-Za-z0-9]*)$/.exec(text.slice(0, pos - 1));
  if (!m || !(m[1] in NAMED)) return null;
  return [pos - 1 - m[0].length, pos - 1, NAMED[m[1]]];
}

// ---- Calculator ------------------------------------------------------------------

export class CalcError extends Error {}

type Tok = { k: "num"; v: number } | { k: "op"; v: string } | { k: "fn"; v: string } | { k: "(" } | { k: ")" };

const FUNCS = ["sin", "cos", "tan", "log", "ln", "sqrt", "abs"];

function tokenize(src: string): Tok[] {
  const s = src.replace(/\s+/g, "").replace(/×|·/g, "*").replace(/÷|:/g, "/").replace(/−/g, "-").replace(/²/g, "^2").replace(/³/g, "^3");
  const out: Tok[] = [];
  let i = 0;
  const prevIsValue = () => {
    const p = out[out.length - 1];
    return !!p && (p.k === "num" || p.k === ")");
  };
  while (i < s.length) {
    const c = s[i];
    const num = /^(\d+(?:[.,]\d+)?|[.,]\d+)/.exec(s.slice(i));
    if (num) {
      if (prevIsValue()) out.push({ k: "op", v: "*" });
      out.push({ k: "num", v: parseFloat(num[1].replace(",", ".")) });
      i += num[1].length;
      continue;
    }
    const word = /^[a-zπ√∛]+/i.exec(s.slice(i));
    if (word) {
      let w = word[0].toLowerCase();
      if (w.startsWith("√")) w = "sqrt";
      else if (w.startsWith("∛")) w = "cbrt";
      const len = word[0].startsWith("√") || word[0].startsWith("∛") ? 1 : word[0].length;
      if (prevIsValue()) out.push({ k: "op", v: "*" });
      if (w === "pi" || w === "π") out.push({ k: "num", v: Math.PI });
      else if (w === "e") out.push({ k: "num", v: Math.E });
      else if (FUNCS.includes(w) || w === "cbrt") out.push({ k: "fn", v: w });
      else throw new CalcError(`Unknown: ${word[0]}`);
      i += len;
      continue;
    }
    if (c === "(") {
      if (prevIsValue()) out.push({ k: "op", v: "*" });
      out.push({ k: "(" });
    } else if (c === ")") out.push({ k: ")" });
    else if ("+-*/^%!".includes(c)) out.push({ k: "op", v: c });
    else throw new CalcError(`Unexpected “${c}”`);
    i++;
  }
  return out;
}

const DEG = Math.PI / 180;

/** Evaluates arithmetic: + − × ÷ ^ % !, parentheses, √, sin/cos/tan in degrees, log, ln, π. */
export function evaluate(src: string): number {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const expr = (): number => {
    let v = term();
    for (let t = peek(); t && t.k === "op" && (t.v === "+" || t.v === "-"); t = peek()) {
      i++;
      const r = term();
      v = t.v === "+" ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = unary();
    for (let t = peek(); t && t.k === "op" && (t.v === "*" || t.v === "/"); t = peek()) {
      i++;
      const r = unary();
      if (t.v === "/" && r === 0) throw new CalcError("Division by zero");
      v = t.v === "*" ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    const t = peek();
    if (t && t.k === "op" && (t.v === "-" || t.v === "+")) {
      i++;
      const v = unary();
      return t.v === "-" ? -v : v;
    }
    return power();
  };
  const power = (): number => {
    const base = postfix();
    const t = peek();
    if (t && t.k === "op" && t.v === "^") {
      i++;
      return Math.pow(base, unary());
    }
    return base;
  };
  const postfix = (): number => {
    let v = atom();
    for (let t = peek(); t && t.k === "op" && (t.v === "%" || t.v === "!"); t = peek()) {
      i++;
      if (t.v === "%") v = v / 100;
      else {
        if (v < 0 || v > 170 || !Number.isInteger(v)) throw new CalcError("Factorial needs a whole number");
        let f = 1;
        for (let k = 2; k <= v; k++) f *= k;
        v = f;
      }
    }
    return v;
  };
  const atom = (): number => {
    const t = toks[i++];
    if (!t) throw new CalcError("Incomplete");
    if (t.k === "num") return t.v;
    if (t.k === "(") {
      const v = expr();
      if (peek()?.k !== ")") throw new CalcError("Missing )");
      i++;
      return v;
    }
    if (t.k === "fn") {
      const arg = power();
      switch (t.v) {
        case "sqrt":
          if (arg < 0) throw new CalcError("√ of a negative number");
          return Math.sqrt(arg);
        case "cbrt":
          return Math.cbrt(arg);
        case "sin":
          return Math.sin(arg * DEG);
        case "cos":
          return Math.cos(arg * DEG);
        case "tan":
          return Math.tan(arg * DEG);
        case "log":
          return Math.log10(arg);
        case "ln":
          return Math.log(arg);
        case "abs":
          return Math.abs(arg);
      }
    }
    throw new CalcError("Incomplete");
  };
  const v = expr();
  if (i < toks.length) throw new CalcError("Unexpected end");
  if (!Number.isFinite(v)) throw new CalcError("No result");
  return v;
}

/** Rounds away float noise (0.1+0.2) and writes the decimal mark the user used. */
export function formatResult(v: number, comma: boolean): string {
  let s = String(Math.round(v * 1e9) / 1e9);
  if (Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0)) s = v.toPrecision(6);
  return comma ? s.replace(".", ",") : s;
}

/**
 * For a line ending in "=", the expression to compute: the text after the
 * previous "=" (or ":" / list marker), so "a = 3+4 =" computes 3+4.
 */
export function calcLine(line: string): { expr: string; answer: string } | null {
  const m = /^(.*?)=\s*$/.exec(line);
  if (!m) return null;
  let expr = m[1];
  const cut = Math.max(expr.lastIndexOf("="), expr.lastIndexOf(":"), expr.lastIndexOf("→"));
  if (cut !== -1) expr = expr.slice(cut + 1);
  expr = expr.replace(/^\s*(?:[-*] |\[[ xX]\] |#{1,3} )*/, "").trim();
  if (!expr || !/\d|π|pi/.test(expr)) return null;
  try {
    const v = evaluate(expr);
    return { expr, answer: formatResult(v, /\d,\d/.test(expr) && !/\d\.\d/.test(expr)) };
  } catch {
    return null;
  }
}

// ---- Easy formula syntax -> TeX -------------------------------------------------------

const GREEK = ["alpha", "beta", "gamma", "delta", "theta", "lambda", "mu", "sigma", "omega", "phi", "epsilon", "pi", "Delta", "Sigma", "Omega"];
const SYM_TEX: Record<string, string> = {
  "√": "\\sqrt", "π": "\\pi", "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx", "∞": "\\infty", "→": "\\to", "⇒": "\\Rightarrow",
  "±": "\\pm", "×": "\\times", "÷": "\\div", "·": "\\cdot", "°": "^\\circ", "∈": "\\in", "∪": "\\cup", "∩": "\\cap", "α": "\\alpha",
  "β": "\\beta", "θ": "\\theta", "Δ": "\\Delta", "∑": "\\sum", "∫": "\\int",
};

/**
 * Turns everyday notation into TeX: sqrt(x+1)/2, x^2, x^(n+1), a_1, pi,
 * <=, !=, *, inf, sum, int, abs(x), lim. Fractions take the nearest group
 * on each side of "/".
 */
export function easyToTex(src: string): string {
  let s = src;
  for (const [op, sym] of OPERATORS) s = s.split(op).join(sym);
  let i = 0;
  const groupEnd = (from: number): number => {
    // from points at "(" ; returns index of the matching ")"
    let d = 0;
    for (let k = from; k < s.length; k++) {
      if (s[k] === "(") d++;
      else if (s[k] === ")" && --d === 0) return k;
    }
    return s.length;
  };
  // Parses one operand: number, name, function call or (group).
  const operand = (): string => {
    while (s[i] === " ") i++;
    if (s[i] === "(") {
      const end = groupEnd(i);
      const inner = easyToTex(s.slice(i + 1, end));
      i = end + 1;
      return `(${inner})`;
    }
    const num = /^\d+(?:[.,]\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return num[0].replace(",", "{,}");
    }
    const w = /^[A-Za-z]+/.exec(s.slice(i));
    if (w) {
      const name = w[0];
      i += name.length;
      if (s[i] === "(" && ["sqrt", "cbrt", "abs", "sin", "cos", "tan", "log", "ln", "lim"].includes(name)) {
        const end = groupEnd(i);
        const inner = easyToTex(s.slice(i + 1, end));
        i = end + 1;
        if (name === "sqrt") return `\\sqrt{${inner}}`;
        if (name === "cbrt") return `\\sqrt[3]{${inner}}`;
        if (name === "abs") return `\\left|${inner}\\right|`;
        if (name === "lim") return `\\lim_{${inner}}`;
        return `\\${name}\\left(${inner}\\right)`;
      }
      if (GREEK.includes(name)) return `\\${name}`;
      if (name === "inf" || name === "infinity") return "\\infty";
      if (name === "sum") return "\\sum";
      if (name === "int") return "\\int";
      if (name === "deg") return "^\\circ";
      return name;
    }
    const ch = s[i++] ?? "";
    if (ch === "√") {
      const arg = operand();
      return `\\sqrt{${stripParens(arg)}}`;
    }
    return SYM_TEX[ch] ?? (ch === "*" ? "\\cdot" : ch);
  };
  const stripParens = (t: string) => (t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1) : t);
  const parts: string[] = [];
  while (i < s.length) {
    const before = i;
    let a = operand();
    if (i === before) break;
    // Powers and indices bind to the operand.
    for (;;) {
      if (s[i] === "^" || s[i] === "_") {
        const op = s[i++];
        const b = operand();
        a = `${a}${op}{${stripParens(b)}}`;
        continue;
      }
      break;
    }
    // Fraction: previous operand over the next one.
    let k = i;
    while (s[k] === " ") k++;
    if (s[k] === "/") {
      i = k + 1;
      let b = operand();
      while (s[i] === "^" || s[i] === "_") {
        const op = s[i++];
        b = `${b}${op}{${stripParens(operand())}}`;
      }
      a = `\\frac{${stripParens(a)}}{${stripParens(b)}}`;
    }
    parts.push(a);
  }
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/ ?([+\-=<>]) ?/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}
