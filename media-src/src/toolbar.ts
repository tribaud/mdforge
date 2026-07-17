/*
 * MDForge — selection toolbar (bubble menu).
 *
 * Milkdown is headless, so there is no UI to toggle or change an existing
 * format. This floating toolbar appears on a text selection and lets you turn
 * marks on/off (bold, italic, strikethrough, inline code) and change the block
 * type (paragraph, headings, quote, bullet list). Buttons show an active state
 * so you can see — and remove — the current formatting.
 */
import {
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand
} from '@milkdown/preset-commonmark'
import { toggleStrikethroughCommand } from '@milkdown/preset-gfm'
import { tooltipFactory, TooltipProvider } from '@milkdown/plugin-tooltip'
import { TextSelection } from '@milkdown/prose/state'
import { lift } from '@milkdown/prose/commands'

export const toolbar = tooltipFactory('mdforge-toolbar')

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/** Render a Milkdown "Mod-Alt-x" shortcut for the current platform. */
function formatShortcut(shortcut: string): string {
  const parts = shortcut.split('-').map((part) => {
    if (part === 'Mod') return isMac ? '⌘' : 'Ctrl'
    if (part === 'Alt') return isMac ? '⌥' : 'Alt'
    if (part === 'Shift') return isMac ? '⇧' : 'Shift'
    return part.toUpperCase()
  })
  return parts.join(isMac ? '' : '+')
}

function run(command: any, payload?: unknown): void {
  command?.run?.(payload)
}

function markActive(state: any, name: string): boolean {
  const type = state.schema.marks[name]
  if (!type) return false
  const { from, to, empty, $from } = state.selection
  if (empty) return Boolean(type.isInSet(state.storedMarks || $from.marks()))
  return state.doc.rangeHasMark(from, to, type)
}

function headingActive(state: any, level: number): boolean {
  const parent = state.selection.$from.parent
  return parent.type.name === 'heading' && parent.attrs.level === level
}

function blockActive(state: any, name: string): boolean {
  return state.selection.$from.parent.type.name === name
}

function ancestorActive(state: any, name: string): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === name) return true
  }
  return false
}

interface Btn {
  label: string
  title: string
  shortcut?: string
  run: (view: any) => void
  active?: (state: any) => boolean
}

type Entry = Btn | 'separator'

const ENTRIES: Entry[] = [
  { label: 'B', title: 'Bold', shortcut: 'Mod-b', run: () => run(toggleStrongCommand), active: (s) => markActive(s, 'strong') },
  { label: 'I', title: 'Italic', shortcut: 'Mod-i', run: () => run(toggleEmphasisCommand), active: (s) => markActive(s, 'emphasis') },
  { label: 'S', title: 'Strikethrough', shortcut: 'Mod-Alt-x', run: () => run(toggleStrikethroughCommand), active: (s) => markActive(s, 'strike_through') },
  { label: '</>', title: 'Inline code', shortcut: 'Mod-e', run: () => run(toggleInlineCodeCommand), active: (s) => markActive(s, 'inlineCode') },
  'separator',
  { label: 'P', title: 'Paragraph', shortcut: 'Mod-Alt-0', run: () => run(turnIntoTextCommand), active: (s) => blockActive(s, 'paragraph') },
  { label: 'H1', title: 'Heading 1', shortcut: 'Mod-Alt-1', run: () => run(wrapInHeadingCommand, 1), active: (s) => headingActive(s, 1) },
  { label: 'H2', title: 'Heading 2', shortcut: 'Mod-Alt-2', run: () => run(wrapInHeadingCommand, 2), active: (s) => headingActive(s, 2) },
  { label: 'H3', title: 'Heading 3', shortcut: 'Mod-Alt-3', run: () => run(wrapInHeadingCommand, 3), active: (s) => headingActive(s, 3) },
  'separator',
  {
    label: '❝',
    title: 'Quote',
    shortcut: 'Mod-Shift-b',
    // Toggle: lift out of the blockquote when already inside one.
    run: (view) => {
      if (ancestorActive(view.state, 'blockquote')) lift(view.state, view.dispatch)
      else run(wrapInBlockquoteCommand)
    },
    active: (s) => ancestorActive(s, 'blockquote')
  },
  { label: '•', title: 'Bullet list', shortcut: 'Mod-Alt-8', run: () => run(wrapInBulletListCommand), active: (s) => ancestorActive(s, 'bullet_list') }
]

class ToolbarView {
  private readonly content: HTMLElement
  private readonly provider: TooltipProvider
  private readonly buttons: Array<{ el: HTMLElement; active?: (state: any) => boolean }> = []
  private view: any

  constructor(view: any) {
    this.view = view
    this.content = document.createElement('div')
    this.content.className = 'mdforge-toolbar'

    for (const entry of ENTRIES) {
      if (entry === 'separator') {
        const sep = document.createElement('span')
        sep.className = 'mdforge-toolbar-sep'
        this.content.appendChild(sep)
        continue
      }
      const el = document.createElement('button')
      el.className = 'mdforge-toolbar-btn'
      el.type = 'button'
      el.textContent = entry.label
      el.title = entry.shortcut ? `${entry.title} (${formatShortcut(entry.shortcut)})` : entry.title
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
      shouldShow: (v) => this.shouldShow(v)
    })
  }

  private shouldShow(view: any): boolean {
    const { selection } = view.state
    if (selection.empty) return false
    if (!(selection instanceof TextSelection)) return false
    if (selection.$from.parent.type.spec.code) return false
    return true
  }

  private refresh(state: any): void {
    for (const { el, active } of this.buttons) {
      el.classList.toggle('active', Boolean(active?.(state)))
    }
  }

  update(view: any, prevState: any): void {
    this.view = view
    this.provider.update(view, prevState)
    this.refresh(view.state)
  }

  destroy(): void {
    this.provider.destroy()
  }
}

export const toolbarPluginView = (view: any) => new ToolbarView(view)
