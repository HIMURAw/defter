# Defter

Paper notebooks for [Obsidian](https://obsidian.md). Type with your keyboard and the words appear in animated handwriting on ruled paper. Draw, underline and highlight with the mouse. Every notebook is a plain Markdown file, so search, links and Git keep working, and your text stays readable even without the plugin.

> Status: early development (v0.1). Desktop only.

## Features

- Ruled pages with a margin line; text flows to the next page when one is full.
- Handwriting font (Caveat) with a pen-stroke reveal animation for each letter.
- Pen (4 colours, 3 widths), highlighter that stays under the text, stroke eraser, undo/redo.
- Notebooks are `.md` files: page text is plain Markdown, drawings live in a hidden block at the end.

## Use

- Right-click a folder → **New notebook**, or run **Defter: New notebook**.
- Tools: `Alt+1` write · `Alt+2` pen · `Alt+3` highlighter · `Alt+4` eraser · `Esc` back to writing.
- Pages: `Page Up` / `Page Down`, or the arrows in the toolbar.
- **Open as Markdown** (toolbar icon) shows the raw file; **Open as notebook** from the file menu switches back.

## File format

```markdown
---
defter-plugin: notebook
---

<!-- defter:page -->
Text of page one.

<!-- defter:page -->
Text of page two.

<!-- defter:ink
{"v":1,"pages":[
[],
[{"t":"pen","c":"#1d3a8f","w":3.5,"p":[100,212,180,214]}]
]}
-->
```

Any note becomes a notebook by adding `defter-plugin: notebook` to its frontmatter.

## Development

```bash
npm install
npm test          # format tests
npm run build     # main.js + styles.css
DEFTER_VAULT=/path/to/vault npm run deploy
```

## License

MIT. The bundled Caveat font is under the SIL Open Font License 1.1 (`fonts/OFL-Caveat.txt`).
