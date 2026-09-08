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
| `src/quickdiff.ts` | **Quick diff**, host side: resolves the built-in `vscode.git` API, reads the base blob (index → `HEAD`), watches doc/repo/setting, posts the line changes. |
| `src/linediff.ts` | `diffLines` — the patience line diff behind the quick-diff margin. Imports nothing, so it is testable (`npm run test:quickdiff`). |
| `src/searchreveal.ts` | **Search reveal**, host side: calls the internal `search.action.getSearchResults` and posts the match positions for the note being opened. |
| `src/searchmatches.ts` | `matchesForFile` — parses the search view's result text. Imports nothing, so it is testable (`npm run test:search`). |
| `media-src/src/main.ts` | Webview entry: assembles the CodeMirror editor, keymaps, extensions, host message handling, image paste/drop/pick, host buttons, source-view toggle, presentation, footnote jump, link open. |
| `media-src/src/cm-livepreview.ts` | The **live-preview `StateField`**: builds all decorations (headings, marks, tasks, images, HR, mermaid/math/table widgets, alerts, wikilinks, footnotes, frontmatter card, code-block language picker, compact blank lines) + the **table cell renderer** (Markdown / safe raw HTML) and **single-cell editing**. |
| `media-src/src/cm-toolbar.ts` | Top toolbar + selection bubble; `wrap`/`insertLink`/`insertHr`/`insertTable`/`insertFootnote` (footnote popup with section + editable bookmark); search toggle. |
| `media-src/src/cm-slash.ts` | `/` slash command menu (`createSlashMenu(view).update`). |
| `media-src/src/cm-table.ts` | Floating table toolbar (add/del row & col, align, delete) — rewrites the table Markdown text directly. |
| `media-src/src/cm-block-drag.ts` | Left-margin block controls: draggable `⠿` handle (reorders top-level blocks / heading sections, click = select the block) and the `▾`/`▸` fold chevron. |
| `media-src/src/cm-quickdiff.ts` | Quick-diff margin: a CodeMirror `gutter()` whose markers are the added/modified/deleted bars the host computed. |
| `media-src/src/cm-searchmatch.ts` | Search reveal, webview side: marks the matching lines, scrolls to one, and walks them (`F8` / `Shift+F8`). |
| `media-src/src/cm-paste-html.ts` | Paste HTML→Markdown (turndown+GFM, escaping OFF, MathML→LaTeX, footnote rewrite + per-section renumber). |
| `media-src/src/cm-theme.css` | All styling, VS Code light/dark aware. |
| `media-src/src/turndown-plugin-gfm.d.ts` | Type shim for `turndown-plugin-gfm`. |
| `esbuild.mjs` | Bundles the webview (ESM + code splitting) to `media/dist/`. |
| `scripts/cm-preview.mjs` | Headless preview harness (`npm run preview`). |
| `scripts/quickdiff.test.mjs` | Line-diff tests (`npm run test:quickdiff`). |
| `SPEC.md` | Feature roadmap. |

## 3. How it fits together

- The extension registers a `CustomTextEditorProvider` for `*.md`/`*.markdown`
  at `priority: { "textEditor": "default", "diffEditor": "explicit" }` — the
  **default** editor for notes, and never the one used for a diff. For each
  document it creates a webview whose HTML loads `media/dist/main.js` under a
  strict CSP (nonce + `webview.cspSource`, plus `wasm-unsafe-eval`,
  `worker-src blob:`, `connect-src` for Mermaid/KaTeX).
