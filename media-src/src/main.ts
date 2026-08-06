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
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  syntaxTree,
  foldGutter,
  codeFolding,
  foldKeymap,
  foldService
} from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { markdown, markdownKeymap, pasteURLAsLink } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { GFM } from '@lezer/markdown'
import {
  livePreview,
  setAssetsBase,
  setMermaidTheme,
  setWikilinkHandler,
  setEnableInProgress,
  openWikilink
} from './cm-livepreview'
import { createTopbar, createBubble, wrap, insertLink, insertTable } from './cm-toolbar'
import { createSlashMenu } from './cm-slash'
import { createTableToolbar } from './cm-table'
import { blockDrag } from './cm-block-drag'
import { setDiagnostics, lintGutter } from '@codemirror/lint'
import type { Diagnostic } from '@codemirror/lint'
import { htmlToMarkdown, isRichHtml } from './cm-paste-html'
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
  enableInProgress?: boolean
  appendSource?: boolean
  sourceLabel?: string
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
/** Wraps the live-preview extension so "source view" can switch it off, showing
 * the raw Markdown (only syntax highlighting remains). */
const preview = new Compartment()

let bubbleUpdate: () => void = () => {}
let slashUpdate: () => void = () => {}
let tableUpdate: () => void = () => {}

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

/** Fold a heading down to the end of its section (up to the next heading of the
 * same or higher level) — click the gutter arrow to collapse/expand. */
const markdownFold = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const m = /^(#{1,6})\s/.exec(line.text)
  if (!m) return null
  const level = m[1].length
  let end = line.to
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n)
    const hm = /^(#{1,6})\s/.exec(l.text)
    if (hm && hm[1].length <= level) break
    end = l.to
  }
  return end > line.to ? { from: line.to, to: end } : null
})

/** True when the caret sits inside a fenced or inline code span. */
function inCodeContext(view: EditorView): boolean {
  const tree = syntaxTree(view.state)
  for (
    let n: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(view.state.selection.main.head, 0);
    n;
    n = n.parent
  ) {
    if (n.name === 'FencedCode' || n.name === 'InlineCode' || n.name === 'CodeBlock') return true
  }
  return false
}

/* ---------- paste.appendSource: "À partir de l'adresse <url>" footer ---------- */
let appendSource = false
let sourceLabel = "À partir de l'adresse"

/** Best-effort source URL for a paste: the clipboard uri-list, or a bare URL in
 * the plain-text payload. */
