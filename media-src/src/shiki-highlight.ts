/*
 * MDForge — syntax highlighting with Shiki (GitHub themes).
 *
 * Uses Shiki with the official `github-light` / `github-dark` themes for
 * VS Code-quality colors, via prosemirror-highlight (decoration-based, so it
 * coexists with the editable code-block language view and touches nothing in
 * the document model).
 *
 * Loading is non-blocking: the plugin is added synchronously so the editor
 * appears immediately, and the parser returns a promise while Shiki loads —
 * prosemirror-highlight re-highlights each code block once it resolves. The
 * JavaScript regex engine avoids shipping/loading WASM in the webview.
 */
import { createHighlighter, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { createParser } from 'prosemirror-highlight/shiki'
import { createHighlightPlugin, type Parser } from 'prosemirror-highlight'
import { $prose } from '@milkdown/utils'

const LANGS = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json', 'jsonc', 'html', 'css',
  'scss', 'less', 'python', 'bash', 'shellscript', 'yaml', 'toml', 'markdown',
  'go', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'php', 'ruby', 'swift',
  'sql', 'graphql', 'diff', 'dockerfile', 'xml', 'ini'
]

let highlighterPromise: Promise<Highlighter> | null = null
let loadedLangs = new Set<string>()

/** Create (once) a Shiki highlighter with both GitHub themes. */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: LANGS,
      engine: createJavaScriptRegexEngine()
    }).then((highlighter) => {
      loadedLangs = new Set(highlighter.getLoadedLanguages())
      return highlighter
    })
  }
  return highlighterPromise
}

// Start loading grammars as soon as the module is imported (in parallel with
// the webview boot), so highlighting is usually ready by first paint.
void getHighlighter()

/** Milkdown plugin that highlights code blocks with Shiki, without blocking. */
export const shikiHighlight = $prose(() => {
  const dark = document.body.classList.contains('vscode-dark')
  const theme = dark ? 'github-dark' : 'github-light'
  let ready: Parser | null = null

  const parser: Parser = (options) => {
    if (ready) return ready(options)
    // Not ready yet: resolve when the highlighter loads so the plugin retries.
    return getHighlighter().then((highlighter) => {
      ready = createParser(highlighter, { theme })
    })
  }

  return createHighlightPlugin({
    parser,
    nodeTypes: ['code_block'],
    languageExtractor: (node: any) => {
      const lang = String(node.attrs.language ?? '').toLowerCase().trim()
      return lang && loadedLangs.has(lang) ? lang : 'text'
    }
  })
})
