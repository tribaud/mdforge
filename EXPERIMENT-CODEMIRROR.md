# Experiment: CodeMirror 6 "Live Preview" engine

This branch (`experiment/codemirror`) swaps MDForge's editor engine from
**Milkdown/ProseMirror** (true WYSIWYG, on `main`) to **CodeMirror 6** with an
Obsidian-style *Live Preview*, to compare the two.

## Why
With CodeMirror the document **is** the Markdown text — there is no semantic
model and **no re-serialization**. A one-character edit is a one-character diff,
identifiers stay grep-able, and idempotence is free. This side-steps the whole
serialization-fidelity problem the Milkdown build has to fight.

The host (`src/extension.ts`) is **unchanged** — only the webview engine
(`media-src/`) differs. The engine speaks the same protocol (`ready`/`edit` out,
`setContent`/`config` in).

## What's implemented
- Inline rendering via decorations (`media-src/src/cm-livepreview.ts`): headings,
  **bold**, *italic*, `inline code`, ~~strikethrough~~, links (URL hidden),
  images (inline `<img>`), fenced **code blocks** with **syntax highlighting**
  (`codeLanguages` → Lezer nested parsing), **Mermaid** diagrams, GFM **tables**
  (rendered as HTML), **GitHub alerts** (`> [!NOTE]` → tinted callout + icon),
  **wikilinks** (`[[target|alias]]`, click-to-open), YAML **frontmatter** (styled,
  exempt from Markdown inline parsing), **footnotes** (`[^id]` ref → jump to def),
  and **KaTeX math** (`$…$` inline and `$$…$$` block, lazy-loaded).
- **Three-state task checkboxes**, including the MDForge `[~]` in-progress state
  (empty → in-progress → done). Toggling is a one-character text edit → one-line
  diff.
- **Formatting toolbar**: a persistent top bar + a selection bubble; toggles are
  idempotent (re-click removes the markers).
- **Host features wired** to the existing protocol: image **paste/drop** (saved
  next to the note via `insertImage`/`importImagePath`), **outline** click
  (`revealHeading`, fenced code skipped so indices match), **presentation mode**
  (read-only + chrome hidden), image **refresh** on disk change.
- Raw syntax/source is revealed whenever the caret enters a node/block (fully
  editable), so nothing is ever locked behind the rendering.

## Blocking points vs Milkdown (honest)
- No **in-place editing** of rendered tables/mermaid/math — the caret reveals the
  raw text and you edit that (inherent to "the document is the text").
- Every **rich-editing ergonomic** (list continue/indent, HTML-paste→Markdown,
  block drag, slash menu, node views) must be hand-built; Milkdown ships them.
- Reveal-on-edit shows the **whole node** raw, not just the marker under the caret.
- Decorations are rebuilt on every selection change — fine here, but a big doc
  would want a viewport-limited build.
None are hard walls; the core win (perfect source fidelity) is already achieved.

## Try it
1. `npm install` (adds the CodeMirror deps), then **F5**.
2. Open a `.md` with **Open with MDForge** and compare the feel vs `main`.
3. Edit a checkbox / a word, save, `git diff` — the diff should be minimal.

## Trade-off in one line
CodeMirror = perfect source fidelity + hybrid (syntax-reveals-near-caret) UX;
Milkdown = true WYSIWYG + the re-serialization tax. Both remain webview custom
editors, so neither renders inside VS Code's native diff editor.
