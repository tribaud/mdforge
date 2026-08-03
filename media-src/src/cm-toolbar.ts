/*
 * MDForge (CodeMirror experiment) — formatting toolbar.
 *
 * A persistent top bar plus a selection bubble. Every action is a plain text
 * edit on the CodeMirror document (wrap the selection in markers, or toggle a
 * line prefix), so — like the rest of this engine — it never re-serializes.
 */
import { EditorView } from '@codemirror/view'

/** Wrap the primary selection in `before`/`after` (caret between when empty). */
function wrap(view: EditorView, before: string, after: string = before): void {
  const { from, to } = view.state.selection.main
  view.dispatch({
    changes: [
      { from, insert: before },
      { from: to, insert: after }
    ],
    selection: { anchor: from + before.length, head: to + before.length }
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

function insertLink(view: EditorView): void {
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

interface Action {
  label: string
  title: string
  run: (view: EditorView) => void
}

type Entry = Action | 'sep'

const ENTRIES: Entry[] = [
  { label: 'B', title: 'Bold', run: (v) => wrap(v, '**') },
  { label: 'I', title: 'Italic', run: (v) => wrap(v, '*') },
  { label: 'S', title: 'Strikethrough', run: (v) => wrap(v, '~~') },
  { label: '</>', title: 'Inline code', run: (v) => wrap(v, '`') },
  'sep',
  { label: 'H1', title: 'Heading 1', run: (v) => toggleLinePrefix(v, '# ', /^#{1,6}\s+/) },
  { label: 'H2', title: 'Heading 2', run: (v) => toggleLinePrefix(v, '## ', /^#{1,6}\s+/) },
  { label: 'H3', title: 'Heading 3', run: (v) => toggleLinePrefix(v, '### ', /^#{1,6}\s+/) },
  'sep',
  { label: '❝', title: 'Quote', run: (v) => toggleLinePrefix(v, '> ', /^>\s?/) },
  { label: '•', title: 'Bullet list', run: (v) => toggleLinePrefix(v, '- ', /^[-*+]\s+/) },
  { label: '☑', title: 'Task', run: (v) => toggleLinePrefix(v, '- [ ] ', /^[-*+]\s+(\[[ xX~]\]\s+)?/) },
  { label: '🔗', title: 'Link', run: (v) => insertLink(v) }
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