function detectSourceUrl(cd: DataTransfer): string {
  const uri = (cd.getData('text/uri-list') || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith('#') && /^https?:\/\//i.test(s))
  if (uri) return uri
  const text = (cd.getData('text/plain') || '').trim()
  return /^https?:\/\/\S+$/i.test(text) ? text : ''
}

/** Append a `> label :` / `> url` blockquote below the caret's line and place
 * the caret on the URL (ready to fill in when none was detectable). */
function appendSourceLine(view: EditorView, url: string): void {
  const head = sourceLabel.replace(/\s*:\s*$/, '')
  const at = view.state.doc.lineAt(view.state.selection.main.head).to
  const block = `\n\n> ${head} :\n> ${url}`
  const caret = at + block.length - url.length
  view.dispatch({ changes: { from: at, insert: block }, selection: { anchor: caret, head: at + block.length } })
  view.focus()
}

const domEvents = EditorView.domEventHandlers({
  paste: (event, view) => {
    const cd = event.clipboardData
    if (!cd) return false
    // 1) An image on the clipboard → save it next to the note (existing flow).
    const image = cd.files && Array.from(cd.files).find((f) => f.type.startsWith('image/'))
    if (image) {
      event.preventDefault()
      sendImageFile(image, view.state.selection.main.head)
      return true
    }
    // 2) Rich HTML (web page, doc) → convert to Markdown. Skipped inside a code
    //    block, where the raw text should paste verbatim.
    const html = cd.getData('text/html')
    if (html && isRichHtml(html) && !inCodeContext(view)) {
      const md = htmlToMarkdown(html)
      if (md) {
        event.preventDefault()
        view.dispatch(view.state.replaceSelection(md))
        // Optional "From <url>" footer for external web content.
        if (appendSource) appendSourceLine(view, detectSourceUrl(cd))
        view.focus()
        return true
      }
    }
    return false
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

/** Open the OS file picker and insert the chosen image at the caret (reuses the
 * paste/drop save flow). */
function pickImage(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) sendImageFile(file, view.state.selection.main.head)
  })
  input.click()
}

/** Host-integration + document buttons appended to the top bar. Mirrors the
 * Milkdown top toolbar: a left group (note/asset actions) and a right group
 * (refresh, presentation, settings) separated by a flexible spacer. */
function addHostButtons(bar: HTMLElement): void {
  const sep = (): void => {
    const s = document.createElement('span')
    s.className = 'cm-tb-sep'
    bar.appendChild(s)
  }
  const mk = (label: string, title: string, onClick: () => void, danger = false): HTMLElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = danger ? 'cm-tb-btn cm-tb-danger' : 'cm-tb-btn'
    b.textContent = label
    b.title = title
    b.setAttribute('data-tip', title)
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', onClick)
    bar.appendChild(b)
    return b
  }
  const post = (type: string) => (): void => vscode.postMessage({ type })

  sep()
  mk('¶', 'Normaliser les lignes vides (markdownlint)', post('normalizeBlankLines'))
  mk('🖼', 'Insérer une image', pickImage)
  mk('⊞', 'Insérer un tableau', () => insertTable(view))
  mk('⬇', 'Télécharger les images distantes en local', post('localizeAssets'))
  mk('📁', 'Déplacer la note et ses assets', post('moveNote'))
  mk('✏️', 'Renommer la note', post('renameNote'))
  mk('🗑', 'Supprimer la note et ses assets', post('deleteNote'), true)

  const spacer = document.createElement('span')
  spacer.className = 'cm-tb-spacer'
  bar.appendChild(spacer)

  sourceButton = mk('🗎', 'Afficher la source Markdown', () => toggleSource())
  mk('↻', 'Rafraîchir les images', () => refreshImages())
  readOnlyButton = mk('🔓', "Lecture seule (bloquer l'édition)", () => toggleReadOnly())
  mk('▶', 'Mode présentation', () => togglePresentation())
  mk('⚙', 'Réglages MDForge', post('openSettings'))
}

/** Toggle the raw-Markdown source view (live preview off). */
let sourceMode = false
let sourceButton: HTMLElement | null = null
function toggleSource(): void {
  sourceMode = !sourceMode
  view.dispatch({ effects: preview.reconfigure(sourceMode ? [] : livePreview) })
  document.body.classList.toggle('mdforge-source-mode', sourceMode)
  sourceButton?.classList.toggle('cm-tb-btn-active', sourceMode)
  view.focus()
}

/** Read-only lock (keeps the chrome, blocks editing). Paired with presentation
 * via the shared `applyEditable()`. */
let readOnly = false
let readOnlyButton: HTMLElement | null = null
function toggleReadOnly(): void {
  readOnly = !readOnly
  document.body.classList.toggle('mdforge-readonly', readOnly)
  if (readOnlyButton) {
    readOnlyButton.textContent = readOnly ? '🔒' : '🔓' // closed when locked, open when editable
    readOnlyButton.classList.toggle('cm-tb-btn-active', readOnly)
  }
  applyEditable()
}

