/*
 * MDForge (CodeMirror experiment) — Obsidian-style "Live Preview".
 *
 * The CodeMirror document IS the Markdown text: no semantic model, no
 * re-serialization, so an edit only changes the characters typed. "Rendering"
 * is done with decorations — syntax markers are hidden and content styled, and
 * the raw syntax is revealed whenever the selection enters a node.
 *
 * Covers: headings, bold/italic/code/strike, links, images, three-state task
 * checkboxes (incl. the MDForge `[~]` in-progress state), fenced code blocks
 * (with syntax highlighting), Mermaid diagrams, GFM tables, GitHub alerts,
 * wikilinks, YAML frontmatter, footnotes and KaTeX math ($…$ / $$…$$).
 */
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'

/* ---------- host bridge (wikilink navigation) ---------- */
let onWikilink: (target: string) => void = () => {}
export function setWikilinkHandler(fn: (target: string) => void): void {
  onWikilink = fn
}
/** Called by the DOM handler wired in main.ts. */
export function openWikilink(target: string): void {
  onWikilink(target)
}

/* ---------- config: MDForge `[~]` in-progress checkbox state ---------- */
// GFM only knows `[ ]`/`[x]`; `[~]` is an MDForge convention. When the setting
// `mdforge.checkbox.enableInProgress` is off, the click cycle skips `~`.
let enableInProgress = true
export function setEnableInProgress(on: boolean): void {
  enableInProgress = on
}

/* ---------- assets (images) ---------- */
let assetsBase = ''
export function setAssetsBase(uri: string): void {
  assetsBase = uri.replace(/\/$/, '')
}
function resolveSrc(src: string): string {
  if (/^(https?:|data:|blob:|vscode-webview:|vscode-resource:)/i.test(src)) return src
  return assetsBase ? `${assetsBase}/${src.replace(/^\.\//, '')}` : src
}

/* ---------- mermaid (lazy-loaded so it can never block editor startup) ---------- */
type MermaidTheme = 'default' | 'dark' | 'forest' | 'neutral'
let mermaidTheme: MermaidTheme = 'default'
function prefersDark(): boolean {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidMod: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidLoading: Promise<any> | null = null
async function getMermaid(): Promise<unknown> {
  if (mermaidMod) return mermaidMod
  if (!mermaidLoading) {
    mermaidLoading = import('mermaid').then((m) => {
      mermaidMod = m.default ?? m
      mermaidMod.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'loose' })
      return mermaidMod
    })
  }
  return mermaidLoading
}
export function setMermaidTheme(theme: string): void {
  mermaidTheme =
    theme === 'dark'
      ? 'dark'
      : theme === 'forest'
        ? 'forest'
        : theme === 'neutral'
          ? 'neutral'
          : theme === 'default'
            ? 'default'
            : prefersDark()
              ? 'dark'
              : 'default'
  if (mermaidMod) mermaidMod.initialize({ startOnLoad: false, theme: mermaidTheme, securityLevel: 'loose' })
}

let mermaidCounter = 0
/**
 * On a parse error, Mermaid injects a temporary/error element into
 * `document.body` and does not remove it. Because the preview re-renders on
 * every keystroke, these orphans pile up outside the editor (off-scroll,
 * covering the screen). Remove any Mermaid element not mounted in one of our
 * widgets after each render.
 */
function sweepMermaidOrphans(): void {
  document.querySelectorAll('[id^="mdforge-mermaid-"], [id^="dmdforge-mermaid-"]').forEach((n) => {
    if (!n.closest('.cm-mermaid')) n.remove()
  })
}
function renderMermaid(view: EditorView, el: HTMLElement, code: string): void {
  const id = `mdforge-mermaid-${mermaidCounter++}`
  getMermaid()
    .then((m) => (m as { render: (id: string, code: string) => Promise<{ svg: string }> }).render(id, code))
    .then(({ svg }) => {
      el.innerHTML = svg
      // The SVG changes the widget height after CodeMirror measured the layout;
      // re-measure so vertical click/caret mapping below stays accurate.
      view.requestMeasure()
    })
    .catch((error: unknown) => {
      el.classList.add('cm-mermaid-error')
      el.textContent = `Mermaid error: ${error instanceof Error ? error.message : String(error)}`
      view.requestMeasure()
    })
    .finally(sweepMermaidOrphans)
}