- **Why per-editor-kind priority (the diff constraint, and how it was lifted).**
  A custom editor (webview) *cannot* render inside VS Code's diff editor: each
  side is handed to a separate webview that only receives its own version — never
  the counterpart or VS Code's computed diff — so red/green is impossible. That
  is still true (§9). Until VS Code 1.129 it also made MDForge unusable as the
  default editor, because one `priority` string governed the normal editor AND
  the diff slot: `"default"` meant **every** git comparison opened in MDForge,
  i.e. broke. So MDForge shipped `"option"` (opt-in) through 0.5.x.
  **1.133 finalized per-kind priority** (microsoft/vscode#292379), and since
  1.129 the diff priority no longer inherits from the editor one — it defaults to
  `explicit`, so a custom editor is left out of diffs unless it opts in
  (`contributedCustomEditors.ts`, `getPriorityFromContribution`). MDForge states
  both halves explicitly: default for notes, never for diffs. **This is what
  `engines.vscode: ^1.133.0` buys** — on an older VS Code the object form is not
  understood and `default` would hijack the diff editor again, so the engine
  floor is the safety, not a formality. Users still switch per file via the
  **`editor/title` buttons** (book icon → `mdforge.openEditor`; code icon →
  `mdforge.openWithTextEditor`) or `Ctrl/Cmd+Shift+Alt+M`, and can put the text
  editor back for good with `workbench.editorAssociations`.
- **Sync**: host → webview posts `setContent` on external changes; webview → host
  posts `edit` with the new Markdown (whole-document replace via `WorkspaceEdit`).
  A `syncedText`/`applyingRemote` guard avoids echo loops. Because the CM document
  is the text, `edit` carries exactly what the user typed — **no re-serialization,
  perfect diffs.** On the first `setContent` the caret is placed past any
  frontmatter (`bodyStart`) so the frontmatter renders as its card, not raw.
- **Messages** host→webview: `setContent`, `config`, `revealHeading`,
  `togglePresentation`, `refreshImages`, `imageInserted`, `diagnostics`,
  `quickDiff`, `tags`, `searchMatches`.
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
  (`mdforge.mermaid.fitWidth`, default on → body class `mdforge-mermaid-fit`), by
  `fitMermaidSvg` — in **JS, in px**, not in CSS:
  - mermaid emits `width="100%"` and `style="max-width:<natural>px"` on the `<svg>`
    and no height. A percentage against the shrink-to-fit target has no definite
    width to resolve against, so the browser fell back to the **300px** default of
    a replaced element: that is the old bug that made every diagram wider than
    300px look small. The width is therefore computed and written.
  - the ceiling is the width at which the diagram would be `FIT_MAX_HEIGHT` (80%)
    of the frame tall, floored at the natural width, clamped to the column.
    **Never a CSS `max-height`**: that letterboxes a tall diagram — the box keeps
    the column width and the drawing shrinks inside it, ending up *smaller* than
    natural (a 200×1500 diagram in an 800px column measured 96×720).
  - it is re-run on render, on `resize`, on `update.geometryChanged` (a split or a
    side panel changes the column without a window resize) and on both toggles;
    it writes nothing when the value is unchanged, so it cannot feed itself.
  - the CSS selectors are `.cm-mermaid-target > svg`, never `.cm-mermaid svg`: the
    ⤢ / ↻ / ✎ buttons sit in the same block and their icons are `<svg>` too — the
    loose selector blew the zoom icon from 13px up to 22px.
  `✎ Éditer` drops the caret into the source (which, via reveal-on-edit,
  shows the raw source with a live "Aperçu" preview + `✓ Terminer` to leave).
  Mermaid parse-error orphan nodes are swept from `document.body` after each
  render (`sweepMermaidOrphans`).
  **Themes** (`mdforge.mermaid.theme`) come from `MERMAID_THEMES`: mermaid's own
  four (`default`/`dark`/`forest`/`neutral`) plus ours, built on **`base`** — the
  only built-in theme meant to be re-coloured through `themeVariables`. `blue` is
  a light cool-blue palette, `contrast` white fills with **thick black** outlines
  and **bold** labels (`THICK_BOLD` passed as `themeCSS`, which mermaid appends
  after the theme's own rules inside the SVG's `<style>` — so plain
  `stroke-width` / `font-weight` win on order alone, deliberately without
  `!important`, which would also beat a diagram's own `classDef`; mermaid measures
  labels with that style applied, so bold text does not overflow its box). Labels
  are `<text>` in some diagram kinds and a `foreignObject` span in others, hence
  both selector families. `pieRamp` gives each theme explicit `pie1…` tints (and
  `pieOpacity: 1`): derived from a monochrome palette, slices came out as
  indistinguishable near-white wedges. A **named theme is literal** — `blue`
  is that light blue whatever the editor looks like; the dark palettes have their
  own names (`blue-dark`, `contrast-dark`) and only `auto` follows the editor. An
  earlier version auto-swapped a named theme for its dark twin and it surprised:
  the dropdown said `blue`, the diagram came out navy. Prefer a dark palette on a
  dark editor all the same — text that floats on the page rather than on a filled
  shape (a gantt title, its dates, a section label) takes `textColor`/`titleColor`
  and goes navy-on-near-black otherwise.
  **`editorIsDark()`, not `prefers-color-scheme`.** In a webview that media query
  reports the **OS**, so a light VS Code theme on a dark macOS answered "dark" and
  `auto` drew dark diagrams on a white page. Read VS Code's own theme kind
  (`data-vscode-theme-kind` / the `vscode-*` body class) and keep the media query
  only as the fallback for the headless harness, which has neither. `mermaidConfig()` is the single source of the
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
  toggles call `refitMermaid()`: a wider column re-wraps every line and re-scales
  every fitted diagram, so CodeMirror's measured heights go stale. The host writes
  the setting back at the level where it is already defined (`inspect()`) — a plain
  Global write under a workspace value is shadowed by it, the echo snaps the button
  back, and the user's global preference changed for nothing.
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
- **Quick diff** (`mdforge.quickDiff`, default on): what changed since git, in
  MDForge's own margin — the single-file half of the diff story the native diff
  editor cannot give us (§9), and it needs no proposed API. Host side, `QuickDiff`
  (`src/quickdiff.ts`) resolves the built-in **`vscode.git`** extension's API
  (a local structural interface — the Git extension's `git.d.ts` ships inside VS
  Code, not as a package, and MDForge has **zero runtime dependencies**), reads
  the base with `repository.show(ref, fsPath)` — `''` (the index) then `HEAD`,
  the same base as VS Code's own quick diff — and diffs it against
  `document.getText()`, i.e. the **live** text, unsaved edits included. It
  recomputes on doc change (debounced 300ms — the webview posts an `edit` per
  keystroke), on `repository.state.onDidChange` (commit, stage, branch switch)
  and on the setting; a `generation` counter drops a stale `show()`, and an
  identical result is not re-posted. Untracked file, no repository, Git disabled
  → empty, never an error.
  `diffLines` lives apart in **`src/linediff.ts`**, which imports nothing, so
  `npm run test:quickdiff` can exercise it outside an Extension Host. It is a
  **patience diff**: trim the common prefix/suffix, anchor on lines occurring
  exactly once on each side, recurse between anchors, and only fall back to an
  exact LCS inside an anchorless region (one rewritten paragraph). The anchors
  are not an optimization — with the plain quadratic LCS, two edits far apart in
  a 3000-line note blew the cell budget and painted the WHOLE file as modified.
  Webview side (`cm-quickdiff.ts`): a real CodeMirror **`gutter()`**, not a
  marker placed against `view.dom` — CM then owns the vertical layout, so the
  bars follow folding, compacted blank lines and scrolling with none of the
  re-placement gotchas the `⠿` handle has (§5). The markers carry no DOM at all,
  only `elementClass`, so a bar IS the gutter element and is exactly as tall as
  its line. Between two host posts they are mapped through the user's edits.
  A deletion has no line of its own: it is one wedge at the seam, clamped onto
  the last line when the cut is at the end of the document.
- **Search reveal** (`mdforge.revealSearchMatch`, default on): a click on a
  workspace-search (`Ctrl/Cmd+Shift+F`) result opens the note **at the match**,
  which VS Code does not do on its own — when the target resolves to a custom
  editor the range is dropped on the way, and `resolveCustomTextEditor` gets the
  document and nothing else (microsoft/vscode#289785, open; #301887 and #211351
  closed as *not planned*; nothing in `src/vscode-dts` proposes it either). The
  positions are therefore read back out of the **search view**, through the
  internal `search.action.getSearchResults`, which returns what "Copy All" would
  copy: an unindented, tildified path per file, then `  <line>,<col>: <text>`
  per match (`  <line>:` for the further lines of a multi-line one).
  `searchmatches.ts` parses that and nothing else — it imports nothing, so
  `npm run test:search` pins the format down outside an Extension Host.
  Consequences, all deliberate:
  - We learn **every** match in the file, never which one was clicked. MDForge
    goes to the first, marks the others, and `F8` / `Shift+F8` walk them.
  - The match's **length is not in that output**, so the **line** is
    highlighted, not the word (`.cm-search-hit`, and `-current` for the one the
    caret is on — TWO classes, because the current match is also the active
    line and CodeMirror's own `.cm-activeLine` background wins at equal
    specificity).
  - The command is **internal**. It is feature-detected once
    (`getCommands(true)`), called in a `try/catch`, and any surprise reads as
    "no matches": the note simply opens as it always did.
  - **Nothing says the note was opened FROM a result.** `getSearchView` only
    requires the search view to be the ACTIVE view of its container — enough to
    rule out the Explorer, not a `Ctrl+P` with the results still on screen, and
    not a search view docked in the panel next to an active Explorer. Three
    guards narrow it: the opens MDForge performs itself are suppressed
    explicitly (`suppressReveal`, called on the wikilink jump, the rename
    re-open, the diff-side buttons and `mdforge.openEditor`), the editor has to
    be `webviewPanel.active` (restoring a window must not make background tabs
    jump), and the setting switches the lot off. What remains is landing on a
    line that genuinely matches the search you still have open — a small
    surprise, against the reported bug of landing at the top of the file.
  - The results are cached for 500ms: the command renders EVERY match of the
    workspace to a string (`search.maxResults` defaults to 20000) and ships it
    over RPC, which several editors resolving at once must not pay for twice.
  Webview side (`cm-searchmatch.ts`): a `StateField` holding the line
  decorations AND the match offsets — a decoration only remembers the line it
  marks, so `F8` would lose the column on its first hop and two matches on one
  line would collapse into one. The whole set is dropped on the first document
  change rather than mapped through it (it answers "here is what you were
  looking for", which stops being true once you type), and `F8` / `Shift+F8`
  take the next match AFTER the caret, or the previous one before it, wrapping
  at either end — relative to the caret, so they keep working after a click
  somewhere else in the note.
  The scroll is re-issued up to three times over ~1s (`settle`) — mermaid,
  KaTeX and images all land after CodeMirror measured, and a target centred
  before they did ends up off-screen; it stops as soon as the line is visible,
  or if the caret moved (the user's scroll is theirs). Focus is taken **only if
  the webview already has it** (`document.hasFocus()`): with VS Code's
  preview-on-arrow, focus stays in the result list, and stealing it would end
  the walk on its first step.
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
npm run test:quickdiff        # the line diff behind the quick-diff margin
npm run test:search           # parsing of the search view's result text
```

- MDForge is now the **default** editor for `.md`/`.markdown`, so opening one is
  enough; the code icon (or `Ctrl/Cmd+Shift+Alt+M`) goes back to the text editor.
  A **git diff still opens natively** — that is `diffEditor: "explicit"` doing its
  job, and it is the first thing to check after touching `contributes.customEditors`.
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
- The **quick-diff margin** marks lines, and stops there: no inline word diff, no
  "revert this hunk", no peek of the previous version — those are the diff
  editor's job, and the diff editor is still out of reach (below). It also needs
  the built-in Git extension enabled; SCMs other than git show nothing.
- **Search reveal knows every match in the note, never the one that was
  clicked** — VS Code drops the range (§4). The first match is where you land,
  `F8` does the rest, and the highlight is a line, not a word. It cannot tell
  either that the note was opened FROM a result: with the search view on screen,
  a `Ctrl+P` to a matching note also lands on a match. It also leans on
  an internal command: if `search.action.getSearchResults` ever changes shape,
  the feature goes quiet rather than wrong. Watch microsoft/vscode#289785 — a
  `selection` on the custom-editor context would replace the whole mechanism.
  The same loss hits the Problems panel, Go to Definition and `Ctrl+P file:42`,
  which are NOT covered.
- **Perf**: `buildDecorations` re-scans the whole document on every selection
  change. Fine for normal notes; add a viewport limit before very large files.
- Bundle size: mermaid (many diagram chunks), KaTeX fonts and the
  `@codemirror/language-data` grammars dominate `media/dist`.

### Native diff editor — still blocked on a proposed API (watch actively)

MDForge **cannot** render inside VS Code's native diff editor. A
`CustomTextEditorProvider` webview only ever receives its own side, never the
counterpart or the computed diff — so red/green is impossible. The API that
would fix it, **`customEditorDiffs`**, is still proposed on `main` (checked
2026-09, VS Code 1.138) and has grown to four entry points —
`resolveCustomTextEditor{Inline,SideBySide}Diff` plus the two
`CustomReadonlyEditorProvider` equivalents. It is hard-gated:
`extHostCustomEditors.ts` computes `supportsInlineDiff` / `supportsSideBySideDiff`
through `isProposedApiEnabled(extension, 'customEditorDiffs')`, which is false for
anything off the Marketplace. Opting into the diff slot **without** the proposal
falls back to two independent MDForge webviews side by side (`customEditors.ts`,
`createDiffEditorInput`), each holding only its own version — no red/green, no
synced scroll. Not worth shipping; hence `diffEditor: "explicit"`.

**Watch**: microsoft/vscode#333400 (finalization asked 2026-08-30, no milestone,
no answer yet) and #315174 (*Enable using the markdown preview in the diff view*,
On Deck). When it lands, implement `resolveCustomTextEditorInlineDiff` (+ the
side-by-side variant) and flip `diffEditor` to `option`. What already graduated —
per-kind `priority`, #292379, VS Code 1.133 — is what let MDForge become the
default editor (§3); do not confuse the two.

Interim, and shipped: the diff editor's title bar carries two buttons
(`mdforge.openDiffOriginal` / `openDiffModified`) to open either side in MDForge
as a normal editor, and the **quick-diff margin** (§4) covers the single-file
case with stable API. Full audit in repo memory (`mdforge-vscode-diff-audit`).

## 10. Publishing

VS Code Marketplace: `tribaud` publisher, Azure DevOps PAT with **Marketplace >
Manage**, then `vsce package` / `vsce publish`. Optionally mirror to Open VSX.
It's free.
