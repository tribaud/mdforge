# MDForge

> Transform VS Code into a **Typora-like WYSIWYG Markdown editor** with
> **GitHub-style rendering**, **Mermaid diagrams** and **rich task lists**.

MDForge opens `.md` / `.markdown` files in a clean visual editor where the
Markdown renders in place as you type. It is built on
[Milkdown](https://github.com/Milkdown/milkdown) (ProseMirror + remark) and is
fully **open source (MIT)** — no paid tiers, no telemetry.

## Status

🚧 **Early scaffold (v0.0.1).** The foundation is in place; features are being
built against [`SPEC.md`](./SPEC.md).

Working now:

- Custom editor for `.md` / `.markdown` (opt-in) with two-way sync to the file.
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

Then press `F5` in VS Code to launch an Extension Development Host, open a
Markdown file, right-click it and choose **Open with MDForge** (or run the
command **MDForge: Open with MDForge**, or press `Ctrl/Cmd+Shift+Alt+M`).

Watch mode during development:

```sh
npm run watch:ext      # extension TypeScript
npm run watch:webview  # webview bundle
```

## Architecture

| Part | Path | Role |
| --- | --- | --- |
| Extension host | `src/extension.ts` | `CustomTextEditorProvider`, webview wiring, file ↔ webview sync |
| Webview app | `media-src/src/main.ts` | Milkdown editor + plugins |
| Theme | `media-src/src/github-theme.css` | GitHub-style CSS, VS Code theme-aware |
| Build | `esbuild.mjs` | Bundles the webview to `media/dist/` |

## Acknowledgements

- [Milkdown](https://github.com/Milkdown/milkdown) — WYSIWYG engine (MIT)
- [Mermaid](https://github.com/mermaid-js/mermaid) — diagrams (MIT)
- [KaTeX](https://github.com/KaTeX/KaTeX) — math (MIT)

## License

[MIT](./LICENSE) © 2026 tribaud
