# Defter

Paper notebooks for [Obsidian](https://obsidian.md). Type with your keyboard and the words appear in animated handwriting on ruled paper. Draw, underline and highlight with the mouse. Every notebook is a plain Markdown file, so search, links and Git keep working, and your text stays readable even without the plugin.

> Status: early development (v0.3). Desktop only.

## Features

- **Handwriting as you type.** Four handwriting fonts (Caveat, Kalam, Patrick Hand, Shantell Sans) with full Turkish and Latin Extended support. Each letter is revealed like a pen stroke; speed is adjustable or off.
- **Real paper.** Ruled, grid, dotted or blank pages in cream, white or dark. Text always sits on the lines, whatever font or size you pick. When a page is full, writing continues on the next one.
- **Pencil case.** A floating toolbar at the bottom: pen (5 inks, 3 widths), highlighter that stays under the text, line / arrow / box shapes (hold Shift for straight lines and squares), stroke eraser, undo and redo.
- **Study marks without leaving the keyboard.** `# heading`, `**bold**`, `==highlight==`, `- list` and `[[links]]` are drawn in ink on the page; Ctrl+click opens a link.
- **Find anything.** Page list with titles, search inside the notebook (Ctrl+F), move and remove pages.
- **A real library.** Every folder with notebooks is a wooden bookcase; notebooks stand on the shelves as books with coloured spines. Drag a book to reorder it or to move it to another bookcase (the file moves to that folder). Create, rename and reorder bookcases.
- **Journal.** A notebook with one page per day: it opens on today's page with the date written at the top, and a calendar jumps to any day.
- **Page sizes.** A4, B5, A5 and square; text keeps its size, the page just holds more or fewer lines.
- **Pictures, sticky notes, formulas.** Paste a screenshot with Ctrl+V, add sticky notes, place LaTeX formulas. Move and resize them with the select tool.
- **Page templates.** Cornell notes, question & solution, formula sheet and cover page.
- **Bookmark tabs and lasso.** Coloured tabs stick out of the page edge for quick jumps; the lasso selects drawings and objects to move or delete them.
- **PDF export** of the whole notebook, exactly as it looks.
- **Plain Markdown files.** Page text is ordinary Markdown, so Obsidian search, backlinks and Git keep working, and nothing is locked in.

## Use

- Open the library from the ribbon (library icon) or run **Defter: Open library**.
- New notebook: the **+** book on the shelf, right-click a folder → **New notebook**, or **Defter: New notebook**.
- Tools: `Alt+1` write · `Alt+2` pen · `Alt+3` highlighter · `Alt+4` eraser · `Alt+5` shapes · `Alt+6` select · `Esc` back to writing.
- The **⊞ insert** button adds pictures, sticky notes, formulas, page templates and bookmarks. **Defter: Open today's journal page** opens the journal.
- Pages: `Page Up` / `Page Down`, the arrows in the pencil case, or the page list in the header.
- Notebook settings (paper, tone, handwriting, size, ink, cover): the sliders icon in the header. Defaults: **Settings → Defter**.
- The `⋯` menu has PDF export, add/remove page and **Open as Markdown**.

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

Any note becomes a notebook by adding `defter-plugin: notebook` to its frontmatter. Per-notebook look is stored as `defter-page`, `defter-paper`, `defter-tone`, `defter-font`, `defter-size`, `defter-ink` and `defter-cover` properties. Shapes are strokes with an `s` field (`line`, `arrow`, `rect`) and two points. Page markers can carry `date=` (journal), `tpl=` (template) and `mark=` (bookmark colour); pictures, sticky notes and formulas are stored in an `objects` list next to `pages` in the drawing block.

## Development

```bash
npm install
npm test          # format tests
npm run build     # main.js + styles.css
DEFTER_VAULT=/path/to/vault npm run deploy
```

## License

MIT. The bundled fonts (Caveat, Kalam, Patrick Hand, Shantell Sans) are under the SIL Open Font License 1.1 (`fonts/OFL-*.txt`).
