# Changelog

All notable changes to MDForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.6.0]

### Added

- **Resizable table columns**: drag the border between two header cells and the
  two columns share the space; drag the table's own right edge and the whole table
  gets narrower or wider, shares untouched. Releasing the button writes the widths
  into the Markdown as an HTML comment on the line above the table —
  `<!--[10,60,15,15]-->`, one integer percentage per column. Every other Markdown
  renderer ignores a comment, so the file stays portable; MDForge reads it back
  and renders the table at those widths.
  The percentages are of the **text width**, not of each other: their sum is the
  table's own width. `[10,60,15,15]` fills the column, `[10,20,15]` is a table 45%
  wide. Nothing is normalized behind your back, and a first drag writes down the
  widths already on screen rather than resizing anything.
- **Tables span the text width by default**: a three-cell table hugging the left
  margin read as a mistake. Drag the right edge to bring one back in, which is
  exactly the case a total below 100 records.
- The widths comment is hidden in the editor (its line shown as a hairline) and
  revealed, like any other syntax, when the caret lands on it. It travels with its
  table when the block is dragged, is rewritten when a column is added or removed,
  and is deleted with the table.
- **Mermaid diagrams take the whole text column** instead of their natural size,
  which left a small diagram lost in the middle of the page. The scale-up keeps the
  aspect ratio and stops where the diagram would be taller than 80% of the frame,
  so a tall narrow flowchart is left at its natural size rather than turned into a
  page-long strip — and is never made smaller than it was. Set
  `mdforge.mermaid.fitWidth` to `false` to keep every diagram at its natural size.
- **Content width toggle in the toolbar**: a new button switches between the
  centred readable column and the full window width. It writes
  `mdforge.pageWidth` — the setting that already existed but had no shortcut — so
  the choice sticks across notes and reopens, and every open MDForge editor
  follows.

- **Two more Mermaid themes**, on top of mermaid's own four: `blue` (a light, cool
  blue — pale fills, soft steel-blue outlines, deep navy text) and `contrast`
  (white fills, **thick black** outlines, near-black **bold** labels — the one that
  survives a projector, a printout or a screenshot pasted into a document). Both
  come with a dark palette of their own, `blue-dark` and `contrast-dark`, worth
  choosing on a dark editor: a title or a date drawn on the page rather than inside
  a box would otherwise be navy on near-black. A named theme is otherwise used
  **as-is** — only `auto` follows the editor — and a diagram's own `classDef` keeps
  the last word over all of them.
  Pie slices get an explicit ramp of tints per theme: derived from a monochrome
  palette they came out as three indistinguishable near-white wedges.
- **Quick diff in the margin**: the lines you added, changed or removed since the
  last commit are marked in MDForge's own left margin — green for an addition,
  blue for a change, a red wedge where something was cut. It follows the **live**
  text, so an unsaved edit shows up immediately, and it updates on its own when
  you commit, stage or switch branch. The comparison base is the staged version
  of the file, falling back to `HEAD` — the same one VS Code's own gutter uses.
  Switch it off with `mdforge.quickDiff`. A file outside a repository, or one git
  has never seen, simply shows nothing.

### Changed

- **MDForge is now the default editor for `.md` / `.markdown`** — opening a note
  opens MDForge, no more "Open with". **Git comparisons are unaffected**: a diff
  still opens in VS Code's native diff editor, red/green intact. This was the one
  thing that kept MDForge opt-in, and VS Code 1.133 lifted it by letting an editor
  state its priority per editor kind (`textEditor` / `diffEditor`) instead of one
  value governing both. The code icon in the title bar, or
  `Ctrl/Cmd+Shift+Alt+M`, still opens any note in the plain text editor, and
  `workbench.editorAssociations` puts it back as the default for good.
  **If you already have an association for `*.md`, it wins and nothing changes
  for you** — a user setting always overrides what an extension declares. That
  entry is easy to have acquired without meaning to: VS Code writes it whenever
  you pick "Reopen Editor With… → Configure default editor". Look for
  `"workbench.editorAssociations": { "*.md": "default" }` in your settings and
  drop it, or point it at `"mdforge.editor"`.
