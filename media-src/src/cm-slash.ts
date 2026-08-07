/*
 * MDForge (CodeMirror experiment) — slash `/` command menu.
 *
 * Typing `/` at the start of a line (or after a space) opens a floating menu of
 * block templates. Filtering is live; ↑/↓ navigate, Enter/Tab insert, Esc
 * closes. Everything is a plain text edit (the `/query` is replaced by the
 * template), so — like the rest of this engine — nothing is re-serialized.
 *
 * Built the same way as the selection bubble (createBubble): the caller creates
 * it once and calls `update()` from the editor's update listener. This avoids a
 * ViewPlugin and drives key handling with a capture-phase keydown listener.
 */
import { EditorView } from '@codemirror/view'

interface SlashItem {
  label: string
  hint: string
  keywords: string
  /** Text inserted in place of the `/query`. */
  insert: string
  /** Caret offset inside `insert` after insertion (defaults to insert.length). */
  caret?: number
}

const ITEMS: SlashItem[] = [
  { label: 'Titre 1', hint: 'Grand titre', keywords: 'h1 heading titre 1', insert: '# ' },
  { label: 'Titre 2', hint: 'Sous-titre', keywords: 'h2 heading titre 2', insert: '## ' },
  { label: 'Titre 3', hint: 'Sous-sous-titre', keywords: 'h3 heading titre 3', insert: '### ' },
  { label: 'Liste à puces', hint: '- élément', keywords: 'bullet list puces ul', insert: '- ' },
  { label: 'Liste numérotée', hint: '1. élément', keywords: 'ordered numbered ol numero', insert: '1. ' },
  { label: 'Case à cocher', hint: '- [ ] tâche', keywords: 'task todo checkbox case', insert: '- [ ] ' },
  { label: 'Citation', hint: '> texte', keywords: 'quote blockquote citation', insert: '> ' },
  {
    label: 'Alerte',
    hint: 'Callout GitHub',
    keywords: 'alert note warning callout alerte',
    insert: '> [!NOTE]\n> ',
    caret: 12
  },
  {
    label: 'Tableau',
    hint: 'Grille 2×2',
    keywords: 'table tableau grid grille',
    insert: '| Colonne A | Colonne B |\n| --- | --- |\n| a | b |\n',
    caret: 2
  },
  {
    label: 'Diagramme Mermaid',
    hint: 'Bloc mermaid',
    keywords: 'mermaid diagram diagramme graph',
    insert: '```mermaid\ngraph TD\n  A[Début] --> B[Fin]\n```\n',
    caret: 11
  },
  { label: 'Bloc de code', hint: '``` code ```', keywords: 'code fence bloc', insert: '```\n\n```\n', caret: 4 },
  { label: 'Formule (maths)', hint: '$$ … $$', keywords: 'math katex formule latex', insert: '$$\n\n$$\n', caret: 3 },
  { label: 'Image', hint: '![](url)', keywords: 'image img photo', insert: '![](url)', caret: 2 },
  { label: 'Lien', hint: '[texte](url)', keywords: 'link lien url', insert: '[texte](url)', caret: 1 },
  { label: 'Séparateur', hint: 'Ligne horizontale', keywords: 'hr divider rule separateur trait', insert: '---\n' }
]

/** Match a `/query` ending at the caret, anchored at line start or after a space. */
function slashContext(view: EditorView): { from: number; to: number; query: string } | null {
  const sel = view.state.selection.main
  if (!sel.empty) return null
  const line = view.state.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const m = /(?:^|\s)\/([^/\s]*)$/.exec(before)
  if (!m) return null
  const from = line.from + (m.index === 0 ? 0 : m.index + 1) // the `/` position
  return { from, to: sel.head, query: m[1].toLowerCase() }
}

/** Create the slash menu. Call the returned `update()` from the update listener. */
export function createSlashMenu(view: EditorView): { update: () => void } {
  const dom = document.createElement('div')
  dom.className = 'cm-slash-menu'
  dom.style.display = 'none'
  dom.addEventListener('mousedown', (e) => e.preventDefault())
  document.body.appendChild(dom)

  let open = false
  let from = 0
  let to = 0
  let active = 0
  let filtered: SlashItem[] = []

  const render = (): void => {
    dom.replaceChildren()
    filtered.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'cm-slash-item' + (i === active ? ' cm-slash-active' : '')
      const label = document.createElement('span')
      label.className = 'cm-slash-label'
      label.textContent = it.label
      const hint = document.createElement('span')
      hint.className = 'cm-slash-hint'
      hint.textContent = it.hint
      row.append(label, hint)
      row.addEventListener('mouseenter', () => {
        active = i
        render()
      })
      row.addEventListener('click', () => select())
      dom.appendChild(row)
    })
  }

  const position = (): void => {
    const coords = view.coordsAtPos(from)
    if (!coords) return
    dom.style.top = `${coords.bottom + window.scrollY + 4}px`
    dom.style.left = `${coords.left + window.scrollX}px`
  }

  const hide = (): void => {
    open = false
    dom.style.display = 'none'
  }

  const move = (dir: number): void => {
    if (!open) return
    active = (active + dir + filtered.length) % filtered.length
    render()
  }

  const select = (): void => {
    if (!open) return
    const it = filtered[active]
    const caret = from + (it.caret ?? it.insert.length)
    view.dispatch({ changes: { from, to, insert: it.insert }, selection: { anchor: caret } })
    hide()
    view.focus()
  }

  const update = (): void => {
    const ctx = view.hasFocus ? slashContext(view) : null
    if (!ctx) {
      hide()
      return
    }
    from = ctx.from
    to = ctx.to
    const q = ctx.query
    filtered = ITEMS.filter((it) => !q || it.label.toLowerCase().includes(q) || it.keywords.includes(q))
    if (!filtered.length) {
      hide()
      return
    }
    active = 0
    render()
    position()
    open = true
    dom.style.display = 'block'
  }

  // Capture-phase so nav keys are intercepted before CodeMirror's own keymap.
  view.dom.addEventListener(
    'keydown',
    (e) => {
      if (!open) return
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          e.stopPropagation()
          move(1)
          break
        case 'ArrowUp':
          e.preventDefault()
          e.stopPropagation()
          move(-1)
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          e.stopPropagation()
          select()
          break
        case 'Escape':
          e.preventDefault()
          e.stopPropagation()
          hide()
          break
      }
    },
    true
  )

  return { update }
}
