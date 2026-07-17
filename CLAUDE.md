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

Branch granularity is flexible: one feature per branch, several features in one
branch, or several branches in parallel — all fine. The one rule that keeps the
history clean is to **rebase the branch's commits onto the latest `main` right
before merging**.

Before merging a branch into `main`:

1. **Rebase onto the latest `main`** (`git fetch origin && git rebase
   origin/main`) so the branch's commits sit directly on top of `main` and no
   lines cross.
2. **Run a code review of the branch diff** (the `code-review` skill /
   `/code-review`) and address the findings.
3. **Merge with `--no-ff`** (a real merge commit) once the review is clean and
   the work has been verified in the Extension Development Host (F5). Never
   fast-forward: the merge commit groups the branch's commits together.

The result is a linear `main` spine where each branch hangs off as one clean
merge bubble. (Do NOT create merge commits by merging successive points of a
single shared linear chain — that is what tangles the graph.)

Feature work happens on branches; `main` stays releasable.
