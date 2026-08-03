/*
 * MDForge (CodeMirror experiment) — Obsidian-style "Live Preview".
 *
 * The CodeMirror document IS the Markdown text: no semantic model, no
 * re-serialization, so an edit only changes the characters typed. "Rendering"
 * is done with decorations — syntax markers are hidden and content styled, and
 * the raw syntax is revealed whenever the selection enters a node.
 *
 * Covers: headings, bold/italic/code/strike, links, images, three-state task
 * checkboxes (incl. the MDForge `[~]` in-progress state), fenced code blocks,
 * Mermaid diagrams and GFM tables.
 */
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'

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

/** True when a selection range touches [from, to] — then we reveal raw syntax. */
function editing(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/* ---------- widgets ---------- */
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
  constructor(readonly code: string) {
    super()
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-mermaid'
    renderMermaid(el, this.code)
    return el
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
  constructor(readonly source: string) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-wrap'
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

/* ---------- decoration builder ---------- */
function buildDecorations(state: EditorState): DecorationSet {
  const deco: Array<Range<Decoration>> = []
  const doc = state.doc
  const tree = syntaxTree(state)
  const taskRanges: Array<[number, number]> = []

  tree.iterate({
    enter: (node) => {
      const name = node.name
      const from = node.from
      const to = node.to

      // Fenced code: Mermaid diagram, or a styled code block.
      if (name === 'FencedCode') {
        const info = node.node.getChild('CodeInfo')
        const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : ''
        if (lang === 'mermaid' && !editing(state, from, to)) {
          const text = node.node.getChild('CodeText')
          const code = text ? doc.sliceString(text.from, text.to) : ''
          deco.push(Decoration.replace({ widget: new MermaidWidget(code), block: true }).range(from, to))
          return false
        }
        const first = doc.lineAt(from).number
        const last = doc.lineAt(to).number
        for (let n = first; n <= last; n++) {
          deco.push(Decoration.line({ class: 'cm-md-codeblock' }).range(doc.line(n).from))
        }
        return false
      }

      // GFM table → rendered HTML table (raw while editing).
      if (name === 'Table') {
        if (!editing(state, from, to)) {
          deco.push(
            Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to)), block: true }).range(from, to)
          )
        }
        return false
      }

      // Task list items (incl. the MDForge `[~]` state): three-state checkbox.
      if (name === 'ListItem') {
        const line = doc.lineAt(from)
        const m = /^(\s*[-*+]\s+)\[([ xX~])\]/.exec(line.text)
        if (m) {
          const markFrom = line.from + m[1].length
          const state = (m[2].toLowerCase() === 'x' ? 'x' : m[2]) as TaskState
          deco.push(Decoration.replace({ widget: new TaskWidget(state) }).range(markFrom, markFrom + 3))
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
      // (which the parser also sees as a Link) — the checkbox already owns it.
      if (name === 'Link') {
        if (taskRanges.some(([a, b]) => from >= a && to <= b)) return
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
      if (name === 'Image' && !editing(state, from, to)) {
        const text = doc.sliceString(from, to)
        const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)/.exec(text)
        if (m) deco.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(from, to))
        return
      }
    }
  })

  return Decoration.set(deco, true)
}

// A StateField (not a ViewPlugin) so it can provide *block* decorations
// (Mermaid diagrams, tables). Rebuilds when the doc or the selection changes.
export const livePreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})
