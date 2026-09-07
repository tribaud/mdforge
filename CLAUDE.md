# MDForge — project guide for Claude

MDForge is a VS Code extension that turns the editor into a **Typora/Obsidian-like
live-preview Markdown editor** with **GitHub-style rendering**. It is built on
**CodeMirror 6** and is **MIT-licensed** — no paid tiers, no telemetry.

The defining choice: **the CodeMirror document IS the Markdown text.** There is no
semantic model and no re-serialization, so an edit only changes the characters
typed — a one-character change is a one-character diff, identifiers stay
grep-able, and git history stays clean. "Rendering" is done with **decorations**:
syntax markers are hidden and content styled, and the raw syntax is revealed
whenever the selection enters a node (Obsidian "live preview").

> History: MDForge 0.2.x shipped a Milkdown/ProseMirror engine. It was replaced
> by this CodeMirror engine (0.3.0) for perfect source fidelity; the Milkdown
> code and its deps were removed. If you need the old engine, see the `v0.2.x`
> tags. Repo memory: `mdforge-pending`, `mdforge-release-state`.

This file is the shared memory of the project: architecture, how each feature
works, the CodeMirror gotchas we learned the hard way, and the conventions. Read
it fully before making changes.

---

## 1. Tech stack

- **Extension host** (Node/VS Code API): `src/extension.ts`. Engine-agnostic:
  custom text editor, webview wiring, file↔webview sync, CSP, outline tree,
  presentation, wikilink open, asset ops, diagnostics forwarding, blank-line
  normalization.
- **Webview app** (browser): `media-src/src/main.ts` + `cm-*.ts`, bundled by
  esbuild to `media/dist/main.js`.
- **Editor engine**: CodeMirror 6 (`@codemirror/{view,state,commands,language,
  search,lint}`, `@codemirror/lang-markdown`, `@codemirror/language-data`,
  `@lezer/markdown` with the GFM extension). Headless-ish: CM gives the text
  editor + Lezer Markdown parse tree; we build all the WYSIWYG rendering as
  decorations and all the UI (toolbar, menus, popups, node widgets).
- **Rendering libs**: `mermaid` (diagrams, lazy import), `katex` (math, lazy),
  `@lezer/highlight` + `defaultHighlightStyle` (code highlighting inside fenced
  blocks, via `codeLanguages`).
- **Paste**: `turndown` + `turndown-plugin-gfm` (HTML→Markdown), `mathml-to-latex`
  (web MathJax → `$…$`).

## 2. Repository layout

| Path | Role |
| --- | --- |
| `src/extension.ts` | Custom text editor, webview wiring, sync, CSP, outline, presentation, wikilink resolver, asset ops (localize/move/rename/delete), **diagnostics forwarding**, **blank-line normalization** (command + format-on-save), **quick-fix** runner, diff-editor "open each side" buttons. |
| `media-src/src/main.ts` | Webview entry: assembles the CodeMirror editor, keymaps, extensions, host message handling, image paste/drop/pick, host buttons, source-view toggle, presentation, footnote jump, link open. |
| `media-src/src/cm-livepreview.ts` | The **live-preview `StateField`**: builds all decorations (headings, marks, tasks, images, HR, mermaid/math/table widgets, alerts, wikilinks, footnotes, frontmatter card, code-block language picker, compact blank lines) + the **table cell renderer** (Markdown / safe raw HTML) and **single-cell editing**. |
| `media-src/src/cm-toolbar.ts` | Top toolbar + selection bubble; `wrap`/`insertLink`/`insertHr`/`insertTable`/`insertFootnote` (footnote popup with section + editable bookmark); search toggle. |
| `media-src/src/cm-slash.ts` | `/` slash command menu (`createSlashMenu(view).update`). |
| `media-src/src/cm-table.ts` | Floating table toolbar (add/del row & col, align, delete) — rewrites the table Markdown text directly. |
| `media-src/src/cm-block-drag.ts` | Left-margin block controls: draggable `⠿` handle (reorders top-level blocks / heading sections, click = select the block) and the `▾`/`▸` fold chevron. |
| `media-src/src/cm-paste-html.ts` | Paste HTML→Markdown (turndown+GFM, escaping OFF, MathML→LaTeX, footnote rewrite + per-section renumber). |
| `media-src/src/cm-theme.css` | All styling, VS Code light/dark aware. |
| `media-src/src/turndown-plugin-gfm.d.ts` | Type shim for `turndown-plugin-gfm`. |
| `esbuild.mjs` | Bundles the webview (ESM + code splitting) to `media/dist/`. |
| `scripts/cm-preview.mjs` | Headless preview harness (`npm run preview`). |
| `SPEC.md` | Feature roadmap. |

