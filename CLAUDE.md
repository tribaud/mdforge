# MDForge — working notes for Claude

MDForge is a VS Code extension that turns the editor into a Typora-like WYSIWYG
Markdown editor with GitHub-style rendering. It is built on Milkdown
(ProseMirror + remark) and is MIT-licensed.

## Layout

- `src/extension.ts` — extension host: `CustomTextEditorProvider`, webview
  wiring, file <-> webview sync, CSP.
- `media-src/src/main.ts` — webview entry: assembles the Milkdown editor.
- `media-src/src/*.ts` — features (task states, node views, slash menu,
  GitHub alerts, Shiki highlighting, ...).
- `media-src/src/github-theme.css` — GitHub-style, VS Code theme-aware CSS.
- `esbuild.mjs` — bundles the webview to `media/dist/`.
- `SPEC.md` — prioritized feature roadmap (P0/P1/P2).

## Build & check

```sh
npm install
npm run build                 # tsc (extension) + esbuild (webview)
npx tsc -p media-src --noEmit # webview type-check (also run in CI)
```

Run any `npm install` after pulling a change that touches `package.json`.

## Merge workflow (required)

Each feature is a **short-lived branch created from the current `main` tip**
that contains **only that feature's commits**. This keeps every merge a small,
self-contained bubble. Do NOT merge points along one long shared linear
branch — that produces a tangled, crossing graph.

Before merging a feature branch into `main`:

1. **Rebase onto the latest `main`** so branches don't cross
   (`git fetch origin && git rebase origin/main`).
2. **Run a code review of the branch diff** (the `code-review` skill /
   `/code-review`) and address the findings.
3. **Merge with `--no-ff`** (a real merge commit) once the review is clean and
   the feature has been verified in the Extension Development Host (F5). Never
   fast-forward: the merge commit groups the feature's commits together.

The result should be a linear `main` spine where each feature hangs off as one
clean merge bubble.

Feature work happens on branches; `main` stays releasable.
