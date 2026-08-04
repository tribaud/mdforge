/*
 * MDForge (CodeMirror experiment) — table structural toolbar.
 *
 * GFM ships the table syntax but no editing UI, so raw pipes are painful. When
 * the caret is inside a table this floating toolbar appears with add/delete
 * row & column, column alignment and delete-table — every operation rewrites
 * the table's Markdown text directly (no re-serialization of the whole doc).
 */
import { EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

type Align = 'left' | 'center' | 'right' | 'none'

/** Split a `| a | b |` line into trimmed cell strings. */
function splitCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function delimiterCell(align: Align): string {
  return align === 'center' ? ':-:' : align === 'left' ? ':--' : align === 'right' ? '--:' : '---'
}

interface TableCtx {
  from: number
  to: number
  lines: string[][] // row-major cells: [0]=header, [1]=delimiter, [2..]=body
  rowIdx: number
  colIdx: number
  ncols: number
}

/** Resolve the table under the caret into a structured, editable context. */
function tableContext(view: EditorView): TableCtx | null {
  const state = view.state
  const sel = state.selection.main
  if (!sel.empty) return null
  const tree = syntaxTree(state)
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(sel.head, 0)
  for (; node; node = node.parent) if (node.name === 'Table') break
  if (!node) return null
  const from = node.from
  const to = node.to
  const raw = state.doc.sliceString(from, to).split('\n')
  const lines = raw.map(splitCells)
  if (lines.length < 2) return null
  const ncols = lines[0].length
  const caretLine = state.doc.lineAt(sel.head)
  const rowIdx = caretLine.number - state.doc.lineAt(from).number
  const beforeCaret = caretLine.text.slice(0, sel.head - caretLine.from)
  const pipes = (beforeCaret.match(/\|/g) || []).length
  const colIdx = Math.min(Math.max(pipes - 1, 0), ncols - 1)
  return { from, to, lines, rowIdx, colIdx, ncols }
}

/** Create the table toolbar. Call the returned `update()` from the update listener. */
export function createTableToolbar(view: EditorView): { update: () => void } {
  const bar = document.createElement('div')
  bar.className = 'cm-table-bar'
  bar.style.display = 'none'
  bar.addEventListener('mousedown', (e) => e.preventDefault())
  document.body.appendChild(bar)

  let ctx: TableCtx | null = null

  /** Rebuild the table text from cell rows and replace it in the document. */
  const rewrite = (lines: string[][], caretRow: number, caretCol: number): void => {
    if (!ctx) return
    const text = lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n')
    // Aim the caret at the start of the targeted cell in the rebuilt text.
    let anchor = ctx.from
    for (let r = 0; r < caretRow && r < lines.length; r++) anchor += `| ${lines[r].join(' | ')} |\n`.length
    const row = lines[Math.min(caretRow, lines.length - 1)]
    anchor += 2 // "| "
    for (let c = 0; c < caretCol && c < row.length; c++) anchor += row[c].length + 3 // cell + " | "
    view.dispatch({ changes: { from: ctx.from, to: ctx.to, insert: text }, selection: { anchor } })
    view.focus()
  }

  const pad = (row: string[], n: number, fill: string): string[] => {
    const out = row.slice()
    while (out.length < n) out.push(fill)
    return out
  }

  const ops = {
    addRow(below: boolean): void {
      if (!ctx) return
      const lines = ctx.lines.map((r) => r.slice())
      const empty = new Array(ctx.ncols).fill(' ')
      const at = Math.max(2, below ? Math.max(ctx.rowIdx + 1, 2) : Math.max(ctx.rowIdx, 2))
      lines.splice(at, 0, empty)
      rewrite(lines, at, ctx.colIdx)
    },
    deleteRow(): void {
      if (!ctx || ctx.rowIdx < 2 || ctx.lines.length <= 3) return // keep header+delimiter+1 body
      const lines = ctx.lines.filter((_, i) => i !== ctx!.rowIdx)
      rewrite(lines, Math.min(ctx.rowIdx, lines.length - 1), ctx.colIdx)
    },
    addCol(right: boolean): void {
      if (!ctx) return
      const at = right ? ctx.colIdx + 1 : ctx.colIdx
      const lines = ctx.lines.map((cells, i) => {
        const c = pad(cells, ctx!.ncols, i === 1 ? '---' : ' ').slice()
        c.splice(at, 0, i === 0 ? 'Colonne' : i === 1 ? '---' : ' ')
        return c
      })
      rewrite(lines, ctx.rowIdx, at)
    },
    deleteCol(): void {
      if (!ctx || ctx.ncols <= 1) return
      const lines = ctx.lines.map((cells) => pad(cells, ctx!.ncols, ' ').filter((_, i) => i !== ctx!.colIdx))
      rewrite(lines, ctx.rowIdx, Math.min(ctx.colIdx, ctx.ncols - 2))
    },
    align(a: Align): void {
      if (!ctx) return
      const lines = ctx.lines.map((cells) => cells.slice())
      lines[1] = pad(lines[1], ctx.ncols, '---')
      lines[1][ctx.colIdx] = delimiterCell(a)
      rewrite(lines, ctx.rowIdx, ctx.colIdx)
    },
    deleteTable(): void {
      if (!ctx) return
      // Drop the table plus one trailing newline if present.
      const end = view.state.doc.sliceString(ctx.to, ctx.to + 1) === '\n' ? ctx.to + 1 : ctx.to
      view.dispatch({ changes: { from: ctx.from, to: end, insert: '' } })
      view.focus()
    }
  }

  const button = (label: string, tip: string, run: () => void): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.className = 'cm-tb-btn'
    btn.textContent = label
    btn.setAttribute('data-tip', tip)
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', () => run())
    return btn
  }

  const sep = (): HTMLElement => {
    const s = document.createElement('span')
    s.className = 'cm-tb-sep'
    return s
  }

  bar.append(
    button('＋↑', 'Ligne au-dessus', () => ops.addRow(false)),
    button('＋↓', 'Ligne en dessous', () => ops.addRow(true)),
    button('⌫', 'Supprimer la ligne', () => ops.deleteRow()),
    sep(),
    button('＋←', 'Colonne à gauche', () => ops.addCol(false)),
    button('＋→', 'Colonne à droite', () => ops.addCol(true)),
    button('⌦', 'Supprimer la colonne', () => ops.deleteCol()),
    sep(),
    button('⯇', 'Aligner à gauche', () => ops.align('left')),
    button('≡', 'Centrer', () => ops.align('center')),
    button('⯈', 'Aligner à droite', () => ops.align('right')),
    sep(),
    button('🗑', 'Supprimer le tableau', () => ops.deleteTable())
  )

  const update = (): void => {
    ctx = view.hasFocus ? tableContext(view) : null
    if (!ctx) {
      bar.style.display = 'none'
      return
    }
    const coords = view.coordsAtPos(ctx.from)
    if (!coords) {
      bar.style.display = 'none'
      return
    }
    bar.style.display = 'flex'
    bar.style.top = `${Math.max(4, coords.top + window.scrollY - bar.offsetHeight - 6)}px`
    bar.style.left = `${coords.left + window.scrollX}px`
  }

  return { update }
}
