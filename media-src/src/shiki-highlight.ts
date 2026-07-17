/*
 * MDForge — syntax highlighting with Shiki (GitHub themes).
 *
 * Replaces the Prism highlighter with Shiki using the official
 * `github-light` / `github-dark` themes, for VS Code-quality colors.
 * Highlighting is decoration-based (via prosemirror-highlight), so it
 * coexists with the editable code-block language view and touches nothing
 * in the document model.
 *
 * The JavaScript regex engine is used instead of the WASM engine so the
 * bundle stays self-contained and needs no .wasm loading in the webview.
 */
import { createHighlighter, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { createParser } from 'prosemirror-highlight/shiki'
import { createHighlightPlugin } from 'prosemirror-highlight'
import { $prose } from '@milkdown/utils'

const LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'jsonc', 'html', 'css',
  'scss', 'less', 'python', 'bash', 'shellscript', 'yaml', 'toml', 'markdown',
  'go', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'php', 'ruby', 'swift',
  'sql', 'graphql', 'diff', 'dockerfile', 'xml', 'ini'
]

let highlighterPromise: Promise<Highlighter> | null = null

/** Create (once) a Shiki highlighter with both GitHub themes. */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: LANGS,
      engine: createJavaScriptRegexEngine()
    })
  }
  return highlighterPromise
}

/** Build the Milkdown plugin that highlights code blocks with Shiki. */
export function createShikiPlugin(highlighter: Highlighter) {
  const dark = document.body.classList.contains('vscode-dark')
  const theme = dark ? 'github-dark' : 'github-light'
  const loaded = new Set(highlighter.getLoadedLanguages())
  const parser = createParser(highlighter, { theme })

  const plugin = createHighlightPlugin({
    parser,
    nodeTypes: ['code_block'],
    languageExtractor: (node: any) => {
      const lang = String(node.attrs.language ?? '').toLowerCase().trim()
      return lang && loaded.has(lang) ? lang : 'text'
    }
  })

  return $prose(() => plugin)
}