let view!: EditorView
try {
  view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        keymap.of([
          // Formatting shortcuts (toggle, same logic as the toolbar).
          { key: 'Mod-b', run: (v) => (wrap(v, '**'), true) },
          { key: 'Mod-i', run: (v) => (wrap(v, '*'), true) },
          { key: 'Mod-e', run: (v) => (wrap(v, '`'), true) },
          { key: 'Mod-k', run: (v) => (insertLink(v), true) },
          // Tab indents lists; Enter continues list/quote markup; Backspace
          // removes an empty marker — all before the generic bindings so they win.
          { key: 'Tab', run: indentList },
          { key: 'Shift-Tab', run: outdentList },
          ...markdownKeymap,
          ...searchKeymap,
          ...foldKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap
        ]),
        EditorView.lineWrapping,
        drawSelection(),
        highlightActiveLine(),
        markdown({ extensions: GFM, codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle),
        pasteURLAsLink,
        codeFolding(),
        foldGutter(),
        markdownFold,
        search({ top: true }),
        highlightSelectionMatches(),
        blockDrag,
        lintGutter(),
        preview.of(livePreview),
        editorTheme,
        domEvents,
        editable.of(EditorView.editable.of(true)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet || update.focusChanged) {
            bubbleUpdate()
            slashUpdate()
            tableUpdate()
          }
          if (applyingRemote || !update.docChanged) return
          const text = update.state.doc.toString()
          if (text === currentText) return
          currentText = text
          vscode.postMessage({ type: 'edit', text })
        })
      ]
    })
  })

  // Ctrl/⌘-click a rendered link → open it externally. Handled on *mousedown*
  // (capture) so it fires before CodeMirror moves the caret — which would turn
  // the link back into raw text and drop the `data-href` before a click lands.
  view.dom.addEventListener(
    'mousedown',
    (event) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const linkEl = (event.target as HTMLElement)?.closest?.('[data-href]') as HTMLElement | null
      const href = linkEl?.getAttribute('data-href')
      if (href) {
        event.preventDefault()
        event.stopPropagation()
        vscode.postMessage({ type: 'openExternal', url: href })
      }
    },
    true
  )

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
    if (fn) {
      event.preventDefault()
      // Reference → definition; definition → back to (first) reference.
      if (el.classList.contains('cm-md-footnote-def')) jumpToFootnoteRef(fn)
      else jumpToFootnote(fn)
    }
  })

  // Formatting toolbar: a persistent top bar + a selection bubble.
  const topbar = createTopbar(view)
  addHostButtons(topbar)
  document.body.insertBefore(topbar, root)
  const bubble = createBubble(view)
  bubbleUpdate = bubble.update
  slashUpdate = createSlashMenu(view).update
  tableUpdate = createTableToolbar(view).update

  // Presentation mode hides the toolbar, so its own toggle button vanishes — a
  // floating "exit" button (shown only in presentation) + Escape are the way out.
  const presentExit = document.createElement('button')
  presentExit.type = 'button'
  presentExit.className = 'cm-present-exit'
  presentExit.textContent = '✕ Quitter la présentation'
  presentExit.title = 'Quitter le mode présentation (Échap)'
  presentExit.addEventListener('click', () => togglePresentation())
  document.body.appendChild(presentExit)
  document.addEventListener('keydown', (event) => {
    if (presentation && event.key === 'Escape') {
      event.preventDefault()
      togglePresentation()
    }
  })
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

