# Defter

Paper notebooks for [Obsidian](https://obsidian.md). Type with your keyboard and the words appear in animated handwriting on ruled paper. Draw, underline and highlight with the mouse. Every notebook is a plain Markdown file, so search, links and Git keep working, and your text stays readable even without the plugin.

> Status: early development (v0.4). Desktop only.

## Features

- **Handwriting as you type.** Four handwriting fonts (Caveat, Kalam, Patrick Hand, Shantell Sans) with full Turkish and Latin Extended support. Each letter is revealed like a pen stroke; speed is adjustable or off.
- **Real paper.** Ruled, grid, dotted or blank pages in cream, white or dark. Text always sits on the lines, whatever font or size you pick. When a page is full, writing continues on the next one.
- **Pencil case.** A floating toolbar at the bottom: ballpoint, fountain pen (the line swells and thins with your speed), pencil and dashed pen in 5 inks and 3 widths; a highlighter that stays under the text; line, arrow, box, circle and triangle shapes; stroke eraser, undo and redo. Mouse lines are smoothed.
- **Draw and hold.** Draw a rough line, circle, triangle or box with the pen and keep still for a moment: it snaps into a clean shape. Shift draws straight lines.
- **Write with the mouse or touchpad.** The write pad is a large strip at the bottom: write big letters there and they land small and neat on the page line, inside a frame that moves on as you write. In touchpad mode you just move your finger and hold Space to let the ink flow.
- **Study tools.**
  - *Hide tape:* cover anything with a strip of tape and click it to peek.
  - *Study mode (Alt+S):* highlighted text and flashcard answers are hidden; click to reveal.
  - *Flashcards:* write `front :: back` on any line, press the cards button and review with a 5-box Leitner schedule (1, 2, 4, 8, 16 days). **Defter: Study due flashcards in all notebooks** reviews everything at once.
  - *To-dos:* start a line with `[ ]`; click the box to tick it. The page panel lists every open to-do.
  - *Study timer:* Pomodoro (25+5, 50+10) or a stopwatch from the header; study minutes per notebook show up in the library.
- **PDF pages.** Import pages of a PDF (a test booklet, lecture slides) as notebook pages and write or draw on them.
- **Selection.** Lasso drawings and objects, then move, resize, recolour, copy (Ctrl+C, also into another notebook), duplicate (Ctrl+D), delete, or save them as a reusable sticker.
- **Stickers and stamps.** Ready-made stamps (✓ ✗ ★ ! ? IMPORTANT, REVIEW, EXAM…), your own words, and your saved drawings.
- **Zoom and spread.** Ctrl+wheel zooms (50–300 %); on a wide pane two pages lie open side by side like a book, with a page-turn animation. Focus mode (Alt+F) hides everything but the paper.
- **Study marks without leaving the keyboard.** `# heading`, `**bold**`, `==highlight==`, `- list` and `[[links]]` are drawn in ink on the page; Ctrl+click opens a link.
- **Find anything.** Page list with titles or thumbnails, to-do list, search inside the notebook (Ctrl+F); move, duplicate and remove pages.
- **A real library.** Every folder with notebooks is a wooden bookcase; notebooks stand on the shelves as books with coloured spines. Drag a book to reorder it or to move it to another bookcase (the file moves to that folder). Create, rename and reorder bookcases.
- **Journal.** A notebook with one page per day: it opens on today's page with the date written at the top, and a calendar jumps to any day.
- **Page sizes.** A4, B5, A5 and square; text keeps its size, the page just holds more or fewer lines.
- **Pictures, sticky notes, formulas.** Paste a screenshot with Ctrl+V, add sticky notes, place LaTeX formulas. Move and resize them with the select tool.
- **Page templates.** Cornell notes, question & solution, formula sheet and cover page.
- **Bookmark tabs and lasso.** Coloured tabs stick out of the page edge for quick jumps; the lasso selects drawings and objects to move or delete them.
- **PDF export** of the whole notebook, exactly as it looks; copy or save a single page as an image.
- **Plain Markdown files.** Page text is ordinary Markdown, so Obsidian search, backlinks and Git keep working, and nothing is locked in.

## Use

- Open the library from the ribbon (library icon) or run **Defter: Open library**.
- New notebook: the **+** book on the shelf, right-click a folder → **New notebook**, or **Defter: New notebook**.
- Tools: `Alt+1` write · `Alt+2` pen · `Alt+3` highlighter · `Alt+4` eraser · `Alt+5` shapes · `Alt+6` select · `Alt+7` write pad · `Esc` back to writing. `F1` (or the **?** in the pencil case) lists every shortcut.
- The **⊞ insert** button adds pictures, sticky notes, hide tape, stickers and stamps, formulas, PDF pages, page templates and bookmarks. **Defter: Open today's journal page** opens the journal.
- Pages: `Page Up` / `Page Down`, the arrows in the pencil case, or the page list in the header.
- Notebook settings (paper, tone, handwriting, size, ink, cover): the sliders icon in the header. Defaults: **Settings → Defter**.
- The header has the study timer, the flashcards button and study mode. The `⋯` menu has PDF export, page images, PDF import, duplicate/add/remove page, **Pull text back from the next pages** (after making pages bigger), focus mode and **Open as Markdown**.

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

Any note becomes a notebook by adding `defter-plugin: notebook` to its frontmatter. Per-notebook look is stored as `defter-page`, `defter-paper`, `defter-tone`, `defter-font`, `defter-size`, `defter-ink` and `defter-cover` properties. Shapes are strokes with an `s` field (`line`, `arrow`, `rect`, `ellipse`, `tri` with two points, or `poly` with its corners); a `y` field names the pen (`fountain`, `pencil`, `dash`). Page markers can carry `date=` (journal), `tpl=` (template), `mark=` (bookmark colour) and `bg=` (URI-encoded path of a page background, e.g. an imported PDF page); pictures, sticky notes, formulas, tape and stamps are stored in an `objects` list next to `pages` in the drawing block. Flashcard progress and study minutes are kept in the plugin's settings, not in the notebook.

## Development

```bash
npm install
npm test          # format and flashcard tests
npm run build     # main.js + styles.css
DEFTER_VAULT=/path/to/vault npm run deploy
```

## License

MIT. The bundled fonts (Caveat, Kalam, Patrick Hand, Shantell Sans) are under the SIL Open Font License 1.1 (`fonts/OFL-*.txt`).
