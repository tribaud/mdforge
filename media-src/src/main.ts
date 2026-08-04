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
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown, markdownKeymap } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { GFM } from '@lezer/markdown'
import { livePreview, setAssetsBase, setMermaidTheme, setWikilinkHandler, openWikilink } from './cm-livepreview'
import { createTopbar, createBubble } from './cm-toolbar'
import './cm-theme.css'
import 'katex/dist/katex.min.css'

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

// Wikilink clicks in the rendered text ask the host to open the target note.
setWikilinkHandler((target) => vscode.postMessage({ type: 'openWikilink', target }))

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

/** Editability is toggled for presentation mode (read-only preview). */
const editable = new Compartment()

let bubbleUpdate: () => void = () => {}

/* ---------- list indent / outdent on Tab ---------- */
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])(\s)/

/** Indent every list line the selection touches by two spaces. Returns false
 * when no list line is involved, so Tab falls through to its default. */
function indentList(view: EditorView): boolean {
  const { state } = view
  const changes: Array<{ from: number; insert: string }> = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      if (LIST_LINE.test(line.text)) changes.push({ from: line.from, insert: '  ' })
    }
  }
  if (!changes.length) return false
  view.dispatch({ changes })
  return true
}

/** Outdent every list line the selection touches by up to two spaces. */
function outdentList(view: EditorView): boolean {
  const { state } = view
  const changes: Array<{ from: number; to: number }> = []
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n)
      if (!LIST_LINE.test(line.text)) continue
      const spaces = /^ {1,2}/.exec(line.text)
      if (spaces) changes.push({ from: line.from, to: line.from + spaces[0].length })
    }
  }
  if (!changes.length) return false
  view.dispatch({ changes })
  return true
}

/* ---------- image paste / drop → host save → insert link ---------- */
let imageSeq = 0
/** id → document position where the inserted link should land. */
const pendingImages = new Map<number, number>()

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function sendImageFile(file: File, pos: number): void {
  const id = ++imageSeq
  pendingImages.set(id, pos)
  void readFileAsBase64(file).then((data) =>
    vscode.postMessage({ type: 'insertImage', id, data, mime: file.type, name: file.name })
  )
}

const domEvents = EditorView.domEventHandlers({
  paste: (event, view) => {
    const items = event.clipboardData?.files
    if (!items || items.length === 0) return false
    const image = Array.from(items).find((f) => f.type.startsWith('image/'))
    if (!image) return false
    event.preventDefault()
    sendImageFile(image, view.state.selection.main.head)
    return true
  },
  drop: (event, view) => {
    const dt = event.dataTransfer
    if (!dt) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
    const image = dt.files && Array.from(dt.files).find((f) => f.type.startsWith('image/'))
    if (image) {
      event.preventDefault()
      sendImageFile(image, pos)
      return true
    }
    const uriList = dt.getData('text/uri-list')
    if (uriList) {
      const first = uriList.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
      if (first && /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(first)) {
        event.preventDefault()
        const id = ++imageSeq
        pendingImages.set(id, pos)
        vscode.postMessage({ type: 'importImagePath', id, path: first })
        return true
      }
    }
    return false
  }
})

let view!: EditorView
try {
  view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        keymap.of([
          // Tab indents lists; Enter continues list/quote markup; Backspace
          // removes an empty marker — all before the generic bindings so they win.
          { key: 'Tab', run: indentList },
          { key: 'Shift-Tab', run: outdentList },
          ...markdownKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        markdown({ extensions: GFM, codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle),
        livePreview,
        editorTheme,
        domEvents,
        editable.of(EditorView.editable.of(true)),
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

  // Clicks on rendered wikilinks / footnote refs.
  view.dom.addEventListener('click', (event) => {
    const el = (event.target as HTMLElement)?.closest?.('[data-wikilink],[data-footnote]') as HTMLElement | null
    if (!el) return
    const wl = el.getAttribute('data-wikilink')
    if (wl) {
      event.preventDefault()
      openWikilink(wl)
      return
    }
    const fn = el.getAttribute('data-footnote')
    if (fn && !el.classList.contains('cm-md-footnote-def')) {
      event.preventDefault()
      jumpToFootnote(fn)
    }
  })

  // Formatting toolbar: a persistent top bar + a selection bubble.
  document.body.insertBefore(createTopbar(view), root)
  const bubble = createBubble(view)
  bubbleUpdate = bubble.update
} catch (error) {
  showError(error)
  throw error
}

/** Scroll to a footnote definition line (`[^id]:`). */
function jumpToFootnote(id: string): void {
  const re = new RegExp(`^\\[\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:`)
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n)
    if (re.test(line.text)) {
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
      return
    }
  }
}

/** Scroll to the Nth ATX heading (host outline click). Fenced code is skipped
 * so the count matches the host's outline parser. */
function revealHeading(index: number): void {
  let seen = 0
  let inFence = false
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n)
    if (/^\s*(```|~~~)/.test(line.text)) {
      inFence = !inFence
      continue
    }
    if (!inFence && /^#{1,6}\s/.test(line.text)) {
      if (seen === index) {
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })
        return
      }
      seen++
    }
  }
}

let presentation = false
function togglePresentation(): void {
  presentation = !presentation
  document.body.classList.toggle('mdforge-presentation', presentation)
  view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!presentation)) })
}

/** Bust the browser cache for rendered <img> so a changed asset repaints. */
function refreshImages(): void {
  const stamp = `mdforge=${Date.now()}`
  view.dom.querySelectorAll('img.cm-inline-image').forEach((node) => {
    const img = node as HTMLImageElement
    const base = img.src.split('#')[0].replace(/([?&])mdforge=\d+/, '$1').replace(/[?&]$/, '')
    img.src = base + (base.includes('?') ? '&' : '?') + stamp
  })
}

function insertImageLink(id: number, src: string, alt: string, linkStyle: string): void {
  const pos = pendingImages.get(id)
  pendingImages.delete(id)
  if (pos === undefined) return
  const md = linkStyle === 'wikilink-embed' ? `![[${src}]]` : `![${alt}](${src})`
  applyingRemote = false
  view.dispatch({ changes: { from: pos, insert: md }, selection: { anchor: pos + md.length } })
  view.focus()
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
  const msg = event.data as {
    type: string
    text?: string
    config?: MdForgeConfig
    index?: number
    id?: number
    src?: string
    alt?: string
    linkStyle?: string
    error?: string
  }
  switch (msg.type) {
    case 'setContent':
      if (typeof msg.text === 'string') setContent(msg.text)
      break
    case 'config':
      if (msg.config) applyConfig(msg.config)
      break
    case 'revealHeading':
      if (typeof msg.index === 'number') revealHeading(msg.index)
      break
    case 'togglePresentation':
      togglePresentation()
      break
    case 'refreshImages':
      refreshImages()
      break
    case 'imageInserted':
      if (typeof msg.id === 'number') {
        if (msg.error) pendingImages.delete(msg.id)
        else if (msg.src) insertImageLink(msg.id, msg.src, msg.alt ?? '', msg.linkStyle ?? 'markdown')
      }
      break
  }
})

vscode.postMessage({ type: 'ready' })