- **Requires VS Code 1.133 or later** (was 1.90). The per-kind priority above does
  not exist before it, and on an older VS Code MDForge would take over the diff
  editor as well — which is exactly what it must not do.

### Fixed

- **A Mermaid diagram wider than 300px was drawn at 300px.** Mermaid emits
  `width="100%"` on the `<svg>` and no height; against a shrink-to-fit container
  that percentage has nothing to resolve against, and the browser fell back to the
  300px default of a replaced element — which is why diagrams looked small even
  with room to spare. Their width is now computed and written explicitly.
- **`mdforge.mermaid.theme: auto` follows the editor, not the operating system.**
  In a webview `prefers-color-scheme` reports the OS, so a light VS Code theme on a
  dark macOS (or the reverse) drew dark diagrams on a white page. VS Code's own
  theme kind is used now.
- **The toolbar no longer loses its last buttons in a narrow editor**: the full row
  needs ~1030px, and below that the presentation and settings buttons were clipped
  off with nothing to scroll. It wraps onto a second row instead.

## [0.5.0]

### Added

- **Table cells render their content**: images (`![](…)` and `![[embed]]`),
  inline Markdown (bold, italic, code, strike, links, wikilinks, footnote refs,
  `$math$`) and **raw HTML** (`<b>`, `<span style>`, `<br>`, `<img>`, `<code>`…).
  HTML goes through an allow-list — unknown tags keep their content, `script` /
  `style` / `iframe` are dropped, and `on*` handlers, script URLs and `url()` in a
  style never survive. Nesting works (`**[lien](url)**`), and `\|` is finally
  treated as an escaped pipe rather than a cell boundary.
- **Edit one cell without opening the whole table**: hover a cell → `✎` (or
  double-click it). The table stays rendered, the cell is highlighted, and its raw
  Markdown opens in a field **above the table** — where the full source appears
  when you edit the table itself. `Entrée` / `✓` validates, `Échap` / `✕` cancels,
  `Tab` / `Maj+Tab` moves to the next / previous cell. Writing it back is a text
  edit on that one cell's range. The block's `✎ Éditer` still opens the full
  source, with the structural toolbar.
- **Clicking the `⠿` block handle selects the block** (a heading takes its whole
  section), so a style can be applied to it straight away — the selection bubble
  appears on it. Dragging still moves the block.
- **Folding moved next to the block handle**: a `▾` / `▸` chevron in the left
  margin, on the row of the block it folds. The fold gutter's arrows were too
  discreet to find, so they are gone. The chevrons are large enough to read, and a
  **collapsed section keeps its `▸` shown at all times** (in the link colour),
  clickable to unfold — without it, the only trace of a fold was a gap in the line
  numbers.
- **Edit one frontmatter property from its chip**: click it and the value opens in
  a field just below the card, the chip highlighted — a text input for a scalar,
  and for `tags` / `keywords` / `categories` / `aliases` a chip editor (one
  pastille per value with its `×`, `Entrée` or `,` to add, `Retour arrière` to drop
  the last). The card's `✎` still opens the whole raw YAML, and a structured YAML
  value (nested map, `|` block) says so and hands you the source rather than
  half-parsing it. The original style is preserved: a `[a, b]` list stays flow, an
  indented `- item` list stays a block.
