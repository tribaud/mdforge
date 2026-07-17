# MDForge — project guide for Claude

MDForge is a VS Code extension that turns the editor into a **Typora-like
WYSIWYG Markdown editor** with **GitHub-style rendering**. It is built on
**Milkdown** (ProseMirror + remark) and is **MIT-licensed** — no paid tiers,
no telemetry. The Markdown file always stays the source of truth.

This file is the shared memory of the project: architecture, how each feature
works, the Milkdown gotchas we learned the hard way, and the working
conventions. Read it fully before making changes.

---

## 1. Tech stack

- **Extension host** (Node/VS Code API): `src/extension.ts`.
- **Webview app** (browser): `media-src/src/*.ts`, bundled by esbuild to
  `media/dist/`.
- **Editor engine**: Milkdown 7 (`@milkdown/core`, `preset-commonmark`,
  `preset-gfm`) = ProseMirror + remark. Milkdown is **headless**: it gives the
  schema/parsing but almost no UI — we build the UI (toolbar, menus, node
  views, decorations).
- **Plugins used**: `plugin-listener` (markdown out), `plugin-history`,
  `plugin-clipboard`, `plugin-math` (KaTeX), `plugin-diagram` (Mermaid),
  `plugin-slash` (slash menu), `plugin-tooltip` (selection toolbar),
  `plugin-block` (drag handle).
- **Rendering libs**: `shiki` (code highlighting, GitHub themes, JS engine),
  `prosemirror-highlight` (decoration bridge for shiki), `mermaid`, `katex`,
  `remark-frontmatter`.

## 2. Repository layout

| Path | Role |
| --- | --- |
| `src/extension.ts` | Custom text editor, webview wiring, file↔webview sync, CSP, **outline** tree, **presentation** command + status bar, **wikilink** open resolver. |
| `media-src/src/main.ts` | Webview entry: assembles the Milkdown editor, message handling, error surfacing. |
| `media-src/src/inprogress-task.ts` | Task checkboxes with the custom `[~]` in-progress state. |
| `media-src/src/views.ts` | Node views: Mermaid diagram, code-block language field, block/inline math (click-to-edit). |
| `media-src/src/mermaid-highlight.ts` | Heuristic Mermaid tokenizer for the diagram source editor. |
| `media-src/src/shiki-highlight.ts` | Shiki code highlighting (non-blocking). |
| `media-src/src/slash.ts` | `/` slash command menu. |
| `media-src/src/toolbar.ts` | Selection toolbar (bubble menu), shortcuts in tooltips. |
| `media-src/src/github-alerts.ts` | GitHub alerts + per-blockquote type dropdown. |
| `media-src/src/footnotes.ts` | Footnote reference → definition jump. |
| `media-src/src/frontmatter.ts` | YAML frontmatter node + discreet editor + `title`→H1. |
| `media-src/src/block.ts` | Draggable block handle. |
| `media-src/src/wikilinks.ts` | `[[wikilink]]` decoration + click-to-open. |
| `media-src/src/github-theme.css` | All styling, VS Code light/dark aware. |
| `esbuild.mjs` | Bundles the webview (ESM + code splitting) to `media/dist/`. |
| `SPEC.md` | Feature roadmap and status (P0/P1/P2). |

## 3. How it fits together

- The extension registers a `CustomTextEditorProvider` for `*.md`/`*.markdown`.
  For each document it creates a webview whose HTML loads `media/dist/main.js`
  under a strict CSP (nonce + `webview.cspSource`, plus `wasm-unsafe-eval`,
  `worker-src blob:`, `connect-src` for Mermaid/Shiki).
- **Sync**: host → webview posts `setContent` on external changes; webview →
  host posts `edit` with the new Markdown (whole-document replace via
  `WorkspaceEdit`). A `syncedText` guard avoids echo loops.
