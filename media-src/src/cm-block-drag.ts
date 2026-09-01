/*
 * MDForge (CodeMirror experiment) — draggable block handle.
 *
 * A `⠿` handle appears at the left of the top-level block under the mouse.
 * Dragging it reorders that block (paragraph, heading, list, blockquote, fenced
 * code, table, math…) to a new position. Everything is a plain text edit: the
 * block's whole-line range is cut and re-inserted, so — like the rest of this
 * engine — nothing is re-serialized.
 *
 * The handle sits in the left margin (outside `.cm-scroller`), so all pointer
 * listeners live on `view.dom` (which contains both the scroller and the
 * handle) — a `mouseleave` bound to the scroller alone would hide the handle the
 * instant the pointer crossed the margin to grab it.
 *
 * The same margin carries two more affordances on the same row:
 *  - clicking `⠿` SELECTS the block, so a style can be applied to it at once
 *    (the selection bubble appears on it);
 *  - a `▾`/`▸` chevron folds the section. The fold gutter's arrows were too
 *    discreet to find, so folding lives here, next to the block it folds. The
 *    open chevron follows the pointer, but a FOLDED section keeps a `▸` shown at
 *    all times — otherwise the only trace of a collapsed section is a jump in the
 *    line numbers.
 *  - on a HEADING only, a double chevron further left folds/unfolds every
 *    heading of that same level at once ("Replier tous les titres H2"), which
 *    collapses one outline level and leaves the others as they are.
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { PluginValue, ViewUpdate } from '@codemirror/view'
import { syntaxTree, foldable, foldEffect, unfoldEffect, foldedRanges } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

interface Span {
  from: number
  to: number
}

/** A collapsed section's permanent marker: its range + where to draw it. */
interface FoldedMark {
  from: number
  to: number
  top: number
  height: number
  left: number
}

/** The top-level block at `pos`, expanded to whole lines. A blank line (no
 * enclosing node) falls back to that single line. A heading expands to its whole
 * section — everything down to the next heading of the same or a higher level —
 * so dragging a title carries its content (same rule as the fold service). */
