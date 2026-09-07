/*
 * Quick-diff margin — the added / modified / deleted bars, painted by MDForge
 * itself.
 *
 * The host computes the line ranges against the committed text (src/quickdiff.ts)
 * and posts them; here they become a CodeMirror gutter. A gutter, and not a
 * marker placed against `view.dom`: CodeMirror then owns the vertical layout, so
 * the bars follow folding, compacted blank lines, block widgets and scrolling on
 * their own — none of the re-placement gotchas the ⠿ handle has to deal with.
 *
 * Between two posts the markers are mapped through the user's edits, so typing
 * inside a changed paragraph keeps its bar in place instead of dropping it until
 * the host answers.
 */
import { EditorView, gutter, GutterMarker } from '@codemirror/view'
import { StateEffect, StateField, RangeSet } from '@codemirror/state'
import type { Extension, Range } from '@codemirror/state'

export interface QuickDiffChange {
  from: number
  to: number
  type: 'added' | 'modified' | 'deleted'
}

/**
 * A bar in the margin. The marker has no DOM of its own: `elementClass` styles
 * the gutter element CodeMirror already creates for the line, which is what
 * makes an empty 3px-wide gutter possible.
 */
class DiffMarker extends GutterMarker {
  public constructor(private readonly kind: QuickDiffChange['type']) {
    super()
    this.elementClass = `cm-qd cm-qd-${kind}`
  }

  public override eq(other: GutterMarker): boolean {
    return other instanceof DiffMarker && other.kind === this.kind
  }
}

const MARKERS: Record<QuickDiffChange['type'], DiffMarker> = {
  added: new DiffMarker('added'),
  modified: new DiffMarker('modified'),
  deleted: new DiffMarker('deleted')
}

const setQuickDiffEffect = StateEffect.define<RangeSet<GutterMarker>>()

const quickDiffField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    // Map first: an edit that lands between two host posts must not shift the
    // bars off the lines they belong to.
    markers = markers.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setQuickDiffEffect)) markers = effect.value
    }
    return markers
  }
})

export const quickDiff: Extension = [
  quickDiffField,
  gutter({
    class: 'cm-quickdiff-gutter',
    markers: (view) => view.state.field(quickDiffField, false) ?? RangeSet.empty
  })
]

/** Replace the whole set of markers with what the host just computed. */
export function setQuickDiff(view: EditorView, changes: QuickDiffChange[]): void {
  if (!view.state.field(quickDiffField, false)) return
  const doc = view.state.doc
  const ranges: Array<Range<GutterMarker>> = []
  const seen = new Set<number>()
  const add = (line: number, type: QuickDiffChange['type']): void => {
    // Host line numbers are 0-based; a deletion at the end of the document
    // clamps onto the last line, which is where its wedge belongs.
    const at = doc.line(Math.min(Math.max(line, 0), doc.lines - 1) + 1).from
    if (seen.has(at)) return
    seen.add(at)
    ranges.push(MARKERS[type].range(at))
  }
  for (const change of changes) {
    if (change.type === 'deleted') add(change.from, 'deleted')
    else for (let line = change.from; line < change.to; line++) add(line, change.type)
  }
  // `sort`: the host emits ordered changes, but a clamped deletion can land on a
  // line an earlier change already claimed — cheaper to sort than to trust it.
  view.dispatch({ effects: setQuickDiffEffect.of(RangeSet.of(ranges, true)) })
}