- **External changes recreate the editor** (`setContent` destroys + rebuilds
  the Milkdown editor). Milkdown has no cheap "set whole value"; external edits
  are rare so a cursor reset is acceptable.
- Messages: `ready`, `setContent`, `config`, `edit`, `error`, `revealHeading`,
  `togglePresentation`, `openWikilink`.

## 4. How each feature works (and why)

- **Task `[~]` state** (`inprogress-task.ts`): extends the GFM task list item
  schema with an `inProgress` attr. remark-gfm only knows `[ ]`/`[x]`, so `[~]`
  is left as text — we detect a leading `[~] ` marker on parse (strip it, set
  the attr) and re-inject it on serialize. A clickable checkbox cycles
  unchecked → in-progress → checked (in-progress gated by the
  `mdforge.checkbox.enableInProgress` setting).
- **Mermaid & math** (`views.ts`): the diagram/math plugins are headless — they
  define the node but render only the source. We add `$view` node views that
  render the SVG/KaTeX and offer click-to-edit. Mermaid is `mermaid.initialize`d
  once with the current VS Code theme. The Mermaid source editor is a
  highlighted overlay (see `mermaid-highlight.ts`): a transparent `<textarea>`
  over a synced highlighted `<pre>`.
- **Code highlighting** (`shiki-highlight.ts`): Shiki + `github-light`/
  `github-dark`, via `prosemirror-highlight` (decoration-based, so it coexists
  with the code-block language field). Loading is **non-blocking**: the plugin
  is added synchronously and the parser returns a promise while grammars load,
  so the editor paints immediately.
- **Slash menu** (`slash.ts`) & **toolbar** (`toolbar.ts`): built on
  `plugin-slash` / `plugin-tooltip` providers (floating-ui). We build the menu
  DOM, filtering, keyboard nav, and run Milkdown commands. Mark/block toggles
  use the commands' runtime `.run()`; quote and bullet-list buttons **toggle**
  (they `lift` out when already applied). Keyboard shortcuts are Milkdown's
  built-in keymaps — shown in the toolbar tooltips.
- **GitHub alerts** (`github-alerts.ts`): decoration-based (no doc change →
  round-trips). Every blockquote gets a type dropdown (empty by default);
  picking a type inserts/replaces `[!TYPE]`, empty removes it. When set, the
  `[!TYPE]` marker text is hidden (an inline decoration) since the dropdown
  shows the type.
- **Footnotes** (`footnotes.ts`): GFM already renders them; we add
  click-reference-→-definition scrolling and styling.
- **Frontmatter** (`frontmatter.ts`): registers `remark-frontmatter` (with the
  `['yaml']` preset) + a node rendered as a discreet bar that expands to a YAML
  editor; the `title:` field is shown as an H1.
- **Outline** (`src/extension.ts`): parses ATX headings (ignoring fenced code),
  builds a **collapsible tree** by level; clicking posts `revealHeading` to
  scroll the webview. Shown in the Explorer when `mdforge.active`.
- **Presentation mode**: `mdforge.togglePresentation` (command + status bar +
  `Ctrl/Cmd+Shift+Alt+P`) posts to the webview, which flips a body class and
  the `editable` prop (read-only + hides editing chrome).
- **Wikilinks** (`wikilinks.ts`): decoration over `[[target]]`/`[[target|alias]]`;
  click posts `openWikilink`; the host resolves it relative to the file (adds
  `.md`/`.markdown`) and opens it.
- **Draggable blocks** (`block.ts`): `plugin-block` drag handle.

## 5. Milkdown gotchas we learned (read before debugging)

- **Custom node commands**: `$command` exports (e.g. `wrapInHeadingCommand`)
  expose a runtime `.run(payload)` once the editor is loaded — call that from UI
  code. There is no stable `.key` at import time.
- **Node view content hole**: the ProseMirror content hole (`0`) must be the
  ONLY child of its parent DOM node. Wrap extra chrome (checkbox, toolbar) as
  siblings of a content wrapper, not siblings of the hole. (Symptom: `Content
  hole must be the only child of its parent node` → blank editor.)