/* ---------- KaTeX (lazy-loaded, same reasoning as Mermaid) ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let katexMod: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let katexLoading: Promise<any> | null = null
async function getKatex(): Promise<unknown> {
  if (katexMod) return katexMod
  if (!katexLoading) {
    katexLoading = import('katex').then((m) => {
      katexMod = m.default ?? m
      return katexMod
    })
  }
  return katexLoading
}
function renderMath(view: EditorView, el: HTMLElement, code: string, display: boolean): void {
  getKatex()
    .then((k) => {
      ;(k as { render: (expr: string, el: HTMLElement, opts: object) => void }).render(code, el, {
        displayMode: display,
        throwOnError: false,
        output: 'html'
      })
      view.requestMeasure()
    })
    .catch((error: unknown) => {
      el.classList.add('cm-math-error')
      el.textContent = code
      view.requestMeasure()
      void error
    })
}

/** True when a selection range touches [from, to] — then we reveal raw syntax. */
function editing(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/* ---------- widgets ---------- */
type BlockMode = 'render' | 'preview'

/** Drop the caret into a block's source at `pos`, which — via the reveal-on-edit
 * rule — shows the editable source with a live preview underneath. */
function enterEdit(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  view.focus()
}

/**
 * Add an "✎ Éditer" affordance to a rendered block widget. Only the button
 * enters edit mode — clicking the rendered body leaves the caret alone (so the
 * diagram/table stays a stable, non-disruptive preview until you ask to edit).
 */
function addEditButton(host: HTMLElement, view: EditorView, pos: number): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-edit'
  btn.textContent = '✎ Éditer'
  btn.title = 'Éditer la source'
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    enterEdit(view, pos)
  })
  host.appendChild(btn)
}

/**
 * Add a "✓ Terminer" button to a block's edit-time preview panel that moves the
 * caret out of the block (to the line after it) — so the source collapses back
 * to the rendered view. Big blocks (mermaid/math) are otherwise hard to exit.
 */
function addCloseButton(host: HTMLElement, view: EditorView): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-close'
  btn.textContent = '✓ Terminer'
  btn.title = "Fermer l'éditeur (sortir du bloc)"
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const doc = view.state.doc
    const pos = Math.max(0, Math.min(view.posAtDOM(btn), doc.length))
    const after = Math.min(doc.length, doc.lineAt(pos).to + 1)
    view.dispatch({ selection: { anchor: after }, scrollIntoView: true })
    view.focus()
  })
  host.appendChild(btn)
}

type TaskState = ' ' | '~' | 'x'
const NEXT_STATE: Record<TaskState, TaskState> = { ' ': '~', '~': 'x', x: ' ' }
/** Next checkbox state on click. With the in-progress state disabled, cycle
 * unchecked ⇄ checked directly (a `~` already in the file still resolves to
 * checked, so the marker is never orphaned). */
function nextTaskState(s: TaskState): TaskState {
  if (enableInProgress) return NEXT_STATE[s]
  return s === 'x' ? ' ' : 'x'
}

class TaskWidget extends WidgetType {
  constructor(readonly state: TaskState) {
    super()
  }
  eq(other: TaskWidget): boolean {
    return other.state === this.state
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.state === 'x'
    box.indeterminate = this.state === '~'
    if (this.state === '~') box.classList.add('cm-task-inprogress')
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', (e) => {
      e.preventDefault()
      const line = view.state.doc.lineAt(view.posAtDOM(box))
      const m = /\[([ xX~])\]/.exec(line.text)
      if (!m) return
      const from = line.from + m.index
      const current = (m[1].toLowerCase() === 'x' ? 'x' : m[1]) as TaskState
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: nextTaskState(current) } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly pos: number,
    readonly mode: BlockMode
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.mode === this.mode
  }
  get estimatedHeight(): number {
    return 180
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = this.mode === 'preview' ? 'cm-image-wrap cm-block-preview' : 'cm-image-wrap'
    const img = document.createElement('img')
    img.src = resolveSrc(this.src)
    img.alt = this.alt
    // Hover shows the raw address (web vs local) without editing.
    img.title = this.alt ? `${this.alt} — ${this.src}` : this.src
    img.className = 'cm-inline-image'
    // Image loads async and changes height → re-measure so caret mapping holds.
    img.addEventListener('load', () => view.requestMeasure())
    wrap.appendChild(img)
    // Same affordance as mermaid/table: ✎ to edit the source (URL + caption),
    // ✓ Terminer to leave — the image stays visible the whole time.
    if (this.mode === 'render') addEditButton(wrap, view, this.pos)
    else addCloseButton(wrap, view)
    return wrap
  }
}

