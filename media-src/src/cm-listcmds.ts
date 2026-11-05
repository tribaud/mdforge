/*
 * MDForge (CodeMirror) — les commandes de liste branchées sur l'éditeur :
 * Tab / Maj+Tab, Entrée sur un élément vide, Backspace après une case, et la
 * conversion puces ⇄ numéros ⇄ tâches (barre, menu du marqueur, raccourcis).
 * La logique est dans cm-listindent.ts (pure) ; ici, seulement le passage des
 * lignes au document.
 */
import type { EditorView } from '@codemirror/view'
import { ChangeSet, Text } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { LIST_ITEM, convertList, kindOf, indentItems, outdentItems, renumberLists, touchedLists } from './cm-listindent'
import type { LineEdit, ListKind } from './cm-listindent'

/* ---------- list indent / outdent on Tab ---------- */
/** Applies `indentItems` / `outdentItems` (cm-listindent.ts) to every line the
 * selection touches. False when no list item is involved, so Tab falls through
 * to its default; true (even with nothing to change) once one is, so a Tab on
 * the first item of a list does not insert a stray indent instead. */
/** Line edits (cm-listindent.ts) → a ChangeSet over `lines`. */
function lineChanges(lines: string[], edits: LineEdit[]): ChangeSet {
  const starts: number[] = []
  let at = 0
  for (const l of lines) {
    starts.push(at)
    at += l.length + 1
  }
  return ChangeSet.of(
    edits.map((e) => ({ from: starts[e.line] + e.from, to: starts[e.line] + e.to, insert: e.insert })),
    at - 1
  )
}
function applyLines(lines: string[], changes: ChangeSet): string[] {
  return changes.apply(Text.of(lines)).toString().split('\n')
}

/** Line indexes (0-based) the selection touches. */
function selectedLines(state: EditorState): number[] {
  const targets = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) targets.add(n - 1)
  }
  return [...targets].sort((a, b) => a - b)
}

/** Tab / Maj+Tab: the move itself, then a renumbering of the lists it
 * touched, composed into ONE transaction (one undo step). */
function runListIndent(view: EditorView, fn: typeof indentItems): boolean {
  const { state } = view
  const targets = selectedLines(state)
  const lines = state.doc.toString().split('\n')
  const edits = fn(lines, targets)
  if (!edits) return false
  if (edits.length) {
    const moved = lineChanges(lines, edits)
    const after = applyLines(lines, moved)
    const renum = lineChanges(after, renumberLists(after, touchedLists(after, targets)))
    view.dispatch({ changes: moved.compose(renum), userEvent: 'input.indent' })
  }
  return true
}

/** Puces ⇄ numéros ⇄ tâches (toolbar, marker menu, Ctrl/⌘+Maj+7/8/9). */
export function setListKind(view: EditorView, kind: ListKind, at?: number): boolean {
  const { state } = view
  const targets = at === undefined ? selectedLines(state) : [state.doc.lineAt(at).number - 1]
  const caretOnly = at !== undefined || state.selection.main.empty
  const lines = state.doc.toString().split('\n')
  const edits = convertList(lines, targets, kind, caretOnly)
  if (edits.length) view.dispatch({ changes: lineChanges(lines, edits), userEvent: 'input' })
  view.focus()
  return true
}

/** Renumérote la liste de la ligne `at` à partir de son premier numéro. */
export function renumberListAt(view: EditorView, at: number): void {
  const lines = view.state.doc.toString().split('\n')
  const edits = renumberLists(lines, [view.state.doc.lineAt(at).number - 1])
  if (edits.length) view.dispatch({ changes: lineChanges(lines, edits), userEvent: 'input' })
  view.focus()
}

export const indentList = (view: EditorView): boolean => runListIndent(view, indentItems)
export const outdentList = (view: EditorView): boolean => runListIndent(view, outdentItems)

/** Entrée sur un élément de liste VIDE (le marqueur seul, caret au bout) :
 * imbriqué, il remonte d'un niveau ; au premier niveau, la puce disparaît.
 * `insertNewlineContinueMarkup` laissait, sur un élément imbriqué, une ligne
 * d'un espace et une nouvelle puce vide au même niveau : la liste devenait
 * « lâche » et il fallait une Entrée de plus pour en sortir. */
