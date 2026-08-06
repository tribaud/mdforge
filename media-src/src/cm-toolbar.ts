/*
 * MDForge (CodeMirror experiment) — formatting toolbar.
 *
 * A persistent top bar plus a selection bubble. Every action is a plain text
 * edit on the CodeMirror document (wrap the selection in markers, or toggle a
 * line prefix), so — like the rest of this engine — it never re-serializes.
 */
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { openSearchPanel, closeSearchPanel, searchPanelOpen } from '@codemirror/search'

/** Lezer node the marker produces, and the child node that IS the marker. */
const MARKER_NODE: Record<string, { node: string; mark: string }> = {
  '**': { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  '*': { node: 'Emphasis', mark: 'EmphasisMark' },
  '~~': { node: 'Strikethrough', mark: 'StrikethroughMark' },
  '`': { node: 'InlineCode', mark: 'CodeMark' }
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * Toggle a symmetric inline marker (`**`, `*`, `~~`, `` ` ``).
 *
 * Real toggle, driven by the syntax tree — not by the characters next to the
 * caret. If the caret/selection sits *anywhere inside* an existing span of the
 * matching kind (even a whole italic paragraph), its markers are removed. With
 * no selection, the word under the caret is used as the target to wrap.
 */
export function wrap(view: EditorView, marker: string): void {
  const { state } = view
  const sel = state.selection.main
  const kind = MARKER_NODE[marker]

  // 1) Already emphasised? Walk up from the caret to an enclosing node of the
  //    matching kind and strip its marker children — a genuine unwrap.
  if (kind) {
    const tree = syntaxTree(state)
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(sel.from, 0); node; node = node.parent) {
      if (node.name !== kind.node) continue
      const changes: Array<{ from: number; to: number; insert: string }> = []
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.name === kind.mark) changes.push({ from: c.from, to: c.to, insert: '' })
      }
      if (changes.length) {
        view.dispatch({ changes })
        view.focus()
        return
      }
    }
  }

  // 2) Not emphasised → wrap. Expand an empty selection to the word under caret.
  let from = sel.from
  let to = sel.to
  if (from === to) {
    const line = state.doc.lineAt(from)
    const text = line.text
    let s = from - line.from
    let e = s
    while (s > 0 && WORD_CHAR.test(text[s - 1])) s--
    while (e < text.length && WORD_CHAR.test(text[e])) e++
    if (e > s) {
      from = line.from + s
      to = line.from + e
    }
  }
  const len = marker.length
  view.dispatch({
    changes: [
      { from, insert: marker },
      { from: to, insert: marker }
    ],
    selection: { anchor: from + len, head: to + len }
  })
  view.focus()
}

/** Toggle a line prefix (`## `, `> `, `- `) on every line the selection spans. */
function toggleLinePrefix(view: EditorView, prefix: string, re: RegExp): void {
  const { state } = view
  const main = state.selection.main
  const first = state.doc.lineAt(main.from).number
  const last = state.doc.lineAt(main.to).number
  let allHave = true
  for (let n = first; n <= last; n++) {
    if (!state.doc.line(n).text.startsWith(prefix)) {
      allHave = false
      break
    }
  }
  const changes = []
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n)
    if (allHave) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' })
    } else {
      const m = re.exec(line.text)
      changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix })
    }
  }
  view.dispatch({ changes })
  view.focus()
}

export /** Insert a thematic break (`---`) on its own line below the caret. */
function insertHr(view: EditorView): void {
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const at = line.to
  const insert = (line.text.trim() ? '\n\n' : '') + '---\n'
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } })
  view.focus()
}

export function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const text = view.state.doc.sliceString(from, to) || 'texte'
  const md = `[${text}](url)`
  const urlStart = from + text.length + 3 // after "[text]("
  view.dispatch({
    changes: { from, to, insert: md },
    selection: { anchor: urlStart, head: urlStart + 3 }
  })
  view.focus()
}

/** Open (or toggle) the CodeMirror search panel. */
function toggleSearch(view: EditorView): void {
  if (searchPanelOpen(view.state)) closeSearchPanel(view)
  else openSearchPanel(view)
}

/** Next free numeric footnote id (`[^N]`) in the document. */
function nextFootnoteId(view: EditorView): number {
  let max = 0
  for (const m of view.state.doc.toString().matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]))
  return max + 1
}

/**
 * Footnote helper: a small popup asks for the note text, then inserts a `[^N]`
 * reference at the caret and appends its `[^N]: text` definition at the end of
 * the document (both in one edit).
 */