## 3. How it fits together

- The extension registers a `CustomTextEditorProvider` for `*.md`/`*.markdown`
  at `priority: "option"` (**opt-in**, not the default editor). For each document
  it creates a webview whose HTML loads `media/dist/main.js` under a strict CSP
  (nonce + `webview.cspSource`, plus `wasm-unsafe-eval`, `worker-src blob:`,
  `connect-src` for Mermaid/KaTeX).
- **Why opt-in, not default (the diff constraint).** A custom editor (webview)
  *cannot* render inside VS Code's diff editor: each side is handed to a separate
  webview that only receives its own version — never the counterpart or VS Code's
  computed diff — so red/green is impossible. Making MDForge the default therefore
  breaks **every** git comparison. Keeping the native text editor as the default
  preserves all of those. Users switch per file via the **`editor/title` buttons**
  (book icon → `mdforge.openEditor`; code icon → `mdforge.openWithTextEditor`) or
  `Ctrl/Cmd+Shift+Alt+M`. (Same reason VS Code's own Markdown preview is a side
  panel.)
- **Sync**: host → webview posts `setContent` on external changes; webview → host
  posts `edit` with the new Markdown (whole-document replace via `WorkspaceEdit`).
  A `syncedText`/`applyingRemote` guard avoids echo loops. Because the CM document
  is the text, `edit` carries exactly what the user typed — **no re-serialization,
  perfect diffs.** On the first `setContent` the caret is placed past any
  frontmatter (`bodyStart`) so the frontmatter renders as its card, not raw.
- **Messages** host→webview: `setContent`, `config`, `revealHeading`,
  `togglePresentation`, `refreshImages`, `imageInserted`, `diagnostics`, `tags`.
  webview→host: `ready`, `edit`, `setPageWidth`, `openWikilink`, `openExternal`, `insertImage`,
  `importImagePath`, `localizeAssets`, `renameNote`, `moveNote`, `deleteNote`,
  `openSettings`, `normalizeBlankLines`, `requestQuickFix`, `requestTags`,
  `debugPasteHtml`, `error`.

## 4. How each feature works (and why)

Everything below is a **decoration** or a plain **text edit** on the CM document,
so it round-trips for free unless noted.

- **Live-preview decorations** (`cm-livepreview.ts` `livePreview` StateField):
  `buildDecorations(state)` walks the Lezer tree + a regex post-pass and emits
  line/mark/replace/widget decorations. Rebuilt on every doc **and selection**
  change (so `editing()` — "does a selection touch this range?" — can reveal raw
  syntax under the caret). MUST be a `StateField` (not a ViewPlugin) to provide
  **block** decorations. Wrapped in a `Compartment` (`preview`) so the source-view
  toggle can switch it off.
