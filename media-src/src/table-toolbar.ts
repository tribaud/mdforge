/*
 * MDForge — table toolbar (floating).
 *
 * Milkdown/GFM ships every table command (add/delete row & column, alignment)
 * but no UI, so a table is otherwise a trap: you can type in cells but cannot
 * add rows, drop a column, or delete the whole thing. This floating toolbar
 * appears whenever the caret sits in a table (or cells are selected) and wires
 * those commands to buttons — the same tooltip-provider pattern as the
 * selection bubble.
 *
 * Structural ops use the prosemirror-tables commands directly (they act on the
 * current selection, no index needed); alignment uses Milkdown's
 * setAlignCommand (it writes the cell `alignment` attr that round-trips).
 */
import { tooltipFactory, TooltipProvider } from '@milkdown/plugin-tooltip'
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  CellSelection,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectedRect
} from '@milkdown/prose/tables'
import type { Command } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

export const tableToolbar = tooltipFactory('mdforge-table-toolbar')

const ICONS = {
  rowAbove:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="9" rx="1"/><line x1="3" y1="15.5" x2="21" y2="15.5"/><line x1="9" y1="11" x2="9" y2="20"/><line x1="15" y1="11" x2="15" y2="20"/><line x1="12" y1="3" x2="12" y2="8"/><line x1="9.5" y1="5.5" x2="12" y2="3"/><line x1="14.5" y1="5.5" x2="12" y2="3"/></svg>',
  rowBelow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="9" rx="1"/><line x1="3" y1="8.5" x2="21" y2="8.5"/><line x1="9" y1="4" x2="9" y2="13"/><line x1="15" y1="4" x2="15" y2="13"/><line x1="12" y1="16" x2="12" y2="21"/><line x1="9.5" y1="18.5" x2="12" y2="21"/><line x1="14.5" y1="18.5" x2="12" y2="21"/></svg>',
  rowDelete:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4.5" rx="1"/><rect x="3" y="15.5" width="18" height="4.5" rx="1"/><line x1="7" y1="12" x2="17" y2="12" stroke-width="2.4"/></svg>',
  colLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="11" y="3" width="9" height="18" rx="1"/><line x1="15.5" y1="3" x2="15.5" y2="21"/><line x1="11" y1="9" x2="20" y2="9"/><line x1="11" y1="15" x2="20" y2="15"/><line x1="3" y1="12" x2="8" y2="12"/><line x1="5.5" y1="9.5" x2="3" y2="12"/><line x1="5.5" y1="14.5" x2="3" y2="12"/></svg>',
  colRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="9" height="18" rx="1"/><line x1="8.5" y1="3" x2="8.5" y2="21"/><line x1="4" y1="9" x2="13" y2="9"/><line x1="4" y1="15" x2="13" y2="15"/><line x1="16" y1="12" x2="21" y2="12"/><line x1="18.5" y1="9.5" x2="21" y2="12"/><line x1="18.5" y1="14.5" x2="21" y2="12"/></svg>',
  colDelete:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="4.5" height="18" rx="1"/><rect x="15.5" y="3" width="4.5" height="18" rx="1"/><line x1="12" y1="7" x2="12" y2="17" stroke-width="2.4"/></svg>',
  alignLeft:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="17" y2="18"/></svg>',
  alignCenter:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/></svg>',
  alignRight:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="7" y1="18" x2="20" y2="18"/></svg>',
  tableDelete:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
}

/** Run a plain prosemirror-tables command against the current view. */
function runCommand(view: EditorView, command: Command): void {
  command(view.state, view.dispatch, view)
  view.focus()
}

/**
 * Set the alignment of the whole column(s) the selection touches.
 *
 * GFM stores alignment on every cell but a plugin force-syncs each body cell to
 * its header cell on every change — so setting only the body cell at the caret
 * (what setCellAttr does) is instantly reverted. We write every cell in the
 * column, header included, so it sticks and stays consistent.
 */
function setColumnAlign(view: EditorView, align: 'left' | 'center' | 'right'): void {
  const { state } = view
  if (!isInTable(state)) return
  let rect
  try {
    rect = selectedRect(state)
  } catch {
    return
  }
  const { map, table, tableStart } = rect
  const tr = state.tr
  const done = new Set<number>()
  for (let col = rect.left; col < rect.right; col++) {
    for (let row = 0; row < map.height; row++) {
      const offset = map.map[row * map.width + col]
      if (done.has(offset)) continue // spanning cell already handled
      done.add(offset)
      const node = table.nodeAt(offset)
      if (node && node.attrs.alignment !== align) {
        tr.setNodeMarkup(tableStart + offset, undefined, { ...node.attrs, alignment: align })
      }
    }
  }
  if (tr.docChanged) view.dispatch(tr)
  view.focus()
}