/** Compact horizontal rule — a block widget so the `---` source line collapses
 * to just the rule (no lingering empty-looking line) when the caret is away. */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-hr-widget'
    el.appendChild(document.createElement('hr'))
    return el
  }
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly pos: number,
    readonly mode: BlockMode
  ) {
    super()
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.mode === this.mode
  }
  get estimatedHeight(): number {
    return 200
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = this.mode === 'preview' ? 'cm-mermaid cm-block-preview' : 'cm-mermaid'
    const target = document.createElement('div')
    target.className = 'cm-mermaid-target'
    el.appendChild(target)
    renderMermaid(view, target, this.code)
    if (this.mode === 'render') addEditButton(el, view, this.pos)
    else addCloseButton(el, view)
    return el
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly display: boolean,
    readonly pos = -1,
    readonly mode: BlockMode = 'render'
  ) {
    super()
  }
  eq(other: MathWidget): boolean {
    return other.code === this.code && other.display === this.display && other.mode === this.mode
  }
  get estimatedHeight(): number {
    return this.display ? 44 : -1
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className =
      (this.display ? 'cm-math cm-math-block' : 'cm-math cm-math-inline') +
      (this.mode === 'preview' ? ' cm-block-preview' : '')
    if (this.display) {
      const target = document.createElement('div')
      el.appendChild(target)
      renderMath(view, target, this.code, true)
      if (this.mode === 'render' && this.pos >= 0) addEditButton(el, view, this.pos)
      else if (this.mode === 'preview') addCloseButton(el, view)
    } else {
      renderMath(view, el, this.code, false)
    }
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

/** Render the common inline Markdown (code, math, bold, italic, strike, link)
 * of a table cell into `container` — table cells are plain text otherwise. */
function renderInline(view: EditorView, container: HTMLElement, text: string): void {
  const RE = /(`[^`]+`)|(\$[^$\n]+?\$)|(\*\*[\s\S]+?\*\*)|(~~[\s\S]+?~~)|(\*[\s\S]+?\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = RE.exec(text))) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)))
    const tok = m[0]
    if (tok.startsWith('`')) {
      const c = document.createElement('code')
      c.className = 'cm-md-code'
      c.textContent = tok.slice(1, -1)
      container.appendChild(c)
    } else if (tok.startsWith('$')) {
      const s = document.createElement('span')
      renderMath(view, s, tok.slice(1, -1), false)
      container.appendChild(s)
    } else if (tok.startsWith('**')) {
      const b = document.createElement('strong')
      b.textContent = tok.slice(2, -2)
      container.appendChild(b)
    } else if (tok.startsWith('~~')) {
      const s = document.createElement('span')
      s.className = 'cm-md-strike'
      s.textContent = tok.slice(2, -2)
      container.appendChild(s)
    } else if (tok.startsWith('*')) {
      const i = document.createElement('em')
      i.textContent = tok.slice(1, -1)
      container.appendChild(i)
    } else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      const a = document.createElement('a')
      a.className = 'cm-md-link'
      a.textContent = mm ? mm[1] : tok
      if (mm) a.title = mm[2]
      container.appendChild(a)
    }
    last = m.index + tok.length
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)))
}

function parseRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly pos: number,
    readonly mode: BlockMode
  ) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source && other.mode === this.mode
  }
  get estimatedHeight(): number {
    return this.source.split('\n').filter((l) => l.trim()).length * 34
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = this.mode === 'preview' ? 'cm-md-table-wrap cm-block-preview' : 'cm-md-table-wrap'
    if (this.mode === 'render') addEditButton(wrap, view, this.pos)
    else addCloseButton(wrap, view)
    const lines = this.source.split('\n').filter((l) => l.trim())
    if (lines.length < 2) {
      wrap.textContent = this.source
      return wrap
    }
    const header = parseRow(lines[0])
    const aligns = parseRow(lines[1]).map((c) => {
      const l = c.startsWith(':')
      const r = c.endsWith(':')
      return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
    })
    const table = document.createElement('table')
    table.className = 'cm-md-table'
    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    header.forEach((h, i) => {
      const th = document.createElement('th')
      renderInline(view, th, h)
      if (aligns[i]) th.style.textAlign = aligns[i]
      htr.appendChild(th)
    })
    thead.appendChild(htr)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    for (let i = 2; i < lines.length; i++) {
      const cells = parseRow(lines[i])
      const tr = document.createElement('tr')
      cells.forEach((c, j) => {
        const td = document.createElement('td')
        renderInline(view, td, c)
        if (aligns[j]) td.style.textAlign = aligns[j]
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    return wrap
  }
}

const ALERT_LABELS: Record<string, string> = {
  note: 'ⓘ Note',
  tip: '💡 Tip',
  important: '❗ Important',
  warning: '⚠ Warning',
  caution: '🛑 Caution'
}
const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const

/**
 * Dropdown shown at the start of a blockquote's first line (Milkdown-style): it
 * reflects the current alert type and lets you change it, promote a plain quote,
 * or downgrade back to a plain quote — all as plain text edits.
 */
class AlertSelectWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly lineFrom: number
  ) {
    super()
  }
  eq(other: AlertSelectWidget): boolean {
    return other.kind === this.kind && other.lineFrom === this.lineFrom
  }
  toDOM(view: EditorView): HTMLElement {
    const sel = document.createElement('select')
    sel.className = 'cm-alert-select ' + (this.kind ? `cm-alert-select-${this.kind}` : 'cm-alert-select-none')
    const mk = (value: string, text: string): void => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    mk('', '— Citation (aucune alerte)')
    for (const t of ALERT_TYPES) mk(t, ALERT_LABELS[t])
    sel.value = this.kind
    sel.addEventListener('mousedown', (e) => e.stopPropagation())
    sel.addEventListener('change', () => this.apply(view, sel.value))
    return sel
  }
  private apply(view: EditorView, type: string): void {
    const doc = view.state.doc
    const line = doc.lineAt(this.lineFrom)
    const text = line.text
    const isAlert = /^\s*>\s*\\?\[!(note|tip|important|warning|caution)\]\s*$/i.test(text)
    const prefixM = /^(\s*>\s?)/.exec(text)
    const prefix = prefixM ? prefixM[1] : '> '
    if (type) {
      if (isAlert) {
        const markerStart = line.from + /^(\s*>\s*)/.exec(text)![1].length
        view.dispatch({ changes: { from: markerStart, to: line.to, insert: `[!${type.toUpperCase()}]` } })
      } else {
        const at = line.from + prefix.length
        view.dispatch({ changes: { from: at, insert: `[!${type.toUpperCase()}]\n${prefix}` } })
      }
    } else if (isAlert) {
      // Downgrade to a plain quote: drop the marker-only first line entirely.
      view.dispatch({ changes: { from: line.from, to: Math.min(line.to + 1, doc.length) } })
    }
    view.focus()
  }
}

/**
 * YAML frontmatter rendered as a discreet card (Milkdown-style): the `title:`
 * field shows as an H1, the other keys as small chips. `✎` reveals the raw YAML
 * (with a live editable block + `✓ Terminer` to leave). Replaces the whole
 * fenced block so the `---` fences don't sit as visible noise when not editing.
 */
