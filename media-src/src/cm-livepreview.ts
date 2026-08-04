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
function renderMermaid(el: HTMLElement, code: string): void {
  const id = `mdforge-mermaid-${mermaidCounter++}`
  getMermaid()
    .then((m) => (m as { render: (id: string, code: string) => Promise<{ svg: string }> }).render(id, code))
    .then(({ svg }) => {
      el.innerHTML = svg
    })
    .catch((error: unknown) => {
      el.classList.add('cm-mermaid-error')
      el.textContent = `Mermaid error: ${error instanceof Error ? error.message : String(error)}`
    })
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
function renderMath(el: HTMLElement, code: string, display: boolean): void {
  getKatex()
    .then((k) =>
      (k as { render: (expr: string, el: HTMLElement, opts: object) => void }).render(code, el, {
        displayMode: display,
        throwOnError: false,
        output: 'html'
      })
    )
    .catch((error: unknown) => {
      el.classList.add('cm-math-error')
      el.textContent = code
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

/**
 * Add an "✎ Éditer" affordance to a rendered block widget. Clicking it drops
 * the caret into the block's source (`pos`), which — via the reveal-on-edit
 * rule — shows the editable source with a live preview underneath.
 */
function addEditButton(host: HTMLElement, view: EditorView, pos: number): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-edit'
  btn.textContent = '✎ Éditer'
  btn.title = 'Éditer la source'
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    view.focus()
  })
  host.appendChild(btn)
}

type TaskState = ' ' | '~' | 'x'
const NEXT_STATE: Record<TaskState, TaskState> = { ' ': '~', '~': 'x', x: ' ' }

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
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: NEXT_STATE[current] } })
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
    readonly alt: string
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.src = resolveSrc(this.src)
    img.alt = this.alt
    img.className = 'cm-inline-image'
    return img
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
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = this.mode === 'preview' ? 'cm-mermaid cm-block-preview' : 'cm-mermaid'
    const target = document.createElement('div')
    target.className = 'cm-mermaid-target'
    el.appendChild(target)
    renderMermaid(target, this.code)
    if (this.mode === 'render') addEditButton(el, view, this.pos)
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
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className =
      (this.display ? 'cm-math cm-math-block' : 'cm-math cm-math-inline') +
      (this.mode === 'preview' ? ' cm-block-preview' : '')
    if (this.display) {
      const target = document.createElement('div')
      el.appendChild(target)
      renderMath(target, this.code, true)
      if (this.mode === 'render' && this.pos >= 0) addEditButton(el, view, this.pos)
    } else {
      renderMath(el, this.code, false)
    }
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
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
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = this.mode === 'preview' ? 'cm-md-table-wrap cm-block-preview' : 'cm-md-table-wrap'
    if (this.mode === 'render') addEditButton(wrap, view, this.pos)
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
      th.textContent = h
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
        td.textContent = c
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

/** Small leading icon shown before a GitHub alert's content. */
class AlertIconWidget extends WidgetType {
  constructor(readonly kind: string) {
    super()
  }
  eq(other: AlertIconWidget): boolean {
    return other.kind === this.kind
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = `cm-alert-icon cm-alert-icon-${this.kind}`
    span.textContent = ALERT_LABELS[this.kind] ?? this.kind
    return span
  }
}

const ALERT_LABELS: Record<string, string> = {
  note: 'ⓘ Note',
  tip: '💡 Tip',
  important: '❗ Important',
  warning: '⚠ Warning',
  caution: '🛑 Caution'
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
      for (let n = 1; n <= closeLine.number; n++) {
        deco.push(Decoration.line({ class: 'cm-md-frontmatter' }).range(doc.line(n).from))
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

      // Blockquote: plain quote, or a GitHub alert when the first line is `[!TYPE]`.
      if (name === 'Blockquote') {
        const firstLine = doc.lineAt(from)
        const am = /^>\s*\[!(note|tip|important|warning|caution)\]\s*$/i.exec(firstLine.text)
        const kind = am ? am[1].toLowerCase() : ''
        const first = firstLine.number
        const last = doc.lineAt(to).number
        for (let n = first; n <= last; n++) {
          const line = doc.line(n)
          const pos = (n === first ? ' cm-alert-first' : '') + (n === last ? ' cm-alert-last' : '')
          deco.push(
            Decoration.line({ class: kind ? `cm-alert cm-alert-${kind}${pos}` : 'cm-md-quote' }).range(line.from)
          )
          if (n === first && kind) {
            // Replace the whole `> [!TYPE]` marker line with a labelled icon.
            if (!editing(state, line.from, line.to)) {
              deco.push(Decoration.replace({ widget: new AlertIconWidget(kind) }).range(line.from, line.to))
            }
            continue
          }
          // Hide the leading `> ` quote marker on body lines (revealed on edit).
          const qm = /^\s*>\s?/.exec(line.text)
          if (qm && qm[0].length && !editing(state, line.from, line.to)) {
            deco.push(Decoration.replace({}).range(line.from, line.from + qm[0].length))
          }
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
        if (open && open.name === 'LinkMark') deco.push(Decoration.replace({}).range(open.from, open.to))
        if (close) {
          const textFrom = open ? open.to : from
          if (close.from > textFrom) deco.push(Decoration.mark({ class: 'cm-md-link' }).range(textFrom, close.from))
          deco.push(Decoration.replace({}).range(close.from, to))
        }
        return
      }

      // Images: replace `![alt](src)` with an inline <img>.
      if (name === 'Image' && !inFrontmatter(from) && !editing(state, from, to)) {
        const t = doc.sliceString(from, to)
        const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)/.exec(t)
        if (m) deco.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(from, to))
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
