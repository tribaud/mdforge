/*
 * MDForge — slash command menu.
 *
 * Type "/" at the start of a word to open a menu of block insertions
 * (headings, lists, task lists, quote, code, table, Mermaid...). Milkdown's
 * slash plugin provides the trigger detection and positioning; the menu UI,
 * filtering and keyboard navigation are built here.
 */
import {
  createCodeBlockCommand,
  insertHrCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/preset-commonmark'
import { insertTableCommand } from '@milkdown/preset-gfm'
import { insertDiagramCommand } from '@milkdown/plugin-diagram'
import { slashFactory, SlashProvider } from '@milkdown/plugin-slash'

export const slash = slashFactory('mdforge-slash')

interface SlashItem {
  title: string
  hint: string
  keywords: string[]
  run: (view: any) => void
}

/** Run a Milkdown command by its runtime-bound `.run` method. */
function run(command: any, payload?: unknown): void {
  command?.run?.(payload)
}

/** Turn the current block into a (bullet) task list item with the given state. */
function insertTask(view: any, taskState: 'unchecked' | 'inprogress'): void {
  run(wrapInBulletListCommand)
  const state = view.state
  const { $from } = state.selection
  let depth = $from.depth
  while (depth > 0 && $from.node(depth).type.name !== 'list_item') depth--
  if (depth <= 0) return
  const node = $from.node(depth)
  const attrs =
    taskState === 'inprogress'
      ? { ...node.attrs, checked: null, inProgress: true }
      : { ...node.attrs, checked: false, inProgress: false }
  view.dispatch(state.tr.setNodeMarkup($from.before(depth), undefined, attrs))
}

const ITEMS: SlashItem[] = [
  { title: 'Heading 1', hint: 'Big section heading', keywords: ['h1', 'title', 'heading'], run: () => run(wrapInHeadingCommand, 1) },
  { title: 'Heading 2', hint: 'Medium section heading', keywords: ['h2', 'heading'], run: () => run(wrapInHeadingCommand, 2) },
  { title: 'Heading 3', hint: 'Small section heading', keywords: ['h3', 'heading'], run: () => run(wrapInHeadingCommand, 3) },
  { title: 'Bullet list', hint: 'Unordered list', keywords: ['ul', 'bullet', 'list', 'unordered'], run: () => run(wrapInBulletListCommand) },
  { title: 'Numbered list', hint: 'Ordered list', keywords: ['ol', 'ordered', 'number', 'list'], run: () => run(wrapInOrderedListCommand) },
  { title: 'Task list', hint: 'Checkbox to-do item', keywords: ['task', 'todo', 'checkbox', 'check'], run: (view) => insertTask(view, 'unchecked') },
  { title: 'In-progress task', hint: 'Checkbox marked [~]', keywords: ['wip', 'progress', 'doing', 'task'], run: (view) => insertTask(view, 'inprogress') },
  { title: 'Quote', hint: 'Blockquote', keywords: ['quote', 'blockquote', 'citation'], run: () => run(wrapInBlockquoteCommand) },
  { title: 'Code block', hint: 'Fenced code with syntax highlight', keywords: ['code', 'pre', 'fence', 'snippet'], run: () => run(createCodeBlockCommand, '') },
  { title: 'Divider', hint: 'Horizontal rule', keywords: ['hr', 'rule', 'divider', 'separator'], run: () => run(insertHrCommand) },
  { title: 'Table', hint: 'Insert a table', keywords: ['table', 'grid'], run: () => run(insertTableCommand) },
  { title: 'Mermaid diagram', hint: 'Flowchart / diagram', keywords: ['mermaid', 'diagram', 'graph', 'flowchart'], run: () => run(insertDiagramCommand) }
]

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return ITEMS
  return ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) || item.keywords.some((keyword) => keyword.includes(q))
  )
}

class SlashMenuView {
  private readonly content: HTMLElement
  private readonly list: HTMLElement
  private readonly provider: SlashProvider
  private readonly onKeyDown: (event: KeyboardEvent) => void
  private editorView: any
  private visible = false
  private query = ''
  private filtered: SlashItem[] = []
  private selected = 0

  constructor(view: any) {
    this.editorView = view

    this.content = document.createElement('div')
    this.content.className = 'mdforge-slash'
    this.content.dataset.show = 'false'
    this.list = document.createElement('div')
    this.list.className = 'mdforge-slash-list'
    this.content.appendChild(this.list)
    // Keep the editor selection while interacting with the menu.
    this.content.addEventListener('mousedown', (event) => event.preventDefault())

    this.provider = new SlashProvider({
      content: this.content,
      trigger: '/',
      shouldShow: (v) => this.shouldShow(v)
    })
    this.provider.onShow = () => {
      this.visible = true
    }
    this.provider.onHide = () => {
      this.visible = false
    }

    this.onKeyDown = (event) => this.handleKeyDown(event)
    view.dom.addEventListener('keydown', this.onKeyDown, true)
  }

  private shouldShow(view: any): boolean {
    const before = this.provider.getContent(view)
    if (before == null) return false
    const match = /(?:^|\s)\/([^\s/]*)$/.exec(before)
    if (!match) return false
    this.query = match[1] ?? ''
    this.filtered = filterItems(this.query)
    if (this.filtered.length === 0) return false
    this.selected = 0
    this.renderList()
    return true
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.filtered.map((item, index) => {
        const el = document.createElement('div')
        el.className = 'mdforge-slash-item' + (index === this.selected ? ' selected' : '')
        const title = document.createElement('span')
        title.className = 'mdforge-slash-title'
        title.textContent = item.title
        const hint = document.createElement('span')
        hint.className = 'mdforge-slash-hint'
        hint.textContent = item.hint
        el.append(title, hint)
        el.addEventListener('mousedown', (event) => {
          event.preventDefault()
          this.execute(item)
        })
        el.addEventListener('mouseenter', () => {
          this.selected = index
          this.updateSelection()
        })
        return el
      })
    )
  }

  private updateSelection(): void {
    Array.from(this.list.children).forEach((child, index) =>
      child.classList.toggle('selected', index === this.selected)
    )
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' })
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.visible || this.filtered.length === 0) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        event.stopPropagation()
        this.selected = (this.selected + 1) % this.filtered.length
        this.updateSelection()
        break
      case 'ArrowUp':
        event.preventDefault()
        event.stopPropagation()
        this.selected = (this.selected - 1 + this.filtered.length) % this.filtered.length
        this.updateSelection()
        break
      case 'Enter': {
        event.preventDefault()
        event.stopPropagation()
        const item = this.filtered[this.selected]
        if (item) this.execute(item)
        break
      }
      case 'Escape':
        event.preventDefault()
        this.provider.hide()
        break
    }
  }

  /** Remove the typed "/query" then run the item's command. */
  private execute(item: SlashItem): void {
    const view = this.editorView
    const before = this.provider.getContent(view)
    if (before != null) {
      const slashIndex = before.lastIndexOf('/')
      if (slashIndex !== -1) {
        const to = view.state.selection.from
        const from = to - (before.length - slashIndex)
        view.dispatch(view.state.tr.delete(from, to))
      }
    }
    this.provider.hide()
    item.run(view)
    view.focus()
  }

  update(view: any, prevState: any): void {
    this.editorView = view
    this.provider.update(view, prevState)
  }

  destroy(): void {
    this.editorView?.dom.removeEventListener('keydown', this.onKeyDown, true)
    this.provider.destroy()
  }
}

export const slashPluginView = (view: any) => new SlashMenuView(view)
