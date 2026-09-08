# MDForge

> Transform VS Code into a **Typora-like WYSIWYG Markdown editor** with
> **GitHub-style rendering**, **Mermaid diagrams** and **rich task lists**.

MDForge opens `.md` / `.markdown` files in a clean visual editor where the
Markdown renders in place as you type. It is built on
[CodeMirror 6](https://codemirror.net/) in an Obsidian-style "live preview": the
document **is** the Markdown text, so editing never re-serializes — a one-character
change is a one-character diff. Fully **open source (MIT)** — no paid tiers, no
telemetry.

## Status

🚧 **Early scaffold (v0.0.1).** The foundation is in place; features are being
built against [`SPEC.md`](./SPEC.md).

Working now:

- Custom editor for `.md` / `.markdown`, two-way synced with the file. It is the
  **default** editor for Markdown; the code icon in the title bar (or
  `Ctrl/Cmd+Shift+Alt+M`) opens the plain text editor instead, and
  `workbench.editorAssociations` makes that choice permanent. **Git comparisons
  keep opening in VS Code's native diff editor**, red/green intact.
- **Quick diff**: the lines added, changed or removed since the last commit are
  marked in the left margin, live as you type (`mdforge.quickDiff`).
- **Workspace-search results land on the match**: clicking a result in the
  Search view goes to it and highlights the searched term everywhere in the
  note (`F8` / `Shift+F8` walk the occurrences). VS Code hands a custom editor
  neither the position it was aiming at nor the query
  ([vscode#289785](https://github.com/microsoft/vscode/issues/289785)), so
  MDForge recovers both from the Search view itself
  (`mdforge.revealSearchMatch`).
- WYSIWYG editing: headings, bold/italic/strikethrough, quotes, lists, links,
  images, code blocks, GFM tables.
- **Clickable task lists** (`- [ ]` / `- [x]`).
- **Mermaid** diagrams and **KaTeX** math.
- **GitHub-style theme** that follows the VS Code light/dark theme.

Planned (see `SPEC.md`): custom `[~]` "in progress" checkbox state, slash
commands, GitHub alerts, outline panel, wikilinks, and more.

## Development

```sh
npm install
npm run build      # compiles the extension (tsc) + bundles the webview (esbuild)
```

Then press `F5` in VS Code to launch an Extension Development Host and open a
Markdown file — MDForge is the default editor for those. To go back to the plain
text editor, use the code icon in the title bar, the command **MDForge: Reopen
with Text Editor**, or `Ctrl/Cmd+Shift+Alt+M`.

Watch mode during development:

```sh
npm run watch:ext      # extension TypeScript
npm run watch:webview  # webview bundle
```

## Architecture

| Part | Path | Role |
| --- | --- | --- |
| Extension host | `src/extension.ts` | `CustomTextEditorProvider`, webview wiring, file ↔ webview sync |
| Quick diff | `src/quickdiff.ts` + `src/linediff.ts` | Reads the committed text through the built-in Git extension and diffs it against the live one |
| Search reveal | `src/searchreveal.ts` + `src/searchmatches.ts` | Recovers the match positions VS Code drops when a search result opens a custom editor |
| Webview app | `media-src/src/main.ts` + `cm-*.ts` | CodeMirror 6 live-preview editor |
| Theme | `media-src/src/cm-theme.css` | GitHub-style CSS, VS Code theme-aware |
| Build | `esbuild.mjs` | Bundles the webview to `media/dist/` |

## Acknowledgements

- [CodeMirror 6](https://codemirror.net/) — editor engine (MIT)
- [Mermaid](https://github.com/mermaid-js/mermaid) — diagrams (MIT)
- [KaTeX](https://github.com/KaTeX/KaTeX) — math (MIT)

## License

[MIT](./LICENSE) © 2026 tribaud
