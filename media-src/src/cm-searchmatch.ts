/*
 * The line a workspace-search result points at, revealed and marked.
 *
 * The host recovers the positions from the search view (src/searchreveal.ts)
 * because VS Code drops the range when the target is a custom editor. What
 * arrives here is every match in the note, never which one was clicked, so the
 * caret goes to the first, all of them are marked, and `F8` / `Shift+F8` walk
 * them. The match's length is not in what the search view prints, hence a LINE
 * highlight rather than a word one.
 *
 * The marks live in a StateField so an edit maps them, and they are dropped on
 * the first document change: they answer "here is what you were looking for",
 * which stops being true as soon as the note is being written in.
 */
import { EditorView, Decoration } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type { Extension } from '@codemirror/state'

/** 1-based line and column, as the search view numbers them. */
export interface SearchMatch {
  line: number
  column: number
}

const HIT = Decoration.line({ class: 'cm-search-hit' })
const HIT_CURRENT = Decoration.line({ class: 'cm-search-hit cm-search-hit-current' })

/**
 * What is currently marked: the line decorations, and the match offsets that
 * produced them. The offsets are kept because a decoration only remembers the
 * LINE it marks — walking the matches with `F8` would otherwise lose the
 * column on the first hop, and two matches on one line would become one.
 */
interface Marked {
  marks: DecorationSet
  offsets: number[]
}

const EMPTY: Marked = { marks: Decoration.none, offsets: [] }

const setMatchesEffect = StateEffect.define<Marked>()

const matchesField = StateField.define<Marked>({
  create: () => EMPTY,
  update(marked, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMatchesEffect)) return effect.value
    }
    // Dropped on the first edit rather than mapped through it: the marks answer
    // "here is what you were looking for", which stops being true as soon as
    // the note is being written in.
    return transaction.docChanged ? EMPTY : marked
  },
  provide: (field) => EditorView.decorations.from(field, (marked) => marked.marks)
})

export const searchMatchMarks: Extension = [matchesField]

/** Document offset of a match, clamped onto what the note actually holds. */
function offsetOf(view: EditorView, match: SearchMatch): number {
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(match.line, 1), doc.lines))
  return Math.min(line.from + Math.max(match.column - 1, 0), line.to)
}

/** Rebuild the marks, the current match's line carrying the brighter class. */
function marksFor(view: EditorView, offsets: number[], current: number): DecorationSet {
  const doc = view.state.doc
  const currentLine = doc.lineAt(offsets[current]).from
  // Two matches on the same line are one highlight.
  const lines = [...new Set(offsets.map((offset) => doc.lineAt(offset).from))].sort((a, b) => a - b)
  return Decoration.set(lines.map((from) => (from === currentLine ? HIT_CURRENT : HIT).range(from)))
}

/**
 * Put the caret on a match, mark the whole set, and scroll it to the middle of
 * the frame. `settle` re-scrolls while the note is still growing: mermaid
 * diagrams, KaTeX and images all land after CodeMirror measured, and a target
 * chosen before they did ends up off-screen.
 */
function goTo(view: EditorView, offsets: number[], index: number): void {
  const anchor = offsets[index]
  view.dispatch({
    selection: { anchor },
    effects: [
      setMatchesEffect.of({ marks: marksFor(view, offsets, index), offsets }),
      EditorView.scrollIntoView(anchor, { y: 'center' })
    ]
  })
  settle(view, anchor)
}

/** Re-scroll until the target holds still, then stop. */
function settle(view: EditorView, anchor: number, attempt = 0): void {
  if (attempt >= 3) return
  setTimeout(
    () => {
      // The user moved on: their caret, their scroll position.
      if (view.state.selection.main.head !== anchor) return
      const coords = view.coordsAtPos(anchor)
      const frame = view.scrollDOM.getBoundingClientRect()
      if (coords && coords.top >= frame.top && coords.bottom <= frame.bottom) return
      view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
      settle(view, anchor, attempt + 1)
    },
    200 * (attempt + 1)
  )
}

/** Show what the search found in this note, caret on the first match. */
export function showSearchMatches(view: EditorView, matches: SearchMatch[]): void {
  if (!view.state.field(matchesField, false) || matches.length === 0) return
  // Sorted: `F8` walks them in document order, and the host's order is only as
  // trustworthy as the text it parsed.
  const offsets = [...new Set(matches.map((match) => offsetOf(view, match)))].sort((a, b) => a - b)
  goTo(view, offsets, 0)
  // Take the keyboard only if the webview already has it — otherwise the user
  // is still walking the result list with the arrows, and stealing focus would
  // end that walk on its first step. `F8` needs the editor focused to work.
  if (document.hasFocus() && !view.hasFocus) view.focus()
}

/**
 * Walk the marked matches (`F8` / `Shift+F8`): the next one AFTER the caret, or
 * the previous one before it, wrapping at either end. Relative to the caret and
 * not to the last match visited, so it keeps working after a click somewhere
 * else in the note. Returns false when there is nothing marked, so the key
 * falls through to whatever else is bound to it.
 */
export function nextSearchMatch(view: EditorView, direction: 1 | -1): boolean {
  const marked = view.state.field(matchesField, false)
  if (!marked || marked.offsets.length === 0) return false
  const offsets = marked.offsets
  const head = view.state.selection.main.head
  let index: number
  if (direction === 1) {
    index = offsets.findIndex((offset) => offset > head)
    if (index === -1) index = 0
  } else {
    index = offsets.length - 1
    while (index >= 0 && offsets[index] >= head) index--
    if (index < 0) index = offsets.length - 1
  }
  goTo(view, offsets, index)
  return true
}