export function insertFootnote(view: EditorView): void {
  if (document.querySelector('.cm-footnote-popup')) return
  const pop = document.createElement('div')
  pop.className = 'cm-footnote-popup'
  const title = document.createElement('div')
  title.className = 'cm-fn-title'
  title.textContent = 'Note de bas de page'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'cm-fn-input'
  input.placeholder = 'Texte de la note…'
  const row = document.createElement('div')
  row.className = 'cm-fn-row'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'cm-tb-btn'
  cancel.textContent = 'Annuler'
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'cm-tb-btn cm-fn-ok'
  ok.textContent = 'Ajouter'
  row.append(cancel, ok)
  pop.append(title, input, row)
  document.body.appendChild(pop)

  const coords = view.coordsAtPos(view.state.selection.main.head)
  if (coords) {
    pop.style.top = `${coords.bottom + window.scrollY + 6}px`
    pop.style.left = `${Math.max(4, Math.min(coords.left + window.scrollX, window.innerWidth - 320))}px`
  }
  input.focus()

  const close = (): void => {
    document.removeEventListener('mousedown', onOutside, true)
    pop.remove()
  }
  const onOutside = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node)) close()
  }
  const submit = (): void => {
    const content = input.value.trim() || '…'
    const id = nextFootnoteId(view)
    const caret = view.state.selection.main.head
    const ref = `[^${id}]`
    const docLen = view.state.doc.length
    const endsNl = docLen === 0 || view.state.doc.sliceString(docLen - 1) === '\n'
    const def = `${endsNl ? '' : '\n'}\n[^${id}]: ${content}\n`
    view.dispatch({
      changes: [
        { from: caret, insert: ref },
        { from: docLen, insert: def }
      ],
      selection: { anchor: caret + ref.length }
    })
    close()
    view.focus()
  }
  ok.addEventListener('click', submit)
  cancel.addEventListener('click', () => {
    close()
    view.focus()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      view.focus()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  })
  // Defer so the click that opened the popup doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0)
}

interface Action {
  label: string
  title: string
  run: (view: EditorView) => void
}

type Entry = Action | 'sep'

const ENTRIES: Entry[] = [
  { label: 'B', title: 'Gras (Ctrl/⌘B)', run: (v) => wrap(v, '**') },
  { label: 'I', title: 'Italique (Ctrl/⌘I)', run: (v) => wrap(v, '*') },
  { label: 'S', title: 'Barré', run: (v) => wrap(v, '~~') },
  { label: '</>', title: 'Code (Ctrl/⌘E)', run: (v) => wrap(v, '`') },
  'sep',
  { label: 'H1', title: 'Heading 1', run: (v) => toggleLinePrefix(v, '# ', /^#{1,6}\s+/) },
  { label: 'H2', title: 'Heading 2', run: (v) => toggleLinePrefix(v, '## ', /^#{1,6}\s+/) },
  { label: 'H3', title: 'Heading 3', run: (v) => toggleLinePrefix(v, '### ', /^#{1,6}\s+/) },
  'sep',
  { label: '❝', title: 'Quote', run: (v) => toggleLinePrefix(v, '> ', /^>\s?/) },
  { label: '•', title: 'Bullet list', run: (v) => toggleLinePrefix(v, '- ', /^[-*+]\s+/) },
  { label: '☑', title: 'Task', run: (v) => toggleLinePrefix(v, '- [ ] ', /^[-*+]\s+(\[[ xX~]\]\s+)?/) },
  { label: '🔗', title: 'Lien (Ctrl/⌘K)', run: (v) => insertLink(v) },
  { label: '†', title: 'Note de bas de page', run: (v) => insertFootnote(v) },
  { label: '—', title: 'Ligne horizontale', run: (v) => insertHr(v) },
  'sep',
  { label: '🔍', title: 'Rechercher (Ctrl/⌘F)', run: (v) => toggleSearch(v) }
]

function buildButtons(view: EditorView, container: HTMLElement): void {
  for (const entry of ENTRIES) {
    if (entry === 'sep') {
      const sep = document.createElement('span')
      sep.className = 'cm-tb-sep'
      container.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-tb-btn'
    btn.textContent = entry.label
    btn.title = entry.title
    btn.setAttribute('data-tip', entry.title) // CSS tooltip (native title is unreliable in the webview)
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', () => entry.run(view))
    container.appendChild(btn)
  }
}

/** Persistent top toolbar (caller inserts it above the editor). */
export function createTopbar(view: EditorView): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'cm-topbar'
  buildButtons(view, bar)
  return bar
}

/** Floating bubble shown over a non-empty selection. Returns an `update` hook to
 * call from the editor's update listener. */
export function createBubble(view: EditorView): { el: HTMLElement; update: () => void } {
  const el = document.createElement('div')
  el.className = 'cm-bubble'
  el.style.display = 'none'
  buildButtons(view, el)
  document.body.appendChild(el)

  const update = (): void => {
    const sel = view.state.selection.main
    if (sel.empty || !view.hasFocus) {
      el.style.display = 'none'
      return
    }
    const start = view.coordsAtPos(sel.from)
    const end = view.coordsAtPos(sel.to)
    if (!start || !end) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'flex'
    const top = Math.min(start.top, end.top) - el.offsetHeight - 8 + window.scrollY
    const left = (start.left + end.left) / 2 - el.offsetWidth / 2 + window.scrollX
    el.style.top = `${Math.max(4, top)}px`
    el.style.left = `${Math.max(4, left)}px`
  }
  return { el, update }
}