- **Add a property in one click**: a `+` at the end of the chips row opens a
  combobox listing the keys worth having in a PKM / Obsidian vault, each with what
  it is for — `created` / `updated` / `due` (pre-filled with today's date),
  `title`, `description`, `tags`, `aliases`, `type`, `status`, `project`, `up`
  (parent note / MOC), `related`, `source`, `author`, `cssclasses`, `publish`,
  `permalink` — then the keys **this workspace already uses**, and any name can
  simply be typed. Keys already present are never offered twice; the new line is
  appended to the YAML and its editor opens straight away, so the value can be
  typed without a second click.
- **Tag completion from the workspace's own tags.** The first time a tag editor
  opens, the host sweeps the folder's Markdown frontmatter once (`**/*.{md,markdown}`,
  `node_modules`/`.git`/`dist`/`out` excluded, only the first 4 KB of each file
  decoded, 3000 files max) and caches the result in the workspace state — so
  reopening VS Code is instant. The editor shows what the list is worth
  ("142 tags connus · 128 fichiers · 01/09 16:48") and a `↻` re-sweeps with a
  progress notification. No watcher and no database: the only automatic upkeep is
  merging a document's own tags when it is saved. The same sweep also collects the
  frontmatter **key names** (it already parses the block), which is what feeds the
  "already used in the folder" half of the add-a-property list.
- **Fold a whole outline level**: on a heading, a double chevron left of the
  normal one folds *every* heading of that same level — “Replier tous les titres
  H2 (3)” — leaving the other levels as they are. Once the level is fully folded
  the chevron flips up and unfolds it again. Shown on headings only; folding a
  level never touches the file.
- **Source line numbers** in the gutter, on by default and switchable with
  `mdforge.lineNumbers`. Compacted blank lines get no number (it would be clipped
  mid-glyph); source view numbers every line.
- **Justified text** now actually works: `mdforge.textAlign: justify` was declared
  but never applied in the editor. Headings, code blocks and metadata stay left.
