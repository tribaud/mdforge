/*
 * MDForge — GitHub-style alerts.
 *
 * GitHub renders blockquotes whose first line is `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` as coloured callouts.
 * remark-gfm keeps them as ordinary blockquotes, so we style them with
 * ProseMirror decorations. This changes nothing in the document model, so
 * the Markdown (`> [!NOTE]`) round-trips untouched.
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const
const ALERT_RE = new RegExp(`^\\s*\\[!(${ALERT_TYPES.join('|')})\\]`, 'i')

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
        })
        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
})
