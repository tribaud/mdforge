# Changelog

All notable changes to MDForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

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
