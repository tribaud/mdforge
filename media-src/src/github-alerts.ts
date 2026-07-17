/*
 * MDForge — GitHub-style alerts.
 *
 * GitHub renders blockquotes whose first line is `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` as coloured callouts.
 * remark-gfm keeps them as ordinary blockquotes, so we style them with
 * ProseMirror decorations (no document-model change → the Markdown
 * round-trips).
 *
 * Every blockquote gets a type dropdown (empty by default) so you can turn any
 * quote into an alert — or change/remove its type. When a type is set, the
 * `[!TYPE]` marker text is hidden since the dropdown already shows it.
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const
const ALERT_RE = new RegExp(`^\\s*\\[!(${ALERT_TYPES.join('|')})\\]`, 'i')

/** Locate the `[!TYPE]` marker within a blockquote's first paragraph text. */
function markerRange(text: string): { from: number; to: number } | null {
  const start = text.indexOf('[!')
  if (start === -1) return null
  const end = text.indexOf(']', start)
  if (end === -1) return null
  let to = end + 1
  if (text[to] === ' ') to += 1 // swallow one trailing space
  return { from: start, to }
}

/** Change/insert/remove the alert type on the blockquote at `pos`. */
function setAlertType(view: any, pos: number, newType: string): void {
  const blockquote = view.state.doc.nodeAt(pos)
  if (!blockquote || blockquote.type.name !== 'blockquote') return
  const paragraph = blockquote.firstChild
  if (!paragraph) return
  const contentStart = pos + 2 // blockquote open + paragraph open
  const range = markerRange(paragraph.textContent)
  const tr = view.state.tr
  if (range) {
    const from = contentStart + range.from
    const to = contentStart + range.to
    if (newType) tr.insertText(`[!${newType.toUpperCase()}] `, from, to)
    else tr.delete(from, to)
  } else if (newType) {
    tr.insertText(`[!${newType.toUpperCase()}] `, contentStart)
  } else {
    return
  }
  view.dispatch(tr)
  view.focus()
}

function buildTypeSelect(view: any, pos: number, currentType: string): HTMLElement {
  const select = document.createElement('select')
  select.className = 'mdforge-alert-select' + (currentType ? '' : ' mdforge-alert-select-empty')
  select.contentEditable = 'false'
  select.title = 'Alert type'
  const options: Array<[string, string]> = [['', '—'], ...ALERT_TYPES.map((t) => [t, t.toUpperCase()] as [string, string])]
  for (const [value, label] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    if (value === currentType) option.selected = true
    select.appendChild(option)
  }
  select.addEventListener('mousedown', (event) => event.stopPropagation())
  select.addEventListener('change', () => setAlertType(view, pos, select.value))
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
          const type = match ? match[1].toLowerCase() : ''

          // Type dropdown on every blockquote (empty default).
          decorations.push(
            Decoration.widget(pos + 1, (view) => buildTypeSelect(view, pos, type), {
              side: -1,
              ignoreSelection: true,
              key: `mdforge-alert-select-${pos}-${type || 'none'}`
            })
          )

          if (type) {
            decorations.push(
              Decoration.node(pos, pos + node.nodeSize, {
                class: `mdforge-alert mdforge-alert-${type}`
              })
            )
            // Hide the `[!TYPE]` marker text; the dropdown conveys the type.
            const paragraph = node.firstChild
            const range = paragraph ? markerRange(paragraph.textContent) : null
            if (range) {
              const contentStart = pos + 2
              decorations.push(
                Decoration.inline(contentStart + range.from, contentStart + range.to, {
                  class: 'mdforge-alert-marker-hidden'
                })
              )
            }
          }
          return false
        })
        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
})
