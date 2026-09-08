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

const setMatchesEffect = StateEffect.define<DecorationSet>()

const matchesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    // Typing answers the question the marks were asking; let them go rather
    // than leave stale highlights behind the caret.
    if (transaction.docChanged && !transaction.effects.some((e) => e.is(setMatchesEffect))) {
      return Decoration.none
    }
    marks = marks.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setMatchesEffect)) marks = effect.value
    }
    return marks
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const searchMatchMarks: Extension = [matchesField]

/** Document offset of a match, clamped onto what the note actually holds. */
function offsetOf(view: EditorView, match: SearchMatch): number {
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(match.line, 1), doc.lines))
  return Math.min(line.from + Math.max(match.column - 1, 0), line.to)
}

/** The marked lines, in document order, read back from the field. */
function markedLines(view: EditorView): number[] {
  const positions: number[] = []
  const marks = view.state.field(matchesField, false)
  marks?.between(0, view.state.doc.length, (from) => {
    positions.push(from)
  })
  return positions
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
      setMatchesEffect.of(marksFor(view, offsets, index)),
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
  const offsets = matches.map((match) => offsetOf(view, match))
  goTo(view, offsets, 0)
  // Take the keyboard only if the webview already has it — otherwise the user
  // is still walking the result list with the arrows, and stealing focus would
  // end that walk on its first step. `F8` needs the editor focused to work.
  if (document.hasFocus() && !view.hasFocus) view.focus()
}

/**
 * Walk the marked matches (`F8` / `Shift+F8`). Returns false when there are
 * none, so the key falls through to whatever else is bound to it.
 */
export function nextSearchMatch(view: EditorView, direction: 1 | -1): boolean {
  const offsets = markedLines(view)
  if (offsets.length === 0) return false
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head).from
  const at = offsets.indexOf(line)
  const index = at === -1 ? (direction === 1 ? 0 : offsets.length - 1) : (at + direction + offsets.length) % offsets.length
  goTo(view, offsets, index)
  return true
}