- **Headings / inline marks**: line class enlarges the heading; the `###`, `**`,
  `` ` `` and `~~` markers are hidden with `Decoration.replace` unless the caret is
  on them.
- **Task `[~]` state**: bullet AND ordered list items with `[ ]`/`[x]`/`[~]` get a
  three-state checkbox widget. Click cycles empty → in-progress → done; the
  in-progress `~` step is skipped when `mdforge.checkbox.enableInProgress` is off
  (`nextTaskState`). `[~]` is an MDForge convention (GFM only has `[ ]`/`[x]`).
- **Mermaid & math** (`MermaidWidget`/`MathWidget`): rendered SVG/KaTeX as a block
  widget. A diagram is scaled up to the **full text column**
  (`mdforge.mermaid.fitWidth`, default on → body class `mdforge-mermaid-fit`):
  mermaid writes `style="max-width:<natural>px"` on the `<svg>`, so only an
  `!important` override widens it, and `height: auto` must beat its `height`
  attribute or the viewBox is letterboxed instead of scaling. The upscale is capped
  at `max-height: 80vh` — the ratio is preserved, so a tall narrow chain (a 4-node
  `graph TD` measured 2138px once fitted) stays readable and centred instead of
  becoming a page-long strip.
  `✎ Éditer` drops the caret into the source (which, via reveal-on-edit,
  shows the raw source with a live "Aperçu" preview + `✓ Terminer` to leave).
  Mermaid parse-error orphan nodes are swept from `document.body` after each
  render (`sweepMermaidOrphans`).
  **Themes** (`mdforge.mermaid.theme`) come from `MERMAID_THEMES`: mermaid's own
  four (`default`/`dark`/`forest`/`neutral`) plus ours, built on **`base`** — the
  only built-in theme meant to be re-coloured through `themeVariables`. `blue` is
  a pale-blue palette, `contrast` near-white fills with **thick** outlines
  (`THICK_STROKES` passed as `themeCSS`, which mermaid appends after the theme's
  own rules inside the SVG's `<style>` — so a plain `stroke-width` wins on order
  alone, deliberately without `!important`, which would also beat a diagram's own
  `classDef`). Ours come in light/dark **pairs** (`DARK_TWIN`): the setting names
  the light side and the editor picks. This is not cosmetic — text that floats on
  the page instead of on a filled shape (a gantt title, its dates, a section
  label) is painted with `textColor`/`titleColor`, and the light palette left
  those navy-on-near-black. `mermaidConfig()` is the single source of the
  `initialize()` payload, and a theme change must go through `setMermaidTheme` +
  `redrawMermaid` (mermaid reads the theme only at render time).
- **Code blocks**: fenced code is shown as styled source (highlighted via
  `codeLanguages`); a **language picker** (`LangWidget`, `<input list=datalist>`
  of `@codemirror/language-data` names + free text) floats top-right and rewrites
  the info string on change.
- **Tables** (`TableWidget` + `cm-table.ts`): rendered HTML table. **Cells render
  their content**: `renderCell` → `renderMarkdown` (images incl. `![[embed]]`,
  code, math, bold/italic/strike, links, wikilinks, footnote refs, bare URLs —
  emphasis and link labels **recurse**) or, as soon as the cell carries a tag,
  `renderHtml` (DOMParser + an allow-list: unknown tags keep their content,
  `script`/`style`/`iframe` are dropped, `on*` / script URLs / `url()` in a style
  never survive, and text nodes still go through the Markdown renderer). Cells are
  parsed by `parseTableCells` → `splitCells`, which yields each cell's **absolute
  document offsets** and treats `\|` as an escaped pipe.
  Two levels of editing:
  - **one cell** — hover → `✎` (or double-click): the table STAYS rendered, the
    cell gets `.cm-td-editing`, and its raw Markdown opens in a field above the
    table (`cellEditor`). Enter/`✓` commits, Escape/`✕` cancels, Tab moves on. The
    field is plain DOM, so the state (`cellEdit` + `cellEditEffect`, which the
    live-preview field must rebuild on) lives module-side; committing rewrites
    only that cell's range, and **bails out if the offsets went stale**.
    `flushCellEdit` keeps a pending edit when another cell's `✎` is clicked.
  - **the whole table** — the block's `✎ Éditer`, i.e. caret inside → raw source +
    preview + the floating structural toolbar (add/del row & col, align, delete)
    that rewrites the table text. Entering it clears any open cell field.
  - **column widths** — GFM has nowhere to store one, so they live in an HTML
    comment on the line ABOVE the table: `<!--[10,60,15,15]-->`, one integer
    percentage per column (`COLUMN_WIDTHS_RE`, `columnWidthsAbove`,
    `roundWidths`, `scaleWidths`, `fitWidths`). Any other renderer ignores a
    comment, so the file stays portable. **The percentages are of the text width,
    not of each other: their SUM is the table's own width** — `[10,60,15,15]`
    fills the column, `[10,20,15]` is a table 45% wide. That model is what makes
    the last border draggable and what keeps a first drag from resizing anything.
    A table with NO comment is `width: 100%` (CSS) — a small table hugging the
    left margin read as a bug. With one, `table-layout: fixed` + an inline
    `width: <sum>%` and a `colgroup` of shares.
    Dragged from a `.cm-col-grip` on each border of the header row (`addGrips`):
    an INNER border moves that one border (the pair keeps its combined width, so
    no other column shifts and the total is unchanged); the LAST one is the
    table's own right edge and scales every column at once (the shares stay, the
    table's width changes). That last grip sits INSIDE the wrap (`right: 0`, not
    the `-3px` overhang of the others): an absolutely positioned control hanging
    past a scroll container still counts in its `scrollWidth`, and those 2px put a
    horizontal scrollbar under every full-width table. The drag dispatches
    NOTHING: a document change
    rebuilds the widget and would drop the drag with it, so only `mouseup` writes
    (`writeWidths`, which bails out if the table moved under it). It freezes what
    is on screen BEFORE measuring, scaling the cell widths onto the TABLE's
    measured width — with collapsed borders the cells total a couple of pixels
    short, and the table visibly shrank on the first pixel of the drag. The freeze
    waits for 2px of travel, so a plain CLICK on a grip writes nothing into a table
    that had none. A new comment takes the table's own indentation (at column 0 it
    would close the list a nested table sits in), the inner-border clamp bounds
    BOTH sides against 0 (a column already under MIN can be recovered, never made
    worse), and the teardown also runs on a window `blur` or a `mousemove` with no
    button held — a lost mouseup would otherwise leave `user-select: none` on the
    body and a live listener.
    `roundWidths` keeps each column ≥ 1, the total ≤ 100, and snaps a total within
    2 points of full width to exactly 100 (pulling a table to the edge must write
    `[10,60,15,15]`, not `[10,59,15,15]`).
    The comment is hidden and its line compacted unless the caret is on it; it
    travels with the table when the block is dragged (`topBlockAt` binds the two,
    in BOTH directions), is rewritten in the same transaction when a column is
    added or removed — at the table's current total, not renormalized to 100 —
    and is deleted with the table (`cm-table.ts`). A stale count is tolerated,
    not trusted: `fitWidths` truncates extras, pads with the average, and rescales
    to the total the comment declared — dropping an entry must not shrink the
    table (a 4-entry comment on a 3-column table rendered it at 75% width).
- **GitHub alerts**: a per-blockquote type dropdown (`AlertSelectWidget`, "—
  Citation" = none) always shown on the first line; the `[!TYPE]` marker is hidden
  and the block styled as a callout.
- **Wikilinks / footnotes**: `[[target]]` decorated + click→host; `[^id]` refs and
  `[^id]:` defs styled, click jumps ref↔def. The toolbar `†` inserts a footnote via
  a popup: pick the target **section** (existing note-def sections + Notes/
  Bibliographie), edit the auto-computed **bookmark** (`B1` for Bibliographie,
  `1/2/3` for Notes), then it inserts `[^id]` at the caret and the def at the end
  of that section.
- **Frontmatter**: a leading `---` block renders as a discreet **card** (title →
  H1, other keys → chips); `✎` reveals the raw YAML. Exempt from inline parsing.
  **One property at a time**: clicking a chip opens its value in a field below the
  card (`fmEdit` + `fmEditEffect`, the same shape as the table's `cellEdit`).
  `parseFrontmatter` models only what people write — scalar, flow `[a, b]`, comma
  `a, b`, indented `- item` block — keeps each entry's document range, and
  `serializeEntry` writes it back **in its own style**; anything else is marked
  `complex` and clicking it opens the raw YAML instead of guessing. A list key
  (`tags`, `keywords`, `categories`, `aliases`) gets a chip editor, and `tags` /
  `keywords` complete on the workspace's known tags (`attachSuggestions`, a
  reusable dropdown — Enter takes the typed text unless the user walked into the
  list with the arrows, else both handlers fired and added two values).
  The `+` chip (`fmAdding`) opens a combobox over `KNOWN_KEYS` — the curated
  PKM/Obsidian list, `@today` resolved at insertion — then the workspace's own
  keys, then free text; keys already in the block are filtered out. The new line
  is appended at `pos + raw.length` (or before the closing `---` when the block is
  empty) and its editor opens in the same transaction.
- **Known tags** (`TagIndex` in `extension.ts`): ONE recursive sweep of the
  workspace's Markdown frontmatter (`findFiles`, only the first 4 KB of each file
  decoded, 3000-file cap, 16 in flight), cached in `context.workspaceState` so a
  reopen is instant, run **lazily on the first `requestTags`** and again only on
  the editor's `↻` (with a progress notification). `parseFrontmatterTags` is pure
  and exported (flow / comma / block lists, `tags` + `keywords`, top-level only),
  as is `parseFrontmatterKeys` — the sweep collects the key NAMES too, for free.
  No file watcher, no index to maintain: a saved document's own tags are merged in
  (`onDidSaveTextDocument` + the webview `edit` message). The freshness line in the
  editor is the deal with the user — it says how old the list is and how to redo
  it. NOTE: the tag list is part of the card widget's `eq()` (via `tagsGen`), or
  CodeMirror keeps the old DOM and the line never updates.
- **HR / blank lines**: `---` → a compact rule widget. Blank source lines are
  shrunk to a **stable** small height (`cm-md-blank`) — never revealed on caret
  (see gotchas).
- **Draggable blocks** (`cm-block-drag.ts`): `⠿` on hover moves the top-level block
  (a heading drags its whole section) via a whole-line, whole-doc text edit.
  **Clicking** it instead SELECTS the block (guarded by `justDragged`), so the
  selection bubble lands on it and a style can be applied at once.
- **Source view**: toolbar toggle reconfigures the `preview` compartment to `[]`,
  showing raw Markdown (syntax highlighting only) in a monospace column.
- **Search & folding**: `@codemirror/search` (`Cmd+F`, toolbar 🔍 toggles the
  panel) + `codeFolding` with a `foldService` that folds heading sections. There is
  **no fold gutter**: its arrows were too discreet, so the `▾`/`▸` chevron sits in
  the left margin next to the `⠿` handle (`cm-block-fold`, `foldable` +
  `foldEffect`/`unfoldEffect`/`foldedRanges`). The **open** `▾` follows the
  pointer; every **collapsed** section keeps a permanent `▸`
  (`.cm-block-fold-closed`, a pooled element per folded range in the viewport,
  re-placed from `update()` via `requestMeasure` — never read the layout during an
  update) — a fold with no marker only showed as a jump in the line numbers.
  All three controls carry the same instant `data-tip` bubble as the toolbar
  (anchored on their LEFT edge — centred would fall off the window — and flipped
  below the control near the top of the frame, where above would cover the
  toolbar). No native `title`: it would double the bubble.
  On a **heading**, a third control (`.cm-block-fold-all`, a rotated `»`) folds or
  unfolds every heading of that level at once (`headingRangesAtLevel`, fenced code
  skipped; one transaction of `foldEffect`/`unfoldEffect`, never a duplicate).
  Its level scan runs on mousemove, so it is cached and invalidated from
  `update()` on any doc or fold change. Only the glyph is rotated, never the box —
  a rotated box rotates its tooltip with it. The three controls need ~58px of left
  margin — hence `.cm-content` padding `24px 64px`.
- **Line numbers** (`mdforge.lineNumbers`, default on): `lineNumbers()` in the
  `gutters` compartment. `formatNumber` returns `''` for an empty line **while the
  live-preview field is present** (a compacted blank line is ~0.55em tall and the
  number would be clipped mid-glyph); source view numbers every line. It is also
  called with a padding number PAST the last line to size the gutter — check
  `line <= state.doc.lines` first or it throws.
- **Content width** (`mdforge.pageWidth`, toolbar `⇤⇥`): `comfortable` centres the
  readable column, `full` lets `.cm-content` span the window
  (`body.mdforge-width-full`). The button is a **shortcut for the setting**, not a
  second state: it applies the class at once for feedback, then posts
  `setPageWidth` so the host writes the setting **globally** (a reading width is
  not per-workspace) and the config watcher echoes it back to every open editor —
  `applyPageWidth` is the single place that paints class, icon and tooltip. Both
  toggles call `view.requestMeasure()`: a wider column re-wraps every line and
  re-scales every fitted diagram, so CodeMirror's measured heights go stale.
- **Justified text** (`mdforge.textAlign: justify`): display only, a
  `mdforge-justify` body class → `text-align: justify` on `.cm-line`, minus
  headings / code / frontmatter / blank lines. It only shows on **soft-wrapped**
  lines: justification never stretches the last line of a block and every source
  line is its own block — hence `mdforge.format.paragraphs`, below.
- **Linter diagnostics** (`@codemirror/lint`): the host forwards
  `vscode.languages.getDiagnostics(uri)` (markdownlint, spell checkers…) on
  `onDidChangeDiagnostics`; `main.ts` builds `Diagnostic[]` (wavy underline,
  hover bubble with message + rule-doc link + a **"Corrections rapides…"** action).
  The action posts `requestQuickFix` → host `runQuickFix` runs
  `executeCodeActionProvider` + a `showQuickPick` + applies the chosen edit/command
  (no webview lightbulb).
- **Reformatting** (host-side, pure, in `extension.ts`): `formatMarkdown(text,
  joinParas)` = the optional paragraph unwrap, then the blank-line pass.
  - `normalizeBlankLines`: MD012 collapse dupes / MD022 around headings / MD031
    around fences / MD047 final newline; skips fence + frontmatter content.
  - `joinParagraphs` (`mdforge.format.paragraphs: oneLine`, **the default**): puts
    each paragraph back on ONE line — the prerequisite for justified text. Leaves
    frontmatter, fenced/indented code, block math, tables, quotes, headings, HTML
    blocks, thematic breaks and link/footnote definitions verbatim, and never joins
    across a Markdown hard break (two trailing spaces, `\`, `<br>`); a wrapped list
    item IS joined onto its marker line. Idempotent.
  Runs **on demand** (command `mdforge.normalizeBlankLines`, titled *Reformat
  document*, + toolbar `¶`) or **on save when asked** (`mdforge.format.onSave`, via
  `onWillSaveTextDocument`, gated on `provider.isOpen`). **Never per-keystroke** —
  that would resurrect the diff noise the CM engine exists to avoid.
  `format.onSave` replaces `format.blankLines: onSave`, whose name read like
  *which rules apply* when it only ever answered *automatically or on demand*;
  `reformatOnSave()` honours the old setting unless the new one is set explicitly
  (`inspect()`, not `get()` — `get` cannot tell a default from a choice).
- **Paste** (`cm-paste-html.ts`): rich HTML → Markdown via turndown+GFM with
  escaping disabled; web math via `data-mathml` → `mathml-to-latex`; footnotes →
  `[^n]` with per-section renumber; optional `> source` footer (`appendSource`).
  Image on the clipboard / drop / the 🖼 picker → host saves it next to the note.
  **Rich HTML wins over the fallback bitmap** an app also copies (OneNote/Word
  paste a screenshot alongside the HTML — pasting a note used to drop just that
  flat image); the exception is a **lone `<img>` with no text** (`htmlIsJustImage`
  → plain image copy → save the crisper bitmap instead). On conversion, every
  embedded `<img>` (`data:`/`http(s):`/`file:`) is **localized** into the assets
  folder before turndown runs — `htmlToMarkdown(html, resolveImage)` is async and
  the resolver round-trips through the host `importImagePath` (now handling `data:`
  and remote URLs via `fetchImageBytes`, `quiet` so auth-gated OneNote/CDN URLs
  fail without a modal). So the emitted `![](assets/Note-<hash>.png)` survives even
  after Office/CDN auth expires on the original URLs. A toolbar **debug toggle**
  (`🐛`, `ICONS.bug`) dumps the full clipboard — the type list, files, and every
  string payload (`text/html`, `text/plain`, `text/rtf`, uri-list…) — to a tab
  (`debugPasteHtml` → host), without consuming the paste, to inspect exactly how
  an app encodes its content (e.g. nested numbered lists).
- **Outline / presentation / wikilink open / asset ops / diff buttons**: host-side
  in `extension.ts` (engine-agnostic, unchanged from 0.2.x).

## 5. CodeMirror gotchas we learned (read before debugging)

- **Block decorations MUST come from a `StateField`, not a `ViewPlugin`** — a
  ViewPlugin providing block decorations blanks the editor.
- **Block-widget & line MARGINS drift the caret.** CM measures the border-box
  height of `.cm-line`/widgets for its vertical layout model; CSS `margin` falls
  *outside* the border-box and is **not counted**, so clicks/arrows land on the
  wrong line for everything below. **Use `padding`, never `margin`,** for spacing
  on block widgets and line decorations. Symptom: "curseur saute de 3-4
  paragraphes, inutilisable à la souris".
- **Compact blank lines must have a STABLE height.** An earlier version revealed
  blank lines to full height under the caret — that changed line heights as the
  caret moved, reflowing everything below and making arrow-nav jump. Keep them a
  fixed small height (no reveal).
- **Re-measure after async widget content.** Mermaid SVG / KaTeX / `img.onload`
  change a widget's height after CM measured layout → call `view.requestMeasure()`
  and give widgets an `estimatedHeight`.
- **Body-DOM menus: prefer explicit `create*(view).update` over a ViewPlugin.**
  The slash menu as a ViewPlugin did NOT instantiate; it's built as
  `createSlashMenu(view).update` called from the update listener (like the bubble
  and table toolbar). The block-drag handle *is* a ViewPlugin, but it owns its own
  DOM listeners on `view.dom` — that pattern is fine.
- **Drag handle listeners go on `view.dom`, not `view.scrollDOM`.** The handle
  sits in the left margin (outside the scroller); a `mouseleave` on the scroller
  hid it the instant the pointer crossed the margin to grab it. Use `view.dom` +
  a `relatedTarget` check.
- **Place margin controls from the `.cm-line` element, not from `coordsAtPos`.** A
  widget at the start of a line (the alert-type dropdown, a checkbox) pushes
  `coordsAtPos(line.from)` to the RIGHT of itself, so the handle/chevrons landed
  inside that widget (reported on `> [!NOTE]`). `lineLeft()` measures the line
  element's rect instead.
- **Anything placed against `view.dom` must be re-placed on SCROLL.** `view.dom`
  is the editor frame and does not scroll, so a marker positioned from
  `coordsAtPos` stays pinned to the screen while its block travels — listen on
  `view.scrollDOM` (`passive`) and re-run the placement. And because `.cm-editor`
  has `overflow: visible` **and** CodeMirror's viewport extends past what is on
  screen, off-frame markers must be hidden (or clamped, for the hover handle of a
  tall block) — otherwise they are painted over the toolbar.
- **Open links on `mousedown` (capture), not click.** Ctrl/⌘-click first places
  the caret, which reveals the raw `[text](url)` and drops the `data-href` before
  a click lands — so intercept on mousedown.
- **`setDiagnostics` from `@codemirror/lint` auto-enables the lint extension**; we
  also add `lintGutter()`. Don't set the `Diagnostic.source` field if you already
  render the source in `renderMessage` (it double-prints).
- **`lineNumbers({ formatNumber })` is also called with a line number PAST the end
  of the document** (a `9`/`99`/`999` padding value used to measure the gutter's
  width). `state.doc.line(n)` on it throws, CM catches it and *disables the
  crashed plugin* — the gutter silently vanishes. Guard with
  `line <= state.doc.lines`.
- **A DOM field inside a widget must survive the rebuild it triggers.** Writing to
  the document re-creates the widget, so the `<input>` is a NEW element: keep the
  state module-side (see `cellEdit`), re-focus from `toDOM`, and commit on
  Enter/blur rather than per keystroke (a per-keystroke rebuild re-renders every
  image in the table).
- **A dropdown on `document.body` must die with the input that opened it, and a
  blanket purge in `destroy()` is wrong.** CodeMirror builds the NEW widget's DOM
  before destroying the old one, so `destroy()` wiping every `.cm-suggest-menu`
  killed the menu the rebuilt card had just created (symptom: the list went empty,
  or answered from a stale closure). Stash the menu on its input (`_menu`) and
  remove only those (LangWidget's idiom).
- **A `blur` from a widget being rebuilt is not the user leaving.** Beyond
  deferring the dispatch (below), check `input.isConnected` before acting: the
  frontmatter combobox closed itself the moment the tag list arrived.
- **NEVER `view.dispatch()` from a `blur` handler inside a widget.** CodeMirror
  re-syncs the focus while updating its DOM, so the blur fires from *inside*
  `updateInner` and the dispatch throws *"Calls to EditorView.update are not
  allowed while an update is in progress"* — which, via the global error handler,
  used to blank the whole editor. Defer out of the update (`setTimeout(…, 0)`,
  plus `safeDispatch`), and treat a blur that comes with a `destroy()` as a
  teardown, not as the user leaving the field.
- **A post-boot error must not tear the editor down.** `showError` replaces the
  page only before `booted`; afterwards it reports to the host and logs. A widget
  hiccup is not a failed initialization.

## 6. Build, run, verify

```sh
npm install
npm run build                 # tsc (extension) + esbuild (webview) → media/dist
npx tsc -p media-src --noEmit # webview type-check (also in CI)
```

- Press **F5** to open an Extension Development Host, then right-click a `.md` →
  **Open with MDForge** (or `Ctrl/Cmd+Shift+Alt+M`).
- The headless harness ships a built-in sample; feed your own document with
  `node scripts/cm-preview.mjs <file.md>` to exercise a specific case.
- **Headless preview** (stand-in for F5 when there's no GUI): `npm run preview`
  or ad-hoc Playwright probes — run them **from the repo directory** (playwright-
  core resolves from the repo `node_modules`), with a mocked `acquireVsCodeApi`;
  `THEME=dark` supported. Webview init errors are surfaced on-screen and logged to
  the host as `[MDForge webview]`.

## 7. Testing note

Visual/interactive behavior (live preview, drag, click handlers, hover bubbles)
must be verified in a running Extension Development Host or the headless harness —
a green build only proves it compiles and bundles.

## 8. Branch & release workflow (required)

`main` is **protected**: no direct pushes, force-push and deletion disabled. Every
change lands through a **pull request** (0 approvals required — you merge your own
— but the CI check must pass). Tags are **not** protected, so releases push tags
directly.

### Feature flow

1. Branch off `main`: `git checkout -b feat/xyz`.
2. Commit, then `git push -u origin feat/xyz`.
3. Open a PR: `gh pr create --fill --base main`.
4. **Code review** the diff and address findings; verify via F5.
5. The **CI check** (`.github/workflows/ci.yml`: build + webview type-check) must
   be green.
6. Merge: `gh pr merge --merge --delete-branch` (a real merge commit).

### Release flow (publishes to the VS Code Marketplace + Open VSX)

1. Make sure `main` has the code to release.
2. Tag = the version: `git tag -a v0.3.0 -m "MDForge 0.3.0" && git push origin v0.3.0`.
3. `.github/workflows/publish.yml` derives the version from the tag, packages, and
   publishes. Secrets: `VSCE_PAT` and `OVSX_PAT` (Open VSX step skipped when unset).

## 9. Conventions & known limitations

- Non-standard checkbox states are an MDForge convention: `[ ]`/`[x]` are GFM;
  `[~]` (in progress) is ours.
- Wikilink `[[ ]]` brackets stay visible while editing (not yet hidden).
- Reformatting (blank lines + paragraph unwrap) only ever runs **when asked**:
  the command, the toolbar `¶`, or every save if `mdforge.format.onSave` is on. The
  editor never rewrites the source on its own, and never per keystroke.
- Justification is a **view** preference: nothing is written into the Markdown. It
  needs `mdforge.format.paragraphs: oneLine` + one reformat to be visible on
  hard-wrapped prose.
- **Perf**: `buildDecorations` re-scans the whole document on every selection
  change. Fine for normal notes; add a viewport limit before very large files.
- Bundle size: mermaid (many diagram chunks), KaTeX fonts and the
  `@codemirror/language-data` grammars dominate `media/dist`.

### Native diff editor — blocked on proposed API (watch actively)

MDForge **cannot** render inside VS Code's native diff editor. A
`CustomTextEditorProvider` webview only ever receives its own side, never the
counterpart or the computed diff — so red/green is impossible. VS Code's own
experimental Markdown editor gets native diffs only via **proposed APIs**
(`customEditorDiffs` — `resolveCustomTextEditorInlineDiff(documents:{original,
modified}, singleWebview)` — and `customEditorPriority`), which are stripped for
Marketplace extensions. **Watch for these to graduate to stable** (track
microsoft/vscode#292379). When stable, implement
`resolveCustomTextEditorInlineDiff` and drop the opt-in-only stance. Interim: the
diff editor's title bar carries two buttons (`mdforge.openDiffOriginal` /
`openDiffModified`) to open either side in MDForge as a normal editor. Full audit
in repo memory (`mdforge-vscode-diff-audit`).

## 10. Publishing

VS Code Marketplace: `tribaud` publisher, Azure DevOps PAT with **Marketplace >
Manage**, then `vsce package` / `vsce publish`. Optionally mirror to Open VSX.
It's free.