/** Backspace juste après la case d'une tâche (`- [ ] |`) : retire la case
 * SEULE, la tâche devient une puce. `deleteMarkupBackward` remplaçait tout
 * `- [ ] ` par des espaces jusqu'au texte de la tâche — 4 de trop pour
 * Markdown, qui aligne les enfants après le `- ` : le `- x` tapé ensuite se
 * lisait comme la suite du paragraphe de la tâche, pas comme une puce. */
export function removeTaskBox(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return false
  const line = state.doc.lineAt(sel.main.head)
  const m = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX~]\][ \t]?/.exec(line.text)
  if (!m || sel.main.head !== line.from + m[0].length) return false
  view.dispatch({
    changes: { from: line.from + m[1].length, to: line.from + m[0].length },
    userEvent: 'delete.backward'
  })
  return true
}

export function exitEmptyItem(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return false
  const line = state.doc.lineAt(sel.main.head)
  const m = LIST_ITEM.exec(line.text)
  if (!m || sel.main.head !== line.to) return false
  // Le marqueur seul (une case à cocher vide compte comme vide aussi).
  if (line.text.slice(m[0].length).replace(/^\[[ xX~]\]\s*$/, '').trim() !== '') return false
  if (m[1].length > 0) return outdentList(view)
  view.dispatch({ changes: { from: line.from, to: line.to }, userEvent: 'delete' })
  return true
}


/* ---------- le menu du marqueur (clic sur une puce ou un numéro) ---------- */

let openMenu: HTMLElement | null = null
function closeListMenu(): void {
  openMenu?.remove()
  openMenu = null
}

/** Un clic sur la puce ou le numéro rendus : choisir le type de la liste, ou
 * la renuméroter. Le choix reste celui de l'utilisateur : rien n'est converti
 * ni renuméroté sans ce geste (ou Tab / Maj+Tab, qui déplacent l'élément). */
export function openListMenu(view: EditorView, pos: number, anchor: HTMLElement): void {
  closeListMenu()
  const line = view.state.doc.lineAt(pos)
  const current = kindOf(line.text)
  const menu = document.createElement('div')
  menu.className = 'cm-suggest-menu cm-list-menu'
  menu.setAttribute('role', 'menu')
  const entries: Array<[string, string, () => void]> = [
    ['•  Puces', 'bullet', () => setListKind(view, 'bullet', line.from)],
    ['1.  Numéros', 'ordered', () => setListKind(view, 'ordered', line.from)],
    ['☐  Tâches', 'task', () => setListKind(view, 'task', line.from)]
  ]
  if (current === 'ordered') entries.push(['↻  Renuméroter 1, 2, 3…', 'renumber', () => renumberFromOne(view, line.from)])
  for (const [label, key, run] of entries) {
    const row = document.createElement('div')
    row.className = 'cm-suggest-item' + (key === current ? ' cm-list-menu-current' : '')
    row.setAttribute('role', 'menuitem')
    row.textContent = label
    row.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeListMenu()
      // Already of that kind: nothing to do (here a click is a choice, not a
      // toggle — the toolbar button is the toggle).
      if (key !== current) run()
      else view.focus()
    })
    menu.appendChild(row)
  }
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${Math.round(r.left + window.scrollX)}px`
  menu.style.top = `${Math.round(r.bottom + window.scrollY + 2)}px`
  document.body.appendChild(menu)
  openMenu = menu
  const away = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return
    if (e.target instanceof Node && menu.contains(e.target)) return
    closeListMenu()
    document.removeEventListener('mousedown', away, true)
    document.removeEventListener('keydown', away, true)
    view.scrollDOM.removeEventListener('scroll', away)
  }
  setTimeout(() => {
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', away, true)
    view.scrollDOM.addEventListener('scroll', away, { passive: true })
  }, 0)
}

/** Renumérote depuis 1 (le menu) — `renumberLists` garde, lui, le premier
 * numéro et le style `1. 1. 1.`. */
function renumberFromOne(view: EditorView, at: number): void {
  const lines = view.state.doc.toString().split('\n')
  const edits = renumberLists(lines, [view.state.doc.lineAt(at).number - 1], 1)
  if (edits.length) view.dispatch({ changes: lineChanges(lines, edits), userEvent: 'input' })
  view.focus()
}
