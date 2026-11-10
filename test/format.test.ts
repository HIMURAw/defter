import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyNotebook,
  fromLegacy,
  isNotebookText,
  NotebookFormatError,
  parseNotebook,
  serializeNotebook,
  type Notebook,
} from "../src/format.ts";

const stroke = (t: "pen" | "hl" = "pen") => ({ t, c: "#1d3a8f", w: 3.5, p: [10, 20, 30.5, 40] });

function roundTrip(nb: Notebook) {
  return parseNotebook(serializeNotebook(nb));
}

test("empty notebook survives a round trip", () => {
  const nb = emptyNotebook();
  assert.deepEqual(roundTrip(nb), nb);
  assert.ok(isNotebookText(serializeNotebook(nb)));
});

test("text, blank lines and Turkish letters are kept exactly", () => {
  const nb = emptyNotebook();
  nb.pages = [
    { text: "TYT Türkçe\n\nİğneli çuval, ışık, şğüöç\n", ink: [] },
    { text: "\n\n  girintili satır\n\n\n", ink: [stroke("hl")] },
    { text: "", ink: [] },
  ];
  assert.deepEqual(roundTrip(nb), nb);
});

test("drawings stay with their page", () => {
  const nb = emptyNotebook();
  nb.pages = [{ text: "a", ink: [] }, { text: "b", ink: [stroke(), stroke("hl")] }];
  const back = roundTrip(nb);
  assert.equal(back.pages[0].ink.length, 0);
  assert.equal(back.pages[1].ink.length, 2);
  assert.ok(!serializeNotebook(nb).split("<!-- defter:ink")[0].includes('"p"'), "page text stays clean");
});

test("page text that looks like a marker cannot split the page", () => {
  const nb = emptyNotebook();
  nb.pages = [{ text: "<!-- defter:page -->\n<!-- defter:ink\n-->", ink: [] }];
  const back = roundTrip(nb);
  assert.equal(back.pages.length, 1);
  assert.equal(back.pages[0].text, nb.pages[0].text);
});

test("other frontmatter keys and text before the first page are kept", () => {
  const md = "---\ntags: [tyt]\ndefter-plugin: notebook\n---\n\nIntro line\n\n<!-- defter:page -->\nhello\n\n";
  const nb = parseNotebook(md);
  assert.equal(nb.preface, "Intro line");
  assert.match(nb.frontmatter, /tags: \[tyt\]/);
  assert.equal(serializeNotebook(nb), md);
});

test("a plain note turned into a notebook keeps its text as page one", () => {
  const nb = parseNotebook("---\ndefter-plugin: notebook\n---\nmy old note\nline 2\n");
  assert.equal(nb.pages.length, 1);
  assert.equal(nb.pages[0].text, "my old note\nline 2");
});

test("Windows line endings are read", () => {
  const nb = parseNotebook("---\r\ndefter-plugin: notebook\r\n---\r\n\r\n<!-- defter:page -->\r\nhi\r\n\r\n");
  assert.equal(nb.pages[0].text, "hi");
});

test("a broken drawing block is an error, never silently dropped", () => {
  const head = "---\ndefter-plugin: notebook\n---\n\n<!-- defter:page -->\nx\n\n";
  assert.throws(() => parseNotebook(head + "<!-- defter:ink\n{oops\n-->\n"), NotebookFormatError);
  assert.throws(() => parseNotebook(head + "<!-- defter:ink\n{\"v\":1,\"pages\":[]}\n"), NotebookFormatError);
});

test("invalid strokes are dropped, valid ones kept", () => {
  const md = '---\ndefter-plugin: notebook\n---\n\n<!-- defter:page -->\nx\n\n<!-- defter:ink\n{"v":1,"pages":[\n[{"t":"pen","c":"#000","w":2,"p":[1,2]},{"t":"x"},{"t":"pen","c":"#000","w":2,"p":[1]}]\n]}\n-->\n';
  assert.equal(parseNotebook(md).pages[0].ink.length, 1);
});

test("notes without the key are not notebooks", () => {
  assert.equal(isNotebookText("# Just a note\n"), false);
  assert.equal(isNotebookText("---\ntags: x\n---\nbody"), false);
  assert.equal(isNotebookText("---\ndefter-plugin: notebook\n---\n"), true);
});

test("legacy .defter JSON converts", () => {
  const nb = fromLegacy('{"v":1,"pages":[{"text":"eski","ink":[{"t":"pen","c":"#000","w":2,"p":[1,2]}]},{"text":"","ink":[]}]}');
  assert.equal(nb.pages.length, 2);
  assert.equal(nb.pages[0].text, "eski");
  assert.equal(nb.pages[0].ink.length, 1);
  assert.deepEqual(roundTrip(nb), nb);
  assert.throws(() => fromLegacy("{nope"), NotebookFormatError);
});

import { getProp, setProp, pageTitle } from "../src/format.ts";

