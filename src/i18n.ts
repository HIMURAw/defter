// Interface language. Keys are the English texts themselves, so a missing
// translation simply shows English. Add a language by adding a dictionary.
import { tr } from "./lang/tr";

const LANGS: Record<string, Record<string, string>> = { tr };

let current = "en";

/** "auto" follows Obsidian's own language. */
export function setLanguage(lang: string) {
  if (lang === "auto" || !lang) {
    const ob = (window.localStorage.getItem("language") || "en").toLowerCase();
    current = ob.split("-")[0];
  } else current = lang;
}

export function language() {
  return current;
}

export const LANGUAGES: [string, string][] = [
  ["auto", "Same as Obsidian"],
  ["en", "English"],
  ["tr", "Türkçe"],
];

/** Translates a text; {name} placeholders are filled from vars. */
export function T(text: string, vars?: Record<string, string | number>): string {
  let out = LANGS[current]?.[text] ?? text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}
