# Changelog

All notable changes to MDForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