class FrontmatterWidget extends WidgetType {
  constructor(
    readonly raw: string,
    readonly pos: number
  ) {
    super()
  }
  eq(other: FrontmatterWidget): boolean {
    return other.raw === this.raw
  }
  get estimatedHeight(): number {
    return 70
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-frontmatter-card'
    const pairs: Array<[string, string]> = []
    for (const line of this.raw.split('\n')) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (m) pairs.push([m[1], m[2].trim()])
    }
    const title = pairs.find(([k]) => k.toLowerCase() === 'title')
    if (title && title[1]) {
      const h = document.createElement('div')
      h.className = 'cm-fm-title'
      h.textContent = title[1].replace(/^["']|["']$/g, '')
      wrap.appendChild(h)
    }
    const bar = document.createElement('div')
    bar.className = 'cm-fm-props'
    const gear = document.createElement('span')
    gear.className = 'cm-fm-gear'
    gear.textContent = '⚙'
    bar.appendChild(gear)
    const rest = pairs.filter(([k]) => k.toLowerCase() !== 'title')
    if (rest.length) {
      for (const [k, v] of rest) {
        const chip = document.createElement('span')
        chip.className = 'cm-fm-chip'
        chip.textContent = v ? `${k}: ${v}` : k
        bar.appendChild(chip)
      }
    } else {
      const empty = document.createElement('span')
      empty.className = 'cm-fm-empty'
      empty.textContent = title ? 'Propriétés' : 'Frontmatter'
      bar.appendChild(empty)
    }
    wrap.appendChild(bar)
    addEditButton(wrap, view, this.pos)
    return wrap
  }
}

/** A standalone "✓ Terminer" bar (block widget) — used to leave a source region
 * that has no rendered preview of its own (e.g. the raw frontmatter editor). */
class BlockCloseWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-block-close-bar'
    addCloseButton(bar, view)
    return bar
  }
}

/* ---------- code-block language picker ---------- */
let langListEl: HTMLDataListElement | null = null
/** A shared <datalist> of the known languages (from @codemirror/language-data),
 * so the picker offers autocompletion while still allowing free text. */
function ensureLangDatalist(): string {
  if (!langListEl) {
    langListEl = document.createElement('datalist')
    langListEl.id = 'cm-lang-list'
    const names = Array.from(new Set(languages.map((l) => l.name))).sort((a, b) => a.localeCompare(b))
    for (const n of names) {
      const o = document.createElement('option')
      o.value = n
      langListEl.appendChild(o)
    }
    document.body.appendChild(langListEl)
  }
  return langListEl.id
}

/** Language field floated at the top-right of a fenced code block. Editing it
 * rewrites the info string on the opening fence line (a plain text edit). */
class LangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }
  eq(other: LangWidget): boolean {
    return other.lang === this.lang
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input')
    input.className = 'cm-code-lang'
    input.setAttribute('list', ensureLangDatalist())
    input.value = this.lang
    input.placeholder = 'langage'
    input.spellcheck = false
    input.title = 'Langage du bloc de code'
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    const commit = (): void => {
      const line = view.state.doc.lineAt(view.posAtDOM(input))
      const m = /^(\s*)(`{3,}|~{3,})/.exec(line.text)
      if (!m) return
      const infoFrom = line.from + m[0].length
      view.dispatch({ changes: { from: infoFrom, to: line.to, insert: input.value.trim() } })
      view.focus()
    }
    input.addEventListener('change', commit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      }
    })
    return input
  }
  ignoreEvent(): boolean {
    return true
  }
}

/* ---------- helpers for the regex post-pass ---------- */
type Span = [number, number]
function inAny(spans: Span[], from: number, to: number): boolean {
  for (const [a, b] of spans) {
    if (from < b && to > a) return true
  }
  return false
}

/* ---------- decoration builder ---------- */
function buildDecorations(state: EditorState): DecorationSet {
  const deco: Array<Range<Decoration>> = []
  const doc = state.doc
  const text = doc.toString()
  const tree = syntaxTree(state)
  const taskRanges: Span[] = []
  const codeRanges: Span[] = []
  // Ranges (character offsets) already claimed by a wikilink `[[…]]` so the
  // Lezer Link handler doesn't also try to hide brackets in the same spot.
  const wikilinkRanges: Span[] = []
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    wikilinkRanges.push([m.index, m.index + m[0].length])
  }

  // YAML frontmatter: a `---` fenced block at the very top of the document.
  // Its lines are styled and, crucially, exempt from Markdown inline rendering
  // (so `tags: [a, b]` isn't mistaken for a link).
  let frontmatterEnd = 0
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      const closeLine = doc.lineAt(end + 1)
      frontmatterEnd = closeLine.to
      if (!editing(state, 0, frontmatterEnd)) {
        // Collapsed: a discreet card (title → H1, other keys → chips).
        const rawFrom = doc.line(2).from
        const rawTo = closeLine.number > 2 ? doc.line(closeLine.number - 1).to : rawFrom
        const raw = doc.sliceString(rawFrom, rawTo)
        deco.push(
          Decoration.replace({ widget: new FrontmatterWidget(raw, rawFrom), block: true }).range(0, frontmatterEnd)
        )
      } else {
        // Editing: styled raw YAML + a "✓ Terminer" bar to leave the block.
        for (let n = 1; n <= closeLine.number; n++) {
          deco.push(Decoration.line({ class: 'cm-md-frontmatter' }).range(doc.line(n).from))
        }
        deco.push(Decoration.widget({ widget: new BlockCloseWidget(), block: true, side: 1 }).range(frontmatterEnd))
      }
    }
  }
  const inFrontmatter = (from: number): boolean => from < frontmatterEnd

  tree.iterate({
    enter: (node) => {
      const name = node.name
      const from = node.from
      const to = node.to

      // Fenced code: Mermaid diagram, or a styled/highlighted code block.
      if (name === 'FencedCode') {
        codeRanges.push([from, to])
        const info = node.node.getChild('CodeInfo')
        const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : ''
        if (lang === 'mermaid') {
          const textNode = node.node.getChild('CodeText')
          const code = textNode ? doc.sliceString(textNode.from, textNode.to) : ''
          const contentPos = textNode ? textNode.from : from
          if (!editing(state, from, to)) {
            deco.push(
              Decoration.replace({ widget: new MermaidWidget(code, contentPos, 'render'), block: true }).range(from, to)
            )
            return false
          }
          // Editing: keep the source (styled) and show a live preview below it.
          const mf = doc.lineAt(from).number
          const ml = doc.lineAt(to).number
          for (let n = mf; n <= ml; n++) {
            deco.push(Decoration.line({ class: 'cm-md-codeblock' }).range(doc.line(n).from))
          }
          deco.push(
            Decoration.widget({ widget: new MermaidWidget(code, contentPos, 'preview'), block: true, side: 1 }).range(to)
          )
          return false
        }
        const first = doc.lineAt(from).number
        const last = doc.lineAt(to).number
        for (let n = first; n <= last; n++) {
          deco.push(Decoration.line({ class: 'cm-md-codeblock' }).range(doc.line(n).from))
        }
        // Language picker floated at the block's top-right (free text + known-lang
        // autocompletion). Placed on the opening fence line.
        deco.push(Decoration.widget({ widget: new LangWidget(lang), side: 1 }).range(doc.line(first).from))
        // Return true: descend so the nested language tree (from codeLanguages)
        // is still highlighted by syntaxHighlighting().
        return true
      }

      if (name === 'InlineCode') codeRanges.push([from, to])

      // GFM table → rendered HTML table; raw source + live preview while editing.
      if (name === 'Table') {
        const src = doc.sliceString(from, to)
        if (!editing(state, from, to)) {
          // Edit button lands the caret inside the first header cell (from + 2),
          // not on the table boundary, so the table toolbar resolves the node.
          deco.push(Decoration.replace({ widget: new TableWidget(src, from + 2, 'render'), block: true }).range(from, to))
        } else {
          deco.push(
            Decoration.widget({ widget: new TableWidget(src, from, 'preview'), block: true, side: 1 }).range(to)
          )
        }
        return false
      }

      // Blockquote: plain quote, or a GitHub alert when the first line is
      // `[!TYPE]` (an optional leading backslash from an over-escaping serializer
      // is tolerated). Every blockquote gets a type dropdown on its first line.
      if (name === 'Blockquote') {
        const firstLine = doc.lineAt(from)
        const am = /^\s*>\s*\\?\[!(note|tip|important|warning|caution)\]\s*$/i.exec(firstLine.text)
        const kind = am ? am[1].toLowerCase() : ''
        const first = firstLine.number
        const last = doc.lineAt(to).number
        // The dropdown + marker-hiding are ALWAYS applied (not gated on editing):
        // otherwise the caret landing on the first line would make the control
        // vanish and reveal the raw `[!TYPE]` marker — reported as flickering.
        for (let n = first; n <= last; n++) {
          const line = doc.line(n)
          const pos = (n === first ? ' cm-alert-first' : '') + (n === last ? ' cm-alert-last' : '')
          deco.push(
            Decoration.line({ class: kind ? `cm-alert cm-alert-${kind}${pos}` : 'cm-md-quote' }).range(line.from)
          )
          if (n === first) {
            deco.push(Decoration.widget({ widget: new AlertSelectWidget(kind, line.from), side: -1 }).range(line.from))
            if (kind) {
              // Hide the whole `> [!TYPE]` marker line (the dropdown shows it).
              deco.push(Decoration.replace({}).range(line.from, line.to))
            } else {
              const qm = /^\s*>\s?/.exec(line.text)
              if (qm && qm[0].length) deco.push(Decoration.replace({}).range(line.from, line.from + qm[0].length))
            }
            continue
          }
          // Hide the leading `> ` quote marker on body lines.
          const qm = /^\s*>\s?/.exec(line.text)
          if (qm && qm[0].length) deco.push(Decoration.replace({}).range(line.from, line.from + qm[0].length))
        }
        return
      }

      // Task list items (incl. the MDForge `[~]` state): three-state checkbox.
      if (name === 'ListItem') {
        const line = doc.lineAt(from)
        const m = /^(\s*[-*+]\s+)\[([ xX~])\]/.exec(line.text)
        if (m) {
          const markFrom = line.from + m[1].length
          const st = (m[2].toLowerCase() === 'x' ? 'x' : m[2]) as TaskState
          deco.push(Decoration.replace({ widget: new TaskWidget(st) }).range(markFrom, markFrom + 3))
          taskRanges.push([markFrom, markFrom + 3])
        }
        return
      }

      // Thematic break (`---` / `***` / `___`) → a compact rendered rule; raw
      // `---` is shown (editable) only when the caret is on the line.
      if (name === 'HorizontalRule') {
        const line = doc.lineAt(from)
        if (!editing(state, line.from, line.to) && line.to > line.from) {
          deco.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(line.from, line.to))
        } else {
          deco.push(Decoration.line({ class: 'cm-md-hr-editing' }).range(line.from))
        }
        return false
      }

      // Headings: enlarge the line, hide the leading "### ".
      const headingMatch = /^ATXHeading([1-6])$/.exec(name)
      if (headingMatch) {
        const line = doc.lineAt(from)
        deco.push(Decoration.line({ class: `cm-md-h cm-md-h${headingMatch[1]}` }).range(line.from))
        if (!editing(state, line.from, line.to)) {
          const mark = node.node.getChild('HeaderMark')
          if (mark) deco.push(Decoration.replace({}).range(mark.from, Math.min(mark.to + 1, line.to)))
        }
        return
      }

      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'InlineCode' || name === 'Strikethrough') {
        if (inFrontmatter(from)) return
        const cls =
          name === 'StrongEmphasis'
            ? 'cm-md-strong'
            : name === 'Emphasis'
              ? 'cm-md-em'
              : name === 'InlineCode'
                ? 'cm-md-code'
                : 'cm-md-strike'
        deco.push(Decoration.mark({ class: cls }).range(from, to))
        if (!editing(state, from, to)) {
          const markName =
            name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === markName) deco.push(Decoration.replace({}).range(c.from, c.to))
          }
        }
        return
      }

      // Links: hide `[`, `](url)` and style the text. Skip the `[~]` task marker
      // and wikilinks `[[…]]` (both of which the parser also sees as Links).
      if (name === 'Link') {
        if (inFrontmatter(from)) return
        if (taskRanges.some(([a, b]) => from >= a && to <= b)) return
        if (inAny(wikilinkRanges, from, to)) return
        if (editing(state, from, to)) return
        const open = node.node.firstChild
        let close: { from: number; to: number } | null = null
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (c.name === 'LinkMark' && doc.sliceString(c.from, c.to) === ']') {
            close = { from: c.from, to: c.to }
            break
          }
        }
        let url = ''
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (c.name === 'URL') {
            url = doc.sliceString(c.from, c.to)
            break
          }
        }
        if (open && open.name === 'LinkMark') deco.push(Decoration.replace({}).range(open.from, open.to))
        if (close) {
          const textFrom = open ? open.to : from
          if (close.from > textFrom) {
            // Tag the visible text with the URL so Ctrl/⌘-click can open it.
            deco.push(
              Decoration.mark({
                class: 'cm-md-link',
                attributes: { 'data-href': url, title: `${url}  (Ctrl/⌘+clic pour ouvrir)` }
              }).range(textFrom, close.from)
            )
          }
          deco.push(Decoration.replace({}).range(close.from, to))
        }
        return
      }

      // Images: `![alt](src)` → rendered <img>. While editing, keep the image as
      // a preview below the raw source (same pattern as mermaid/table/math).
      if (name === 'Image' && !inFrontmatter(from)) {
        const t = doc.sliceString(from, to)
        const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)/.exec(t)
        if (!m) return
        if (!editing(state, from, to)) {
          deco.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1], from, 'render') }).range(from, to))
        } else {
          const line = doc.lineAt(to)
          deco.push(
            Decoration.widget({ widget: new ImageWidget(m[2], m[1], from, 'preview'), side: 1, block: true }).range(
              line.to
            )
          )
        }
        return
      }
    }
  })

  /* ---------- regex post-pass: math, wikilinks, footnotes ---------- */
  const mathRanges: Span[] = []

  // Block math $$…$$ (may span lines) → centered widget.
  for (const m of text.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to)) continue
    mathRanges.push([from, to])
    if (!editing(state, from, to)) {
      deco.push(
        Decoration.replace({ widget: new MathWidget(m[1].trim(), true, from, 'render'), block: true }).range(from, to)
      )
    } else {
      deco.push(
        Decoration.widget({ widget: new MathWidget(m[1].trim(), true, -1, 'preview'), block: true, side: 1 }).range(to)
      )
    }
  }

  // Inline math $…$ → inline widget (skip block-math and code spans).
  for (const m of text.matchAll(/\$([^\s$][^$\n]*?)\$/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to) || inAny(mathRanges, from, to)) continue
    if (!editing(state, from, to)) {
      deco.push(Decoration.replace({ widget: new MathWidget(m[1].trim(), false) }).range(from, to))
    }
  }

  // Wikilinks [[target]] / [[target|alias]] → clickable, brackets hidden.
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to)) continue
    const raw = m[1]
    const pipe = raw.indexOf('|')
    const target = (pipe === -1 ? raw : raw.slice(0, pipe)).trim()
    const label = (pipe === -1 ? raw : raw.slice(pipe + 1)).trim()
    if (editing(state, from, to)) {
      deco.push(Decoration.mark({ class: 'cm-md-wikilink-raw' }).range(from, to))
      continue
    }
    // Hide `[[`, hide any `|alias` part, hide `]]`; style + tag the visible label.
    deco.push(Decoration.replace({}).range(from, from + 2))
    if (pipe === -1) {
      deco.push(
        Decoration.mark({ class: 'cm-md-wikilink', attributes: { 'data-wikilink': target } }).range(from + 2, to - 2)
      )
    } else {
      const labelFrom = from + 2 + pipe + 1
      deco.push(Decoration.replace({}).range(from + 2, labelFrom))
      deco.push(
        Decoration.mark({ class: 'cm-md-wikilink', attributes: { 'data-wikilink': target } }).range(labelFrom, to - 2)
      )
    }
    deco.push(Decoration.replace({}).range(to - 2, to))
    void label
  }

  // Footnotes: references `[^id]` (clickable) and definitions `[^id]:` (styled).
  for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to)) continue
    const isDef = text[to] === ':'
    deco.push(
      Decoration.mark({
        class: isDef ? 'cm-md-footnote-def' : 'cm-md-footnote-ref',
        attributes: { 'data-footnote': m[1] }
      }).range(from, to)
    )
  }

  return Decoration.set(deco, true)
}

// A StateField (not a ViewPlugin) so it can provide *block* decorations
// (Mermaid diagrams, tables, block math). Rebuilds on doc/selection change.
export const livePreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})
