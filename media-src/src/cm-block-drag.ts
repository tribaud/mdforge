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
 */
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { PluginValue } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

interface Span {
  from: number
  to: number
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
  private indicator: HTMLElement
  private current: Span | null = null
  private dragging: Span | null = null
  private dropLine = 0
  private readonly onMove: (e: MouseEvent) => void
  private readonly onLeave: (e: MouseEvent) => void
  private readonly onDrop: (e: DragEvent) => void

  constructor(private readonly view: EditorView) {
    if (getComputedStyle(view.dom).position === 'static') view.dom.style.position = 'relative'

    this.handle = document.createElement('div')
    this.handle.className = 'cm-block-handle'
    this.handle.textContent = '⠿'
    this.handle.title = 'Glisser pour déplacer le bloc'
    this.handle.draggable = true
    this.handle.style.display = 'none'
    this.handle.addEventListener('mousedown', (e) => e.stopPropagation())
    this.handle.addEventListener('dragstart', (e) => this.start(e))
    this.handle.addEventListener('dragend', () => this.end())
    view.dom.appendChild(this.handle)

    this.indicator = document.createElement('div')
    this.indicator.className = 'cm-block-drop-indicator'
    this.indicator.style.display = 'none'
    view.dom.appendChild(this.indicator)

    this.onMove = (e) => this.position(e)
    this.onLeave = (e) => {
      // Only hide when the pointer truly leaves the editor (not when it crosses
      // onto the handle or another child).
      const to = e.relatedTarget as Node | null
      if (!this.dragging && (!to || !view.dom.contains(to))) this.handle.style.display = 'none'
    }
    this.onDrop = (e) => this.drop(e)
    view.dom.addEventListener('mousemove', this.onMove)
    view.dom.addEventListener('mouseleave', this.onLeave)
    view.dom.addEventListener('dragover', this.onMove)
    view.dom.addEventListener('drop', this.onDrop)
  }

  private position(e: MouseEvent): void {
    if (this.dragging) {
      this.updateIndicator(e)
      e.preventDefault() // allow the drop
      return
    }
    // Over the handle itself → keep it shown, don't recompute (else it flickers
    // and is impossible to grab).
    if (e.target === this.handle) return
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY })
    if (pos == null) return
    let span: Span
    try {
      span = topBlockAt(this.view.state, pos)
    } catch {
      return
    }
    this.current = span
    const coords = this.view.coordsAtPos(span.from)
    if (!coords) return
    const rect = this.view.dom.getBoundingClientRect()
    this.handle.style.display = 'flex'
    this.handle.style.top = `${coords.top - rect.top}px`
    this.handle.style.left = `${Math.max(0, coords.left - rect.left - 24)}px`
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
  }

  destroy(): void {
    this.view.dom.removeEventListener('mousemove', this.onMove)
    this.view.dom.removeEventListener('mouseleave', this.onLeave)
    this.view.dom.removeEventListener('dragover', this.onMove)
    this.view.dom.removeEventListener('drop', this.onDrop)
    this.handle.remove()
    this.indicator.remove()
  }
}

export const blockDrag = ViewPlugin.fromClass(BlockDragHandle)
