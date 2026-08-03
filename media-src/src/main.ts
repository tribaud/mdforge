/*
 * MDForge — CodeMirror 6 "Live Preview" experiment (branch: experiment/codemirror).
 *
 * This is an alternative editor engine to the Milkdown/ProseMirror build on
 * `main`. The document here IS the Markdown text (CodeMirror is a text editor),
 * so editing never re-serializes: a one-character change is a one-character
 * diff, and identifiers stay grep-able. Rendering is done inline via decorations
 * (see cm-livepreview.ts), Obsidian-style.
 *
 * It speaks the same host protocol as the Milkdown build (`ready`/`edit` out,
 * `setContent`/`config` in), so src/extension.ts is unchanged.
 */
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { livePreview, setAssetsBase, setMermaidTheme } from './cm-livepreview'
import { createTopbar, createBubble } from './cm-toolbar'
import './cm-theme.css'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

interface MdForgeConfig {
  fontSize?: number
  pageWidth?: 'comfortable' | 'full'
  assetsBaseUri?: string
  mermaidTheme?: string
}

const vscode = acquireVsCodeApi()
const root = document.getElementById('app') as HTMLElement

/** Turn a blank page into a visible, reportable error. */
function showError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const pre = document.createElement('pre')
  pre.style.cssText =
    'white-space:pre-wrap;word-break:break-word;color:#f14c4c;padding:16px;font:12px/1.5 monospace'
  pre.textContent = `MDForge (CodeMirror) failed to initialize:\n\n${detail}`
  root.replaceChildren(pre)
  vscode.postMessage({ type: 'error', text: detail })
}
window.addEventListener('error', (event) => showError(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => showError(event.reason))

/** Last markdown we are in sync with. Guards echo loops with the host. */
let currentText = ''
/** True while applying a host change, so we don't post it straight back. */
let applyingRemote = false

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--vscode-editor-foreground)',
    backgroundColor: 'transparent'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mdforge-font)',
    lineHeight: '1.7',
    overflow: 'auto'
  },
  '.cm-content': {
    maxWidth: '900px',
    margin: '0 auto',
    padding: '24px 48px 40vh',
    fontSize: 'var(--mdforge-font-size, 15px)',
    caretColor: 'var(--vscode-editorCursor-foreground)'
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--vscode-editor-selectionBackground)'
  }
})

let bubbleUpdate: () => void = () => {}

let view!: EditorView
try {
  view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        markdown({ extensions: GFM }),
        syntaxHighlighting(defaultHighlightStyle),
        livePreview,
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet || update.focusChanged) bubbleUpdate()
          if (applyingRemote || !update.docChanged) return
          const text = update.state.doc.toString()
          if (text === currentText) return
          currentText = text
          vscode.postMessage({ type: 'edit', text })
        })
      ]
    })
  })

  // Formatting toolbar: a persistent top bar + a selection bubble.
  document.body.insertBefore(createTopbar(view), root)
  const bubble = createBubble(view)
  bubbleUpdate = bubble.update
} catch (error) {
  showError(error)
  throw error
}

function setContent(text: string): void {
  if (text === currentText) return
  applyingRemote = true
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  currentText = text
  applyingRemote = false
}

function applyConfig(config: MdForgeConfig): void {
  if (typeof config.fontSize === 'number') {
    document.documentElement.style.setProperty('--mdforge-font-size', `${config.fontSize}px`)
  }
  document.body.classList.toggle('mdforge-width-full', config.pageWidth === 'full')
  if (config.assetsBaseUri) setAssetsBase(config.assetsBaseUri)
  if (config.mermaidTheme) setMermaidTheme(config.mermaidTheme)
}

window.addEventListener('message', (event) => {
  const msg = event.data as { type: string; text?: string; config?: MdForgeConfig }
  switch (msg.type) {
    case 'setContent':
      if (typeof msg.text === 'string') setContent(msg.text)
      break
    case 'config':
      if (msg.config) applyConfig(msg.config)
      break
    // Other host messages (imageInserted, refreshImages, revealHeading,
    // togglePresentation) are not wired in this experiment yet.
  }
})

vscode.postMessage({ type: 'ready' })
