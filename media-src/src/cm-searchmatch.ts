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
import { openSearchPanel, setSearchQuery, SearchQuery } from '@codemirror/search'
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
const WORD = Decoration.mark({ class: 'cm-search-word' })
const WORD_CURRENT = Decoration.mark({ class: 'cm-search-word cm-search-word-current' })

/**
 * What is currently marked: the line decorations, and the match offsets that
 * produced them. The offsets are kept because a decoration only remembers the
 * LINE it marks — walking the matches with `F8` would otherwise lose the
 * column on the first hop, and two matches on one line would become one.
 */
interface Marked {
  marks: DecorationSet
  offsets: number[]
  /** Length of the term when it could be deduced, 0 when only lines are marked. */
  length: number
  /**
   * Whether WE paint the term. False once the search panel is doing it:
   * `@codemirror/search` highlights every match — in the very same VS Code
   * colours — but only while its panel is open, and two backgrounds with alpha
   * stacked on one range come out darker than either.
   */
  ownMarks: boolean
}

const EMPTY: Marked = { marks: Decoration.none, offsets: [], length: 0, ownMarks: true }

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

/**
 * Rebuild the marks: the line of every match, plus the term itself when the
 * host could deduce it — that is the "the word I searched for, highlighted"
 * half, and the line stays underneath it so the eye finds the place first.
 */
function marksFor(
  view: EditorView,
  offsets: number[],
  current: number,
  length: number,
  ownMarks: boolean
): DecorationSet {
  const doc = view.state.doc
  const currentLine = doc.lineAt(offsets[current]).from
  // Two matches on the same line are one line highlight.
  const lines = [...new Set(offsets.map((offset) => doc.lineAt(offset).from))].sort((a, b) => a - b)
  const ranges = lines.map((from) => (from === currentLine ? HIT_CURRENT : HIT).range(from))
  if (length > 0 && ownMarks) {
    for (let index = 0; index < offsets.length; index++) {
      const from = offsets[index]
      const to = Math.min(from + length, doc.lineAt(from).to)
      if (to > from) ranges.push((index === current ? WORD_CURRENT : WORD).range(from, to))
    }
  }
  // `true`: line and mark decorations interleave, and CodeMirror wants them
  // sorted — cheaper to let it sort than to merge two ordered lists by hand.
  return Decoration.set(ranges, true)
}

/**
 * Put the caret on a match, mark the whole set, and scroll it to the middle of
 * the frame. `settle` re-scrolls while the note is still growing: mermaid
 * diagrams, KaTeX and images all land after CodeMirror measured, and a target
 * chosen before they did ends up off-screen.
 */
function goTo(
  view: EditorView,
  offsets: number[],
  index: number,
  length: number,
  ownMarks: boolean
): void {
  const anchor = offsets[index]
  // When the panel does the highlighting, the term is SELECTED rather than
  // pointed at: that is what makes `@codemirror/search` mark it as the current
  // match, and what makes its Enter / next start from here. The bubble that
  // normally follows a selection stays away — focus is in the panel's field, so
  // `view.hasFocus` is false.
  const head = ownMarks ? anchor : Math.min(anchor + length, view.state.doc.lineAt(anchor).to)
  view.dispatch({
    selection: { anchor, head },
    effects: [
      setMatchesEffect.of({
        marks: marksFor(view, offsets, index, length, ownMarks),
        offsets,
        length,
        ownMarks
      }),
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
      if (view.state.selection.main.from !== anchor) return
      const coords = view.coordsAtPos(anchor)
      const frame = view.scrollDOM.getBoundingClientRect()
      if (coords && coords.top >= frame.top && coords.bottom <= frame.bottom) return
      view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: 'center' }) })
      settle(view, anchor, attempt + 1)
    },
    200 * (attempt + 1)
  )
}

/**
 * Which occurrence to land on, given where the search said its first match was.
 * The occurrence on that LINE if there is one — the column can have drifted, or
 * the term may be a shorter guess than what was searched — and otherwise the
 * nearest one, because the results can date from before the last few edits.
 */
function landing(view: EditorView, offsets: number[], reported: number): number {
  const line = view.state.doc.lineAt(Math.min(reported, view.state.doc.length))
  const onLine = offsets.findIndex((offset) => offset >= line.from && offset <= line.to)
  if (onLine !== -1) return onLine
  let best = 0
  for (let index = 1; index < offsets.length; index++) {
    if (Math.abs(offsets[index] - reported) < Math.abs(offsets[best] - reported)) best = index
  }
  return best
}

/** Every occurrence of the term in the note, in document order. */
function occurrences(view: EditorView, query: string, caseSensitive: boolean): number[] {
  const text = view.state.doc.toString()
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

/**
 * Show what the search found in this note.
 *
 * With a term, the note's OWN occurrences are what gets marked and walked: they
 * are read from the text in front of us, so they hold even if the file moved on
 * since the search ran, and there are usually more of them than the search
 * reported (a whole-word or case-sensitive search is narrower) — which is what
 * `Ctrl+F` would have shown anyway. The line/column the search gave still
 * decides WHERE to land: the first occurrence at or after its first match.
 * Without a term, the reported positions are all there is, and the mark is the
 * whole line.
 */
export function showSearchMatches(
  view: EditorView,
  matches: SearchMatch[],
  query?: string,
  caseSensitive = false
): void {
  if (!view.state.field(matchesField, false) || matches.length === 0) return
  const reported = [...new Set(matches.map((match) => offsetOf(view, match)))].sort((a, b) => a - b)
  const hits = query ? occurrences(view, query, caseSensitive) : []
  const offsets = hits.length > 0 ? hits : reported
  const length = hits.length > 0 ? query!.length : 0

  // The keyboard is only taken if the webview already has it — otherwise the
  // user is still walking the result list with the arrows, and stealing focus
  // would end that walk on its first step.
  const focused = document.hasFocus()
  // With a term and the focus, hand the search over to MDForge's own panel: the
  // term goes in its field, every occurrence lights up, and Enter / the next
  // button walk them exactly as `Ctrl+F` does. Without the focus there is no
  // panel to open without stealing it, so we paint the occurrences ourselves.
  const panel = length > 0 && focused
  goTo(view, offsets, landing(view, offsets, reported[0]), length, !panel)

  if (panel) {
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: query!, caseSensitive }))
    })
    openSearchPanel(view)
  } else if (focused && !view.hasFocus) {
    view.focus()
  }
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
  goTo(view, offsets, index, marked.length, marked.ownMarks)
  return true
}
