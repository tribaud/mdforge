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

## What's implemented (prototype)
- Inline rendering via decorations (`media-src/src/cm-livepreview.ts`): headings,
  **bold**, *italic*, `inline code`, ~~strikethrough~~, links (URL hidden),
  images (inline `<img>`), fenced **code blocks** (styled), **Mermaid** diagrams,
  and GFM **tables** (rendered as HTML).
- **Three-state task checkboxes**, including the MDForge `[~]` in-progress state
  (empty → in-progress → done). Toggling is a one-character text edit → one-line
  diff.
- Raw syntax/source is revealed whenever the caret enters a node/block (fully
  editable), so nothing is ever locked behind the rendering.

## Not implemented yet (would need more work to reach parity)
- Math (KaTeX), code-block syntax highlighting, GitHub alerts, frontmatter,
  wikilinks, footnotes.
- The top toolbar, slash menu, outline, image paste/drop, rename/move/delete —
  the host-side features still exist but have no webview UI here.

## Try it
1. `npm install` (adds the CodeMirror deps), then **F5**.
2. Open a `.md` with **Open with MDForge** and compare the feel vs `main`.
3. Edit a checkbox / a word, save, `git diff` — the diff should be minimal.

## Trade-off in one line
CodeMirror = perfect source fidelity + hybrid (syntax-reveals-near-caret) UX;
Milkdown = true WYSIWYG + the re-serialization tax. Both remain webview custom
editors, so neither renders inside VS Code's native diff editor.