- **`$remark` options**: Milkdown defaults a remark plugin's options to `{}`.
  Pass real options as `$remark(id, () => plugin, options)` — e.g.
  remark-frontmatter needs `['yaml']`, else it throws
  `Missing \`type\` in matter \`{}\``.
- **Headless = no UI**: `plugin-diagram`, `plugin-math`, `plugin-slash`,
  `plugin-tooltip`, `plugin-block` render nothing on their own; you must supply
  node views / providers.
- **Providers** (`SlashProvider`, `TooltipProvider`, `BlockProvider`): they
  append their `content` element themselves and toggle `data-show="true|false"`
  — style visibility off that attribute; don't append the element yourself.
- **Async highlighting**: `prosemirror-highlight` parsers may return a
  `Promise<void>` to signal "not ready yet"; the plugin re-highlights when it
  resolves — use this instead of blocking editor creation.
- **Decoration-based features round-trip for free**: alerts, wikilinks, code
  highlighting change no document nodes, so the Markdown is untouched. Prefer
  decorations when you only need to change appearance/behavior.
- **Editor is recreated on external `setContent`** — anything stateful in the
  webview (e.g. `presentation`) must live in module scope and be re-applied in
  `createEditor`.

## 6. Build, run, verify

```sh
npm install
npm run build                 # tsc (extension) + esbuild (webview) → media/dist
npx tsc -p media-src --noEmit # webview type-check (also in CI)
```

- Press **F5** (the launch config runs `install` then `build`) to open an
  Extension Development Host, then right-click a `.md` → **Open with MDForge**
  (or `Ctrl/Cmd+Shift+Alt+M`).
- `examples/demo.md` exercises every feature.
- Webview init errors are surfaced on-screen (and logged to the host as
  `[MDForge webview]`) — turn a blank page into a readable stack.
- Run `npm install` after any pull that changes `package.json`.

## 7. Testing note

Visual/interactive behavior (WYSIWYG, drag, click handlers) must be verified in
a running Extension Development Host — a green build only proves it compiles and
bundles. When working from an environment without a GUI, drive validation via
F5 locally (or a local Claude Code instance) and report screenshots / the
on-screen error text.

## 8. Merge workflow (required)

Branch granularity is flexible (one feature, several features, or parallel
branches). The one rule that keeps history clean: **rebase the branch's commits
onto the latest `main` right before merging**.

1. `git fetch origin && git rebase origin/main` — so the branch sits directly
   on top of `main` and no lines cross.
2. **Code review** the branch diff (`/code-review`) and address findings.
3. **Merge `--no-ff`** (a real merge commit) once the review is clean and the
   work is verified via F5. Never fast-forward.

Result: a linear `main` spine where each branch hangs off as one clean merge
bubble. Do NOT create merge commits by merging successive points of a single
shared linear chain — that tangles the graph. `main` stays releasable.

## 9. Conventions & known limitations

- Non-standard checkbox states are an MDForge convention: `[ ]`/`[x]` are GFM;
  `[~]` (in progress) is ours.
- Alerts currently write `[!TYPE]` inline with the first line; MDForge renders
  them, but for strict GitHub parity the marker ideally sits on its own line.
- Wikilink `[[ ]]` brackets stay visible while editing (not yet hidden).
- Shiki bundles many grammars → `media/dist` is large; trim the language list
  in `shiki-highlight.ts` if the `.vsix` gets too heavy.
- Toolbar can flicker as the selection changes (provider show/hide).

## 10. Publishing (later)

VS Code Marketplace: create a `tribaud` publisher at
<https://marketplace.visualstudio.com/manage>, make an Azure DevOps PAT with
**Marketplace > Manage**, then `vsce package` / `vsce publish`. Optionally
mirror to Open VSX. It's free.
