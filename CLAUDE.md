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
| `media-src/src/cm-livepreview.ts` | The **live-preview `StateField`**: builds all decorations (headings, marks, tasks, images, HR, mermaid/math/table widgets, alerts, wikilinks, footnotes, frontmatter card, code-block language picker, compact blank lines). |
| `media-src/src/cm-toolbar.ts` | Top toolbar + selection bubble; `wrap`/`insertLink`/`insertHr`/`insertTable`/`insertFootnote` (footnote popup with section + editable bookmark); search toggle. |
| `media-src/src/cm-slash.ts` | `/` slash command menu (`createSlashMenu(view).update`). |
| `media-src/src/cm-table.ts` | Floating table toolbar (add/del row & col, align, delete) — rewrites the table Markdown text directly. |
| `media-src/src/cm-block-drag.ts` | Draggable `⠿` block handle (reorders top-level blocks / heading sections). |
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
  `togglePresentation`, `refreshImages`, `imageInserted`, `diagnostics`.
  webview→host: `ready`, `edit`, `openWikilink`, `openExternal`, `insertImage`,
  `importImagePath`, `localizeAssets`, `renameNote`, `moveNote`, `deleteNote`,
  `openSettings`, `normalizeBlankLines`, `requestQuickFix`, `debugPasteHtml`,
  `error`.

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
  widget; `✎ Éditer` drops the caret into the source (which, via reveal-on-edit,
  shows the raw source with a live "Aperçu" preview + `✓ Terminer` to leave).
  Mermaid parse-error orphan nodes are swept from `document.body` after each
  render (`sweepMermaidOrphans`).
- **Code blocks**: fenced code is shown as styled source (highlighted via
  `codeLanguages`); a **language picker** (`LangWidget`, `<input list=datalist>`
  of `@codemirror/language-data` names + free text) floats top-right and rewrites
  the info string on change.
- **Tables** (`TableWidget` + `cm-table.ts`): rendered HTML table; cells render
  inline Markdown (`renderInline`). Caret inside → raw source + preview + a
  floating structural toolbar (add/del row & col, align, delete) that rewrites the
  table text.
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
- **HR / blank lines**: `---` → a compact rule widget. Blank source lines are
  shrunk to a **stable** small height (`cm-md-blank`) — never revealed on caret
  (see gotchas).
- **Draggable blocks** (`cm-block-drag.ts`): `⠿` on hover moves the top-level block
  (a heading drags its whole section) via a whole-line, whole-doc text edit.
- **Source view**: toolbar toggle reconfigures the `preview` compartment to `[]`,
  showing raw Markdown (syntax highlighting only) in a monospace column.
- **Search & folding**: `@codemirror/search` (`Cmd+F`, toolbar 🔍 toggles the
  panel) + `foldGutter`/`codeFolding` with a `foldService` that folds heading
  sections.
- **Linter diagnostics** (`@codemirror/lint`): the host forwards
  `vscode.languages.getDiagnostics(uri)` (markdownlint, spell checkers…) on
  `onDidChangeDiagnostics`; `main.ts` builds `Diagnostic[]` (wavy underline,
  hover bubble with message + rule-doc link + a **"Corrections rapides…"** action).
  The action posts `requestQuickFix` → host `runQuickFix` runs
  `executeCodeActionProvider` + a `showQuickPick` + applies the chosen edit/command
  (no webview lightbulb).
- **Blank-line normalization** (`normalizeBlankLines` in `extension.ts`,
  host-side, pure): MD012 collapse dupes / MD022 around headings / MD031 around
  fences / MD047 final newline; skips fence + frontmatter content. Runs **on
  demand** (command `mdforge.normalizeBlankLines` + toolbar `¶`) or **opt-in on
  save** (`mdforge.format.blankLines: onSave` via `onWillSaveTextDocument`, gated
  on `provider.isOpen`). **Never per-keystroke** — that would resurrect the diff
  noise the CM engine exists to avoid.
- **Paste** (`cm-paste-html.ts`): rich HTML → Markdown via turndown+GFM with
  escaping disabled; web math via `data-mathml` → `mathml-to-latex`; footnotes →
  `[^n]` with per-section renumber; optional `> source` footer (`appendSource`).
  Image on the clipboard / drop / the 🖼 picker → host saves it next to the note.
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
- **Open links on `mousedown` (capture), not click.** Ctrl/⌘-click first places
  the caret, which reveals the raw `[text](url)` and drops the `data-href` before
  a click lands — so intercept on mousedown.
- **`setDiagnostics` from `@codemirror/lint` auto-enables the lint extension**; we
  also add `lintGutter()`. Don't set the `Diagnostic.source` field if you already
  render the source in `renderMessage` (it double-prints).

## 6. Build, run, verify

```sh
npm install
npm run build                 # tsc (extension) + esbuild (webview) → media/dist
npx tsc -p media-src --noEmit # webview type-check (also in CI)
```

- Press **F5** to open an Extension Development Host, then right-click a `.md` →
  **Open with MDForge** (or `Ctrl/Cmd+Shift+Alt+M`).
- `examples/feat.md` exercises the CM features; `examples/demo.md` is the general
  demo.
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
- Blank-line normalization is **opt-in only** (command / format-on-save); the
  editor never rewrites the source on its own.
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