test("notebook settings are read and written in frontmatter", () => {
  let fm = "defter-plugin: notebook\ntags: [tyt]";
  assert.equal(getProp(fm, "defter-paper"), null);
  fm = setProp(fm, "defter-paper", "grid");
  fm = setProp(fm, "defter-cover", "#c0392b");
  assert.equal(getProp(fm, "defter-paper"), "grid");
  assert.equal(getProp(fm, "defter-cover"), "#c0392b");
  assert.match(fm, /defter-cover: "#c0392b"/, "# must be quoted or YAML reads a comment");
  fm = setProp(fm, "defter-paper", "dots");
  assert.equal(fm.match(/defter-paper/g)!.length, 1);
  fm = setProp(fm, "defter-paper", null);
  assert.equal(getProp(fm, "defter-paper"), null);
  assert.match(fm, /tags: \[tyt\]/);
  const nb = parseNotebook(`---\n${fm}\n---\n\n<!-- defter:page -->\nx\n\n`);
  assert.equal(getProp(nb.frontmatter, "defter-cover"), "#c0392b");
});

test("shapes round trip, broken shapes are dropped", () => {
  const nb = emptyNotebook();
  nb.pages = [{ text: "", ink: [{ t: "pen", c: "#000", w: 2, p: [1, 2, 3, 4], s: "arrow" }] }];
  assert.deepEqual(roundTrip(nb), nb);
  const bad = '---\ndefter-plugin: notebook\n---\n\n<!-- defter:page -->\n\n\n<!-- defter:ink\n{"v":1,"pages":[\n[{"t":"pen","c":"#000","w":2,"p":[1,2,3,4,5,6],"s":"rect"},{"t":"pen","c":"#000","w":2,"p":[1,2,3,4],"s":"star"}]\n]}\n-->\n';
  assert.equal(parseNotebook(bad).pages[0].ink.length, 0);
});

test("page title prefers the first heading", () => {
  assert.equal(pageTitle("\n  intro\n# Türev\nx"), "Türev");
  assert.equal(pageTitle("\n\n**Limit** kuralları"), "Limit kuralları");
  assert.equal(pageTitle(""), "");
});

test("page attributes (journal date, template, bookmark) round trip", () => {
  const nb = emptyNotebook();
  nb.pages = [
    { text: "bugün", ink: [], date: "2026-11-10", mark: "#ffb45c" },
    { text: "", ink: [], tpl: "cornell" },
    { text: "düz", ink: [] },
  ];
  const md = serializeNotebook(nb);
  assert.match(md, /<!-- defter:page date=2026-11-10 mark=#ffb45c -->/);
  assert.deepEqual(parseNotebook(md), nb);
  assert.equal(parseNotebook(md.replace("date=2026-11-10", "bogus=1")).pages[0].date, undefined);
});

test("objects (image, sticky note, formula) round trip and bad ones are dropped", () => {
  const nb = emptyNotebook();
  nb.pages = [
    { text: "", ink: [] },
    { text: "x", ink: [], obj: [
      { k: "img", x: 10, y: 20, w: 300, h: 200, v: "attachments/soru 1.png" },
      { k: "note", x: 400, y: 100, w: 180, h: 140, v: "Unutma: türev kuralı", c: "#fff27a" },
      { k: "tex", x: 100, y: 500, w: 160, h: 50, v: "\\frac{a}{b}" },
    ] },
  ];
  const back = roundTrip(nb);
  assert.deepEqual(back, nb);
  const md = serializeNotebook(nb).replace('"k":"tex"', '"k":"video"');
  assert.equal(parseNotebook(md).pages[1].obj!.length, 2);
});

test("page background path with spaces survives the marker", () => {
  const nb = emptyNotebook();
  nb.pages = [{ text: "x", ink: [], bg: "Ekler/Deneme 1 p3.png" }];
  const md = serializeNotebook(nb);
  assert.match(md, /<!-- defter:page bg=Ekler%2FDeneme%201%20p3\.png -->/);
  assert.deepEqual(parseNotebook(md), nb);
});

test("new pen kinds, shapes and objects are kept; unknown ones dropped", () => {
  const nb = emptyNotebook();
  nb.pages = [
    {
      text: "",
      ink: [
        { t: "pen", c: "#000", w: 2, p: [1, 2, 3, 4], y: "fountain" },
        { t: "pen", c: "#000", w: 2, p: [0, 0, 10, 0, 5, 9], s: "poly" },
        { t: "pen", c: "#000", w: 2, p: [0, 0, 10, 10], s: "ellipse", y: "dash" },
      ],
      obj: [
        { k: "tape", x: 1, y: 2, w: 3, h: 4, v: "", c: "#f00" },
        { k: "stamp", x: 1, y: 2, w: 3, h: 4, v: "EXAM" },
      ],
    },
  ];
  assert.deepEqual(parseNotebook(serializeNotebook(nb)), nb);
  const bad = '---\ndefter-plugin: notebook\n---\n\n<!-- defter:page -->\n\n\n<!-- defter:ink\n{"v":1,"pages":[\n[{"t":"pen","c":"#000","w":2,"p":[1,2],"y":"crayon"},{"t":"pen","c":"#000","w":2,"p":[1,2,3,4],"s":"poly"}]\n]}\n-->\n';
  assert.equal(parseNotebook(bad).pages[0].ink.length, 0);
});