- **`mdforge.format.paragraphs: oneLine`** — reformatting (the toolbar ¶ button,
  the *Normalize blank lines* command, format-on-save) also puts each paragraph
  back on a single line. This is what makes justification visible: it never
  stretches the last line of a block, and every *source* line is a block, so a
  hard-wrapped paragraph can never be justified. Code, tables, quotes, headings,
  frontmatter, block math and deliberate hard breaks (two trailing spaces, `\`,
  `<br>`) are left untouched; a wrapped list item is joined onto its marker.

### Changed

- **Reformatting joins paragraphs by default** (`mdforge.format.paragraphs` is now
  `oneLine`): the ¶ button collapsing blank lines but leaving prose hard-wrapped
  was surprising, and justification needs the unwrap to show at all.
- **`mdforge.format.blankLines` → `mdforge.format.onSave`** (a checkbox). The old
  name read like *which rules apply*, when it only ever answered *automatically on
  save, or on demand?* — the ¶ button always reformats regardless. The old setting
  is still honoured, but **blank lines only**: it promised that and nothing else,
  so nobody who opted into tidying blank lines on save discovers their prose
  unwrapped. Set `format.onSave` to get the full reformat. The command is now
  titled **MDForge: Reformat document (blank lines, paragraphs)**.
- **Instant tooltips on the left-margin controls**, and the ¶ button's tooltip now
  says what reformatting actually does. The margin controls use the same bubble as
  the toolbar, anchored so it cannot fall off the window's left edge.

### Fixed

- **Reformatting no longer mangles three legal Markdown constructs** (found in
  review, with the paragraph unwrap now on by default): a GFM table written
  *without* border pipes (`Nom | Âge`) was collapsed into one prose line — tables
  are now detected by their delimiter row, as GFM specifies; a setext underline
  (`=====`) and a link reference definition (`[ref]: url`) both swallowed the
  paragraph that followed them — "may absorb the next line" is now derived from
  "opens a block", with list items as the single exception.
- **A tag inside inline code stays text in a table cell**: `` `<br>` `` rendered a
  real line break and `` `<div>` `` rendered nothing. Code spans are now pulled out
  before the HTML parser sees the cell.
- **`tags : a, b`** (a space before the colon, legal YAML) no longer loses its
  colon when the property is edited from its chip.
- Typing in a note no longer persists every prefix of a tag (`p`, `pr`, `pro`…)
  into the workspace tag index — only saving contributes to it.
- Smaller ones from the same review: a dead "Replier les 0 titres" chevron on the
  second hover of a level with nothing to fold; the double chevron left stranded
  when its block scrolled out of view; a `RangeError` when selecting a block whose
  snapshot outlived a shrinking document; and a table cell editor that could
  reopen against a document the host had swapped underneath it.

- **Editing a table cell no longer blanks the editor.** Leaving the cell field
  could fire its `blur` from *inside* a CodeMirror DOM update (CM re-syncs the
  focus while updating), and writing the cell there threw *"Calls to
  EditorView.update are not allowed while an update is in progress"* — which the
  global handler reported as a failure to initialize, wiping the editor. The
  commit now always leaves the update first, and a blur caused by CM re-creating
  the field (rather than by the user) puts the focus back instead of closing it.
- **The left-margin controls follow the text when scrolling.** The `⠿` handle and
  the fold chevrons are placed against the editor frame, which does not scroll, so
  they stayed pinned to the screen while their block moved away. They are now
  re-placed on scroll, and hidden (or clamped, for a block starting above the
  frame) instead of being painted over the toolbar.
- **The `/` menu's keyboard navigation works again**: ↑/↓/Enter/Tab/Esc are bound
  through a `Prec.highest` keymap instead of a DOM capture listener, so they beat
  CodeMirror's own cursor bindings reliably (and fall through untouched when the
  menu is closed).
- **The margin controls no longer land inside a leading widget.** On a `> [!NOTE]`
  the fold chevron and the `⠿` handle appeared *in* the alert-type dropdown: their
  x came from `coordsAtPos`, which sits to the right of a widget at the start of
  the line. They are now measured on the `.cm-line` element, so every block —
  alert, task, plain paragraph — gets them at the same place in the margin.
- **A runtime error after startup no longer replaces the editor** with the
  *"failed to initialize"* screen: once the editor is up, errors are reported to
  the host and logged, and the editor keeps working.

## [0.4.3]

### Added

- **Fenced code block button** in the toolbar — inserts a ` ``` ` block (wrapping
  the selection when there is one) and **toggles**: with the caret already inside
  a block it unwraps it, keeping the code and re-selecting it so a second click
  wraps it again.
- **Insert a standard frontmatter block** from the toolbar (a *properties* button)
  or the `/frontmatter` slash command: `title` / `tags` / `author` / `date`, with
  `title` prefilled from the document's first `# H1` — which is then removed
  (markdownlint MD025 flags a frontmatter title next to an H1, and the card
  already renders the title).
- **Enlarge a Mermaid diagram** — a `⤢` button opens the diagram in a centered
  popup with mouse-wheel / `+` `−` zoom and drag-to-pan (the SVG stays vector-crisp
  at any zoom).
- **Refresh a Mermaid diagram** — a `↻` button re-renders a single diagram, for
  the rare transient render error (it stays visible while a diagram is in error).
- A little more breathing room **above headings**.

### Changed

- **Mermaid diagrams re-render when the theme changes** (`mdforge.mermaid.theme`,
  or the VS Code theme in `auto`) — they no longer keep their previous colours.
- **Code-block language picker** is now a custom filtered, scrollable dropdown
  (the native `<datalist>` arrow stole focus and could not be sized): type to
  filter, wheel/click or ↑/↓+Enter to pick. It offers `mermaid` (turning the block
  into a diagram) and every language **alias** — so `bash`, `zsh`, `sh`, … are
  listed, not just `Shell`.

### Fixed

- **The frontmatter card no longer disappears** after editing it and clicking
  *✓ Terminer*: the closing `---` fence parsed as a thematic break and drew a
  block rule that overlapped — and, on a rebuild, replaced — the card.
- **Mermaid no longer errors with “Cannot read properties of null (reading
  'firstChild')”**: concurrent renders clobbered each other's temporary node.
  Renders are now serialized, with one automatic retry before showing an error.
- **The code-block button can no longer crash the editor** with an *invalid change
  range*: right after unwrapping, the position-mapped (not-yet-reparsed) syntax
  tree could report an inverted node range. The block boundaries are now read from
  the current text instead.
- A failing toolbar action is caught and logged instead of tearing down the whole
  editor (the fatal “failed to initialize” screen).

## [0.4.2]

### Fixed

- **Code blocks paste readably from dev blogs** — the WordPress *SyntaxHighlighter*
  widget renders code as a `<table>` (a line-number gutter column plus one
  `<code>` span per token), which pasted as a garbled Markdown table. Such blocks
  are now converted to a fenced code block tagged with the brush language (e.g.
  ` ```csharp `), with indentation preserved and the line numbers dropped.

## [0.4.1]

### Changed

- **Slimmer package** — only KaTeX's `woff2` fonts are bundled now. Its CSS lists
  `woff2`/`woff`/`ttf` per glyph family and VS Code's Chromium webview always uses
  `woff2`, so the `woff`/`ttf` fallbacks (~40 files, ~0.9 MB) were dead weight and
  are dropped at build time. The webview keeps its lazy code-splitting (Mermaid,
  KaTeX and language grammars load on demand), which is best for startup latency.
- CI and publish workflows run on **Node 24** — `actions/checkout` and
  `actions/setup-node` bumped to v5 (they no longer target the deprecated Node 20).

## [0.4.0]

### Changed

- **Paste from OneNote / Word** now keeps the content: rich HTML on the clipboard
  is converted to Markdown instead of dropping the flat screenshot bitmap those
  apps copy alongside it. A plain image copy (a lone image, no text) still saves
  the bitmap.

### Added

- **OneNote section titles become headings** — OneNote has no heading element and
  styles a title as a fully-bold (or `semibold`) paragraph, which pasted as body
  text; such paragraphs are now promoted to Markdown `#`/`##` headings (by font
  size) so sections stand out and read correctly.
- **Embedded images are localized on paste** — images inside the pasted HTML
  (`data:` URIs and remote/`file:` URLs) are downloaded into the note's assets
  folder (`Note-<hash>.png`) and the links rewritten, so the note keeps working
  after the original OneNote/CDN URLs stop resolving behind Office auth.
- **Clipboard debug button** (`🐛`) in the toolbar — dumps the full pasted
  clipboard (every type: `text/html`, `text/plain`, `text/rtf`, files…) to a tab,
  to inspect how an app encodes its content.

### Fixed

- **Nested numbered lists from OneNote/Word** no longer flatten into an unreadable
  single sequence: OneNote emits sub-lists as siblings of the list items (invalid
  HTML), which are now re-parented so `1. 2. 3.` levels indent correctly.
- **Numbered lists no longer restart at 1** when OneNote splits one list into
  chunks (a paragraph or image between two steps): the resumption's `<li value=N>`
  is carried onto the list as `start`, so the sequence keeps counting.
- **A step's image indents under the step** — OneNote lifts an illustrating image
  out of the list as a sibling paragraph, which broke the numbering and left the
  image flush-left; it is now pulled back into the step it follows.
- **Sub-steps keep their nesting across images** — OneNote drops each list
  resumption after an image back to the top level, flattening deep steps; the tree
  is now rebuilt from the resumption's `<li value=N>` and the images' `margin-left`
  depth, so a multi-level numbered list survives the round-trip intact.

## [0.3.1]

### Changed

- New extension icon.

### Fixed

- The Marketplace listing now includes the 0.3.0 changelog (it was missing from
  the 0.3.0 package).

## [0.3.0]

### Changed

- **New editor engine: CodeMirror 6 live preview**, replacing Milkdown/
  ProseMirror. The document **is** the Markdown text — there is no
  parse→serialize round-trip, so editing never reformats the source: a
  one-character change is a one-character diff and identifiers stay grep-able.
- Lighter package: dropping Milkdown, ProseMirror and Shiki shrank the `.vsix`
  from ~4.5 MB to ~2.5 MB.

### Added

- **Live-preview rendering** via CodeMirror decorations: headings, bold/italic/
  strikethrough/inline-code, links, images, three-state task checkboxes
  (`[ ]`/`[x]`/`[~]`, on bullet **and** numbered lists), Mermaid diagrams, KaTeX
  math, GFM tables (with inline-rendered cells), GitHub alerts, wikilinks,
  footnotes and a YAML frontmatter card (`title` → H1).
- **Editing chrome**: a flat SVG-icon toolbar + selection bubble, slash menu,
  table toolbar, a draggable block handle (a heading drags its whole section)
  and a code-block language picker.
- **Search** (`Ctrl/Cmd+F`) and **heading/code folding**.
- **markdownlint diagnostics** shown inline (wavy underline) with a hover
  explanation, a rule-documentation link and a **quick-fix** action.
- **Footnote insert** popup — choose the target section (Notes / Bibliographie /
  existing), with an auto-numbered, editable bookmark.
- **Blank-line normalization** — on demand (command + toolbar) or opt-in on save
  (`mdforge.format.blankLines`): collapses duplicate blanks and surrounds
  headings and code blocks with a blank line (markdownlint MD012/MD022/MD031/
  MD047).
- **Source view**, **read-only lock**, **presentation mode** (with a floating
  exit button), and a toolbar button to reopen the note in the plain text editor.

### Fixed

- The 0.2.x round-trip limitations are **gone by construction** (no
  re-serialization): nested inline marks are never reordered or split, `_`/`~`
  inside identifiers are never escaped, and bullets, thematic breaks and tight
  lists are never restyled. Opening a file and saving it unchanged leaves a
  **byte-identical** file.

### Removed

- The Milkdown engine and its dependencies (Milkdown, ProseMirror, Shiki,
  remark) and the interim `mdforge.engine` setting.

## [0.2.6]

### Changed

- **Serialization fidelity** — a small edit now produces a small diff instead of
  rewriting the whole file. The Markdown is serialized close to common GFM
  conventions: `-` bullets, `---` thematic breaks (`ruleRepetition: 3`,
  `ruleSpaces: false`), `*` emphasis/strong, one-space list-item indent.

### Fixed

- **No more spurious escaping** of identifiers: `zfs_backup`, `APP_DATA`,
  `~830 G`, `a_b_c` stay grep-able (were `zfs\_backup`, `\~830 G`…). Only
  provably-safe escapes are stripped (intra-word `_`, a lone `\~`).
- The `[~]` in-progress task marker is no longer written as `\[~]`.

### Known limitations

- Nested inline marks can still be reordered/split on round-trip (e.g.
  `~~**A** b~~`) — that happens in Milkdown's ProseMirror→mdast step, not the
  Markdown serializer, and is tracked separately. Tight lists may still widen to
  loose (Milkdown parser `spread`).

## [0.2.4]

### Added

- **One-click switch** between the text editor and MDForge, in the editor's
  title bar: *Open with MDForge* (book icon) on a Markdown text editor, and
  *Reopen with Text Editor* (code icon) while in MDForge.

### Changed

- MDForge stays an **opt-in** editor (`priority: "option"`). A custom editor
  can't render inside VS Code's diff editor, so keeping the native text editor
  as the default is what lets **all git comparisons** (commits, files, "Compare
  Selected", Source Control) work as the usual red/green text diff. Open MDForge
  on the file you want to edit visually via the title-bar button or
  `Ctrl/Cmd+Shift+Alt+M`; do **not** map `"*.md"` to `mdforge.editor` in
  `workbench.editorAssociations` (that breaks diffs).

### Fixed

- The relative scroll position is preserved when toggling between the source and
  preview views (it no longer jumps to the top).

## [0.2.2]

### Added

- **Table toolbar** — a floating toolbar appears when the caret is in a table:
  insert/delete rows and columns, set the column alignment, and delete the
  table. Insert a table from the top toolbar or the slash menu.
- **Delete note** — a top-toolbar button removes the note and its co-located
  assets after a confirmation that lists what will be trashed versus kept
  (assets also used by another note are kept). Everything goes to the OS trash.
- **Source address on web paste** — with `mdforge.paste.appendSource`, pasting
  from a web page appends a `> <label> :` blockquote with the source URL on its
  own line.

### Changed

- Bullet and task lists now serialize with `-` (was `*`).

### Fixed

- Column alignment is now actually rendered (cell text follows the column
  alignment instead of being pinned left by the global paragraph rule).
- Typed/trailing spaces are preserved instead of being collapsed.

## [0.2.0]

### Added

- **Web math paste** — MathJax/KaTeX formulas copied from a web page paste as
  real `$...$` / `$$...$$` math (recovered by converting the pasted MathML to
  LaTeX) instead of plain text.
- **Source view** — toolbar toggle between the WYSIWYG editor and editable raw
  Markdown.
- **Move note** — move a note and its co-located assets to another workspace
  folder (warns if an asset is shared by another note).
- **Refresh images** — a toolbar button and a file-system watcher reload
  rendered images when a co-located asset changes on disk.
- **Re-hash on change** — when an image's content changes, its `<hash>` name is
  updated and the link rewritten (`mdforge.images.renameOnChange`).
- **Code block button** in the selection toolbar.
- **Format popup** from the top toolbar (formatting controls for the selection).
- **Paragraph alignment** setting (`mdforge.textAlign`: left / justify),
  viewer-only.
- Debug helper `mdforge.debug.pasteHtml` to inspect pasted clipboard HTML.

### Fixed

- Typing now works immediately in a brand-new empty note.

## [0.1.2]

### Added

- **Source view** — a toolbar button toggles between the WYSIWYG editor and an
  editable raw-Markdown view; leaving it commits the edits back.
- **Move note** — a toolbar button moves the note and its co-located assets to a
  picked workspace folder (relative links are preserved), refusing with a
  warning if an asset is shared by another note.
- **Refresh images** — a toolbar button plus a file-system watcher reload
  rendered images when a co-located asset changes on disk.

### Fixed

- Renaming a note now refreshes the editor in place instead of showing stale
  links (broken images) until the file was reopened.
- Images no longer serialize a redundant `title` that just mirrors the `alt`.

## [0.1.1]

### Added

- Extension icon.

## [0.1.0]

### Added

- **Image insertion** — paste from the clipboard, drag & drop (from Finder or
  the VS Code Explorer), or a toolbar/`/image` dialog to browse a file or type a
  path/URL with alt text. Images are saved next to the note following a
  configurable convention (folder + `NoteName-<hash>` naming + content dedup).
- **Image editing** — hover an image for a pencil button to edit its path and
  alt text; local images render through a webview URI while the Markdown keeps
  the relative path.
- **Top toolbar** — persistent document actions: insert image, localize assets,
  rename note, presentation mode, and settings.
- **Localize assets** — download every remote (`http(s):`) or embedded (`data:`)
  image into the assets folder and rewrite the links.
- **Rename note** — native input with a one-click PascalCase-With-Dashes
  suggestion (≤60 chars); co-located assets are renamed to match.
- **Heading folding** — a hover chevron folds a heading's section in place
  (decoration-based, the Markdown is untouched).
- **Mermaid theme setting** — `mdforge.mermaid.theme` (auto / default / dark /
  neutral / forest); changing it re-renders diagrams in place.
- **Gap cursor** — place the caret and type after a trailing code block, table
  or diagram at the end of the document.

### Changed

- Plain blockquotes share the alert box geometry (padding, rounded corners,
  subtle gray fill) so the type dropdown sits inside the block.

### Fixed

- Pasting an image no longer inlines it as a base64 `data:` URI; it is saved as
  a file instead.