/** Scroll to the first reference of a footnote (`[^id]` not the `[^id]:` def). */
function jumpToFootnoteRef(id: string): void {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\[\\^${esc}\\](?!:)`)
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n)
    const m = re.exec(line.text)
    if (m) {
      view.dispatch({ selection: { anchor: line.from + m.index }, scrollIntoView: true })
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
/** Editor is editable unless presentation OR read-only is active. */
function applyEditable(): void {
  view.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!presentation && !readOnly)) })
}
function togglePresentation(): void {
  presentation = !presentation
  document.body.classList.toggle('mdforge-presentation', presentation)
  applyEditable()
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

/** Start of the body (first char after a leading `---` frontmatter block), or 0. */
function bodyStart(text: string): number {
  if (!text.startsWith('---\n')) return 0
  const end = text.indexOf('\n---', 3)
  if (end === -1) return 0
  const nl = text.indexOf('\n', end + 1)
  return nl === -1 ? text.length : nl + 1
}

/** VS Code DiagnosticSeverity (0..3) → CodeMirror lint severity. */
const SEVERITY: Record<number, Diagnostic['severity']> = { 0: 'error', 1: 'warning', 2: 'info', 3: 'hint' }

interface LineCol {
  line: number
  character: number
}
interface RawDiagnostic {
  from: LineCol
  to: LineCol
  severity: number
  message: string
  code?: string
  source?: string
  href?: string
}

/** Convert host diagnostics (line/character) to CodeMirror lint diagnostics.
 * A zero-width range (line-level markdownlint rules) underlines the whole line.
 * Each carries a hover message with a rule-doc link and a "quick fix" action
 * that asks the host to run VS Code's code-action provider for the range. */
function applyDiagnostics(raw: RawDiagnostic[]): void {
  const doc = view.state.doc
  const off = (p: LineCol): number => {
    const line = doc.line(Math.max(1, Math.min(p.line + 1, doc.lines)))
    return Math.max(line.from, Math.min(line.from + p.character, line.to))
  }
  const items: Diagnostic[] = raw.map((d) => {
    let from = off(d.from)
    let to = off(d.to)
    if (to <= from) {
      const line = doc.lineAt(from)
      from = line.from
      to = line.to
    }
    const source = [d.source, d.code].filter(Boolean).join(' ')
    return {
      from,
      to,
      severity: SEVERITY[d.severity] ?? 'warning',
      message: d.message,
      renderMessage: () => {
        const box = document.createElement('div')
        box.className = 'cm-lint-msg'
        const text = document.createElement('div')
        text.textContent = d.message
        box.appendChild(text)
        if (source || d.href) {
          const foot = document.createElement('div')
          foot.className = 'cm-lint-msg-foot'
          if (source) {
            const tag = document.createElement('span')
            tag.textContent = source
            foot.appendChild(tag)
          }
          if (d.href) {
            const link = document.createElement('a')
            link.className = 'cm-lint-msg-link'
            link.textContent = 'Documentation ↗'
            link.addEventListener('mousedown', (e) => {
              e.preventDefault()
              vscode.postMessage({ type: 'openExternal', url: d.href })
            })
            foot.appendChild(link)
          }
          box.appendChild(foot)
        }
        return box
      },
      actions: [
        {
          name: 'Corrections rapides…',
          apply: (v, aFrom, aTo) => {
            const a = v.state.doc.lineAt(aFrom)
            const b = v.state.doc.lineAt(aTo)
            vscode.postMessage({
              type: 'requestQuickFix',
              range: {
                from: { line: a.number - 1, character: aFrom - a.from },
                to: { line: b.number - 1, character: aTo - b.from }
              }
            })
          }
        }
      ]
    }
  })
  view.dispatch(setDiagnostics(view.state, items))
}

function setContent(text: string): void {
  if (text === currentText) return
  applyingRemote = true
  // On the first load, drop the caret past any frontmatter so it renders as its
  // collapsed card (a caret at 0 sits inside the block and reveals the raw YAML).
  const anchor = currentText === '' ? bodyStart(text) : undefined
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    ...(anchor ? { selection: { anchor } } : {})
  })
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
  if (typeof config.enableInProgress === 'boolean') setEnableInProgress(config.enableInProgress)
  if (typeof config.appendSource === 'boolean') appendSource = config.appendSource
  if (typeof config.sourceLabel === 'string' && config.sourceLabel) sourceLabel = config.sourceLabel
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
    items?: RawDiagnostic[]
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
    case 'diagnostics':
      if (Array.isArray(msg.items)) applyDiagnostics(msg.items)
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
