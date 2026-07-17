/*
 * MDForge — GitHub-style alerts.
 *
 * GitHub renders blockquotes whose first line is `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` as coloured callouts.
 * remark-gfm keeps them as ordinary blockquotes, so we style them with
 * ProseMirror decorations (no document-model change → the Markdown
 * round-trips). A small dropdown lets you change the alert type.
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const
const ALERT_RE = new RegExp(`^\\s*\\[!(${ALERT_TYPES.join('|')})\\]`, 'i')

/** Build the type <select> shown on an alert; changing it rewrites `[!TYPE]`. */
function buildTypeSelect(view: any, blockquotePos: number, currentType: string): HTMLElement {
  const select = document.createElement('select')
  select.className = 'mdforge-alert-select'
  select.contentEditable = 'false'
  for (const type of ALERT_TYPES) {
    const option = document.createElement('option')
    option.value = type
    option.textContent = type.toUpperCase()
    if (type === currentType) option.selected = true
    select.appendChild(option)
  }
  // Don't let interacting with the control move the editor selection.
  select.addEventListener('mousedown', (event) => event.stopPropagation())
  select.addEventListener('change', () => {
    const blockquote = view.state.doc.nodeAt(blockquotePos)
    if (!blockquote || blockquote.type.name !== 'blockquote') return
    const paragraph = blockquote.firstChild
    if (!paragraph) return
    const text = paragraph.textContent
    const start = text.indexOf('[!')
    const end = text.indexOf(']', start)
    if (start === -1 || end === -1) return
    // paragraph content starts at blockquotePos + 2 (blockquote open + paragraph open)
    const contentStart = blockquotePos + 2
    const from = contentStart + start
    const to = contentStart + end + 1
    const marker = `[!${select.value.toUpperCase()}]`
    view.dispatch(view.state.tr.insertText(marker, from, to))
    view.focus()
  })
  return select
}

export const githubAlert = $prose(() => {
  return new Plugin({
    key: new PluginKey('MDFORGE_GITHUB_ALERT'),
    props: {
      decorations: (state) => {
        const decorations: Decoration[] = []
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'blockquote') return
          const match = ALERT_RE.exec(node.textContent)
          if (!match) return
          const type = match[1].toLowerCase()
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: `mdforge-alert mdforge-alert-${type}`
            })
          )
          decorations.push(
            Decoration.widget(pos + 1, (view) => buildTypeSelect(view, pos, type), {
              side: -1,
              ignoreSelection: true,
              key: `mdforge-alert-select-${pos}-${type}`
            })
          )
          return false
        })
        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
})
