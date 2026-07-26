# Changelog

All notable changes to MDForge are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

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