/** Alignment of the cell holding the caret (for the active-button state). */
function currentAlign(state: any): 'left' | 'center' | 'right' | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
      return (node.attrs.alignment as 'left' | 'center' | 'right') ?? null
    }
  }
  return null
}

interface Btn {
  title: string
  icon: string
  run: (view: EditorView) => void
  active?: (state: any) => boolean
  danger?: boolean
}

type Entry = Btn | 'separator'

const ENTRIES: Entry[] = [
  { title: 'Insert row above', icon: ICONS.rowAbove, run: (v) => runCommand(v, addRowBefore) },
  { title: 'Insert row below', icon: ICONS.rowBelow, run: (v) => runCommand(v, addRowAfter) },
  {
    title: 'Delete current row (not the header row)',
    icon: ICONS.rowDelete,
    run: (v) => runCommand(v, deleteRow),
    danger: true
  },
  'separator',
  { title: 'Insert column left', icon: ICONS.colLeft, run: (v) => runCommand(v, addColumnBefore) },
  { title: 'Insert column right', icon: ICONS.colRight, run: (v) => runCommand(v, addColumnAfter) },
  { title: 'Delete current column', icon: ICONS.colDelete, run: (v) => runCommand(v, deleteColumn), danger: true },
  'separator',
  {
    title: 'Align column left',
    icon: ICONS.alignLeft,
    run: (v) => setColumnAlign(v, 'left'),
    active: (s) => currentAlign(s) === 'left'
  },
  {
    title: 'Align column center',
    icon: ICONS.alignCenter,
    run: (v) => setColumnAlign(v, 'center'),
    active: (s) => currentAlign(s) === 'center'
  },
  {
    title: 'Align column right',
    icon: ICONS.alignRight,
    run: (v) => setColumnAlign(v, 'right'),
    active: (s) => currentAlign(s) === 'right'
  },
  'separator',
  { title: 'Delete table', icon: ICONS.tableDelete, run: (v) => runCommand(v, deleteTable), danger: true }
]

class TableToolbarView {
  private readonly content: HTMLElement
  private readonly provider: TooltipProvider
  private readonly buttons: Array<{ el: HTMLElement; active?: (state: any) => boolean }> = []
  private view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.content = document.createElement('div')
    this.content.className = 'mdforge-table-toolbar'

    for (const entry of ENTRIES) {
      if (entry === 'separator') {
        const sep = document.createElement('span')
        sep.className = 'mdforge-toolbar-sep'
        this.content.appendChild(sep)
        continue
      }
      const el = document.createElement('button')
      el.type = 'button'
      el.className = entry.danger
        ? 'mdforge-toolbar-btn mdforge-toolbar-btn-danger'
        : 'mdforge-toolbar-btn'
      el.title = entry.title
      el.setAttribute('aria-label', entry.title)
      // Custom CSS tooltip (data-tip) as well — native title tooltips are
      // unreliable/slow inside the VS Code webview.
      el.setAttribute('data-tip', entry.title)
      el.innerHTML = entry.icon
      el.addEventListener('mousedown', (event) => {
        event.preventDefault()
        entry.run(this.view)
        this.refresh(this.view.state)
      })
      this.content.appendChild(el)
      this.buttons.push({ el, active: entry.active })
    }

    this.provider = new TooltipProvider({
      content: this.content,
      shouldShow: (v) => this.shouldShow(v),
      offset: 8
    })
  }

  private shouldShow(view: EditorView): boolean {
    if (!isInTable(view.state)) return false
    const { selection } = view.state
    // Cells selected → show (so you can drop the selected rows/columns).
    if (selection instanceof CellSelection) return true
    // A text selection inside a cell belongs to the format bubble; only take
    // over on a collapsed caret so the two toolbars never fight for the spot.
    return selection.empty
  }

  private refresh(state: any): void {
    for (const { el, active } of this.buttons) {
      el.classList.toggle('active', Boolean(active?.(state)))
    }
  }

  update(view: EditorView, prevState: any): void {
    this.view = view
    this.provider.update(view, prevState)
    this.refresh(view.state)
  }

  destroy(): void {
    this.provider.destroy()
  }
}

export const tableToolbarPluginView = (view: EditorView) => new TableToolbarView(view)