function topBlockAt(state: EditorState, pos: number): Span {
  const tree = syntaxTree(state)
  let node: ReturnType<typeof tree.resolve> = tree.resolve(pos, 1)
  if (!node.parent) {
    const line = state.doc.lineAt(pos)
    return { from: line.from, to: line.to }
  }
  while (node.parent && node.parent.parent) node = node.parent
  const doc = state.doc
  const from = doc.lineAt(node.from).from
  let to = doc.lineAt(Math.min(node.to, doc.length)).to

  const hm = /^ATXHeading([1-6])$/.exec(node.name)
  if (hm) {
    const level = Number(hm[1])
    const startLine = doc.lineAt(node.from).number
    for (let n = startLine + 1; n <= doc.lines; n++) {
      const l = doc.line(n)
      const h = /^(#{1,6})\s/.exec(l.text)
      if (h && h[1].length <= level) break
      to = l.to
    }
  }
  return { from, to }
}

/** The foldable range of every ATX heading at `level` (fenced code skipped, so a
 * `# comment` inside a shell block is not mistaken for a title). Used to fold a
 * whole outline level at once. */
function headingRangesAtLevel(state: EditorState, level: number): Span[] {
  const out: Span[] = []
  let inFence = false
  let fenceCh = ''
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const fence = /^\s*(`{3,}|~{3,})/.exec(line.text)
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceCh = ch
      } else if (ch === fenceCh) inFence = false
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s/.exec(line.text)
    if (!m || m[1].length !== level) continue
    const range = foldable(state, line.from, line.to)
    if (range) out.push(range)
  }
  return out
}

/** Move the block spanning `src` so it lands *before* line index `dropLine`
 * (0-based). Works on the line array (whole-doc replace) — small docs, rare
 * action, and it sidesteps change-position mapping. Heals blank-line seams so
 * blocks keep a single blank line between them. */
function moveBlock(view: EditorView, src: Span, dropLine: number): void {
  const doc = view.state.doc
  const sLine = doc.lineAt(src.from).number - 1
  const eLine = doc.lineAt(src.to).number - 1
  if (dropLine >= sLine && dropLine <= eLine + 1) return // onto itself → no-op

  const lines = doc.toString().split('\n')
  const moved = lines.slice(sLine, eLine + 1)
  lines.splice(sLine, moved.length)

  let t = dropLine > eLine ? dropLine - moved.length : dropLine
  // Heal a double blank line left behind at the source seam.
  if (sLine > 0 && sLine < lines.length && lines[sLine - 1] === '' && lines[sLine] === '') {
    lines.splice(sLine, 1)
    if (sLine < t) t--
  }
  if (t < 0) t = 0
  if (t > lines.length) t = lines.length

  // Bracket the moved block with a single blank line on each side as needed.
  const block = moved.slice()
  if (t < lines.length && lines[t] !== '') block.push('')
  if (t > 0 && lines[t - 1] !== '') block.unshift('')
  lines.splice(t, 0, ...block)

  while (lines.length && lines[0] === '') lines.shift() // no stray leading blank
  const next = lines.join('\n')
  if (next === doc.toString()) return
  view.dispatch({ changes: { from: 0, to: doc.length, insert: next } })
}

class BlockDragHandle implements PluginValue {
  private handle: HTMLElement
  private fold: HTMLElement
  /** Double chevron: fold/unfold every heading of the hovered heading's level. */
  private foldAll: HTMLElement
  /** Level of the hovered heading (0 when the block is not a heading). */
  private headingLevel = 0
  /** Cached level scan, invalidated on any doc or fold change (see `update`). */
  private levelCache: { level: number; ranges: Span[]; allFolded: boolean } | null = null
  /** One always-visible `▸` per collapsed section in the viewport (pooled). */
  private foldedMarks: HTMLElement[] = []
  private indicator: HTMLElement
  private current: Span | null = null
  private dragging: Span | null = null
  /** Fold range of the block under the pointer (null when not foldable). */
  private foldRange: { from: number; to: number } | null = null
  /** A drag just ended — swallow the click that may follow it. */
  private justDragged = false
  /** Last pointer position, to re-place the controls after a scroll. */
  private pointer: { x: number; y: number } | null = null
  private dropLine = 0
  private readonly onMove: (e: MouseEvent) => void
  private readonly onLeave: (e: MouseEvent) => void
  private readonly onDrop: (e: DragEvent) => void
  private readonly onScroll: () => void

  constructor(private readonly view: EditorView) {
    if (getComputedStyle(view.dom).position === 'static') view.dom.style.position = 'relative'

    this.handle = document.createElement('div')
    this.handle.className = 'cm-block-handle'
    this.handle.textContent = '⠿'
    this.handle.setAttribute('data-tip', 'Sélectionner ce bloc\nGlisser pour le déplacer ailleurs')
    this.handle.draggable = true
    this.handle.style.display = 'none'
    this.handle.addEventListener('mousedown', (e) => e.stopPropagation())
    this.handle.addEventListener('click', () => {
      if (!this.justDragged) this.selectBlock()
    })
    this.handle.addEventListener('dragstart', (e) => this.start(e))
    this.handle.addEventListener('dragend', () => this.end())
    view.dom.appendChild(this.handle)

    // Fold chevron, left of the handle. Shown only when the block under the
    // pointer actually has a foldable range (a heading with a section).
    this.fold = document.createElement('div')
    this.fold.className = 'cm-block-fold'
    this.fold.style.display = 'none'
    this.fold.addEventListener('mousedown', (e) => {
      e.preventDefault() // never move the caret / start a drag
      e.stopPropagation()
    })
    this.fold.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleFold()
    })
    view.dom.appendChild(this.fold)

    // One level at a time: on a heading, fold (or unfold) every heading of the
    // same level in the document.
    this.foldAll = document.createElement('div')
    this.foldAll.className = 'cm-block-fold-all'
    // The glyph is rotated, not the box — a rotated box would rotate its tooltip.
    const foldAllIcon = document.createElement('span')
    foldAllIcon.className = 'cm-block-fold-all-icon'
    foldAllIcon.textContent = '»'
    this.foldAll.appendChild(foldAllIcon)
    this.foldAll.style.display = 'none'
    this.foldAll.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    this.foldAll.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleLevel()
    })
    view.dom.appendChild(this.foldAll)

    this.indicator = document.createElement('div')
    this.indicator.className = 'cm-block-drop-indicator'
    this.indicator.style.display = 'none'
    view.dom.appendChild(this.indicator)

    this.onMove = (e) => this.position(e)
    this.onLeave = (e) => {
      // Only hide when the pointer truly leaves the editor (not when it crosses
      // onto the handle or another child).
      const to = e.relatedTarget as Node | null
      if (!this.dragging && (!to || !view.dom.contains(to))) {
        this.pointer = null
        this.handle.style.display = 'none'
        this.fold.style.display = 'none'
        this.foldAll.style.display = 'none'
      }
    }
    this.onDrop = (e) => this.drop(e)
    // Everything here is absolutely placed against `view.dom` — which is the
    // editor frame, NOT the scroller — so scrolling would leave the markers
    // pinned to the screen instead of travelling with their block.
    this.onScroll = () => {
      this.scheduleFolded()
      if (!this.dragging && this.pointer) this.positionAt(this.pointer.x, this.pointer.y)
    }
    this.scheduleFolded()
    view.dom.addEventListener('mousemove', this.onMove)
    view.dom.addEventListener('mouseleave', this.onLeave)
    view.dom.addEventListener('dragover', this.onMove)
    view.dom.addEventListener('drop', this.onDrop)
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
  }

  private position(e: MouseEvent): void {
    if (this.dragging) {
      this.updateIndicator(e)
      e.preventDefault() // allow the drop
      return
    }
    // Over the handle/chevron itself → keep them shown, don't recompute (else
    // they flicker and are impossible to grab).
    if (e.target === this.handle || e.target === this.fold || e.target === this.foldAll) return
    this.pointer = { x: e.clientX, y: e.clientY }
    this.positionAt(e.clientX, e.clientY)
  }

  /** Place the handle + open chevron for the block under a viewport point. Split
   * out of the mousemove handler so a scroll can re-run it with the pointer's
   * last known position — the controls are absolutely placed against
   * `view.dom`, which does NOT scroll, so they must be re-placed by hand. */
  private positionAt(x: number, y: number): void {
    const pos = this.view.posAtCoords({ x, y })
    if (pos == null) return
    let span: Span
    try {
      span = topBlockAt(this.view.state, pos)
    } catch {
      return
    }
    this.current = span
    const coords = this.view.coordsAtPos(span.from)
    if (!coords) {
      // Scrolled out of view: don't leave the controls stranded mid-document.
      this.handle.style.display = 'none'
      this.fold.style.display = 'none'
      this.foldAll.style.display = 'none'
      return
    }
    const rect = this.view.dom.getBoundingClientRect()
    // A tall block can start above the frame (or end below it): keep the controls
    // inside it — `.cm-editor` does not clip, so an unclamped handle would be
    // drawn over the toolbar.
    const top = Math.min(Math.max(coords.top - rect.top, 0), Math.max(0, this.view.dom.clientHeight - 24))
    const left = this.lineLeft(span.from, coords.left) - rect.left
    // Not enough room above for the bubble → show it under the control instead of
    // over the toolbar (`.cm-editor` does not clip).
    const below = top < 34
    this.handle.classList.toggle('cm-tip-below', below)
    this.fold.classList.toggle('cm-tip-below', below)
    this.foldAll.classList.toggle('cm-tip-below', below)
    this.handle.style.display = 'flex'
    this.handle.style.top = `${top}px`
    this.handle.style.left = `${Math.max(0, left - 22)}px`

    const line = this.view.state.doc.lineAt(span.from)
    this.placeLevelControl(line.text, top, left)
    this.foldRange = foldable(this.view.state, line.from, line.to)
    if (!this.foldRange) {
      this.fold.style.display = 'none'
      return
    }
    if (this.isFolded(this.foldRange)) {
      // Already collapsed: its permanent `▸` is there and does the unfolding —
      // a second chevron on top of it would just blur the click target.
      this.fold.style.display = 'none'
      return
    }
    this.fold.textContent = '▾'
    this.fold.setAttribute('data-tip', 'Replier cette section\n(son contenu jusqu\u2019au titre de même niveau)')
    this.fold.style.display = 'flex'
    this.fold.style.top = `${top}px`
    this.fold.style.height = `${coords.bottom - coords.top}px`
    this.fold.style.left = `${Math.max(0, left - 40)}px`
  }

  /** The level scan behind the double chevron, cached until the document or the
   * fold state changes (it walks every line, and this runs on mousemove). */
  private levelInfo(level: number): { ranges: Span[]; allFolded: boolean } | null {
    // An empty scan is cached too (it costs a whole-document walk), but it must
    // still answer "nothing to fold" — returning the cached object showed a dead
    // "Replier les 0 titres H2" chevron on the second hover.
    if (this.levelCache?.level === level) {
      return this.levelCache.ranges.length ? this.levelCache : null
    }
    const info = {
      level,
      ranges: headingRangesAtLevel(this.view.state, level),
      allFolded: false
    }
    info.allFolded = info.ranges.length > 0 && info.ranges.every((r) => this.isFolded(r))
    this.levelCache = info
    return info.ranges.length ? info : null
  }

  /** Show the double chevron on headings only, pointing down to collapse the
   * level and up to expand it back. */
  private placeLevelControl(lineText: string, top: number, left: number): void {
    const hm = /^(#{1,6})\s/.exec(lineText)
    this.headingLevel = hm ? hm[1].length : 0
    const info = this.headingLevel ? this.levelInfo(this.headingLevel) : null
    if (!info) {
      this.foldAll.style.display = 'none'
      return
    }
    this.foldAll.classList.toggle('cm-block-fold-all-up', info.allFolded)
    this.foldAll.setAttribute(
      'data-tip',
      info.allFolded
        ? `Déplier les ${info.ranges.length} titres H${this.headingLevel} du document`
        : `Replier les ${info.ranges.length} titres H${this.headingLevel} du document\n(les autres niveaux ne bougent pas)`
    )
    this.foldAll.style.display = 'flex'
    this.foldAll.style.top = `${top}px`
    this.foldAll.style.left = `${Math.max(0, left - 58)}px`
  }

  /** Fold every heading of the hovered level — or unfold them when they are all
   * already folded. One transaction, and never a duplicate fold. */
  private toggleLevel(): void {
    const level = this.headingLevel
    if (!level) return
    const info = this.levelInfo(level)
    if (!info) return
    const effects = info.allFolded
      ? info.ranges.filter((r) => this.isFolded(r)).map((r) => unfoldEffect.of(r))
      : info.ranges.filter((r) => !this.isFolded(r)).map((r) => foldEffect.of(r))
    if (!effects.length) return
    this.view.dispatch({ effects })
    this.levelCache = null
    if (this.pointer) this.positionAt(this.pointer.x, this.pointer.y)
  }

  /**
   * Re-place the permanent `▸` of every collapsed section. Measuring is deferred
   * to `requestMeasure` so we never read the layout in the middle of an update.
   */
  private scheduleFolded(): void {
    this.view.requestMeasure({
      read: (view) => this.measureFolded(view),
      write: (marks) => this.paintFolded(marks)
    })
  }

  private measureFolded(view: EditorView): FoldedMark[] {
    const out: FoldedMark[] = []
    const rect = view.dom.getBoundingClientRect()
    // A fold range starts at the END of its heading line; the marker belongs at
    // the START of that line, next to the handle.
    foldedRanges(view.state).between(view.viewport.from, view.viewport.to, (from, to) => {
      const line = view.state.doc.lineAt(from)
      const coords = view.coordsAtPos(line.from)
      if (!coords) return
      const top = coords.top - rect.top
      // CodeMirror's viewport extends past what is on screen, and `.cm-editor`
      // does not clip — an unfiltered marker would be painted over the toolbar.
      if (top < 0 || top > view.dom.clientHeight) return
      out.push({
        from,
        to,
        top,
        height: coords.bottom - coords.top,
        left: Math.max(0, this.lineLeft(line.from, coords.left) - rect.left - 40)
      })
    })
    return out
  }

  private paintFolded(marks: FoldedMark[]): void {
    while (this.foldedMarks.length < marks.length) {
      const el = document.createElement('div')
      el.className = 'cm-block-fold cm-block-fold-closed'
      el.textContent = '▸'
      el.setAttribute('data-tip', 'Section repliée — cliquer pour la déplier')
      el.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const from = Number(el.dataset.from)
        const to = Number(el.dataset.to)
        if (Number.isFinite(from) && Number.isFinite(to)) {
          this.view.dispatch({ effects: unfoldEffect.of({ from, to }) })
        }
      })
      this.view.dom.appendChild(el)
      this.foldedMarks.push(el)
    }
    this.foldedMarks.forEach((el, i) => {
      const m = marks[i]
      if (!m) {
        el.style.display = 'none'
        return
      }
      el.dataset.from = String(m.from)
      el.dataset.to = String(m.to)
      el.style.display = 'flex'
      el.classList.toggle('cm-tip-below', m.top < 34)
      el.style.top = `${m.top}px`
      el.style.height = `${m.height}px`
      el.style.left = `${m.left}px`
    })
  }

  update(update: ViewUpdate): void {
    const folding = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect))
    )
    if (folding || update.docChanged) this.levelCache = null
    if (folding || update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.scheduleFolded()
    }
  }

  /**
   * Left edge of a block's line box, in viewport coordinates. Measured on the
   * `.cm-line` element, NOT from a text position: a leading widget — the alert
   * type dropdown on a `> [!NOTE]`, a checkbox — pushes `coordsAtPos` to the
   * right of itself, which used to drop the margin controls inside that widget.
   */
  private lineLeft(pos: number, fallback: number): number {
    try {
      const { node } = this.view.domAtPos(pos)
      const el = node instanceof HTMLElement ? node : node.parentElement
      const line = el?.closest('.cm-line')
      if (line) return line.getBoundingClientRect().left
    } catch {
      // not rendered — fall back to the text position
    }
    return fallback
  }

  /** Select the whole block under the handle (a heading takes its section), so
   * the next toolbar/bubble action applies to all of it. */
  private selectBlock(): void {
    const span = this.current
    if (!span) return
    // `current` is a snapshot from the last mousemove: if the document shrank
    // since, BOTH ends can be past the end — an unclamped anchor throws.
    const len = this.view.state.doc.length
    const anchor = Math.min(span.from, len)
    const head = Math.min(span.to, len)
    this.view.dispatch({ selection: { anchor, head } })
    this.view.focus()
  }

  /** True when this exact range is currently collapsed. */
  private isFolded(range: { from: number; to: number }): boolean {
    let folded = false
    foldedRanges(this.view.state).between(range.from, range.to, (from) => {
      if (from === range.from) {
        folded = true
        return false
      }
      return undefined
    })
    return folded
  }

  private toggleFold(): void {
    const range = this.foldRange
    if (!range) return
    const folded = this.isFolded(range)
    this.view.dispatch({ effects: folded ? unfoldEffect.of(range) : foldEffect.of(range) })
    // Folding hands the section over to its permanent `▸`.
    if (!folded) this.fold.style.display = 'none'
  }

  private start(e: DragEvent): void {
    if (!this.current) {
      e.preventDefault()
      return
    }
    this.dragging = this.current
    if (e.dataTransfer) {
      e.dataTransfer.setData('text/plain', '')
      e.dataTransfer.effectAllowed = 'move'
    }
    this.indicator.style.display = 'block'
  }

  private updateIndicator(e: MouseEvent): void {
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos == null) return
    let span: Span
    try {
      span = topBlockAt(this.view.state, pos)
    } catch {
      return
    }
    const top = this.view.coordsAtPos(span.from)
    const bottom = this.view.coordsAtPos(span.to)
    if (!top || !bottom) return
    const doc = this.view.state.doc
    const before = e.clientY < (top.top + bottom.bottom) / 2
    this.dropLine = before ? doc.lineAt(span.from).number - 1 : doc.lineAt(span.to).number
    const rect = this.view.dom.getBoundingClientRect()
    this.indicator.style.top = `${(before ? top.top : bottom.bottom) - rect.top}px`
    this.indicator.style.display = 'block'
  }

  private drop(e: DragEvent): void {
    if (!this.dragging) return
    e.preventDefault()
    const src = this.dragging
    const target = this.dropLine
    this.end()
    try {
      moveBlock(this.view, src, target)
    } catch {
      // best-effort; never break the editor
    }
  }

  private end(): void {
    this.dragging = null
    this.indicator.style.display = 'none'
    this.handle.style.display = 'none'
    this.fold.style.display = 'none'
    this.foldAll.style.display = 'none'
    this.justDragged = true
    window.setTimeout(() => (this.justDragged = false), 250)
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.view.dom.removeEventListener('mousemove', this.onMove)
    this.view.dom.removeEventListener('mouseleave', this.onLeave)
    this.view.dom.removeEventListener('dragover', this.onMove)
    this.view.dom.removeEventListener('drop', this.onDrop)
    this.handle.remove()
    this.fold.remove()
    this.foldAll.remove()
    this.foldedMarks.forEach((el) => el.remove())
    this.indicator.remove()
  }
}

export const blockDrag = ViewPlugin.fromClass(BlockDragHandle)
