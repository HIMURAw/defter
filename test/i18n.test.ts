import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tr } from "../src/lang/tr.ts";

// Every T("…") text in the source has a Turkish translation.
test("Turkish covers every interface text", () => {
  const missing = new Set<string>();
  for (const f of readdirSync("src").filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync("src/" + f, "utf8");
    for (const m of src.matchAll(/\bT\("((?:[^"\\]|\\.)*)"/g)) {
      const key = JSON.parse(`"${m[1]}"`);
      if (/[A-Za-z]{2}/.test(key) && !(key in tr)) missing.add(key);
    }
  }
  assert.deepEqual([...missing], []);
});
