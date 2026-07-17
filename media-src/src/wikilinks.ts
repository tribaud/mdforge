/*
 * MDForge — wikilinks.
 *
 * Renders `[[target]]` and `[[target|alias]]` as clickable links via
 * decorations (no document-model change → the Markdown round-trips). Clicking
 * one asks the extension host to open the target file. The `[[ ]]` markers stay
 * visible for now; hiding them while editing can come later.
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

export function wikilinks(onOpen: (target: string) => void) {
  return $prose(() => {
    return new Plugin({
      key: new PluginKey('MDFORGE_WIKILINKS'),
      props: {
        decorations: (state) => {
          const decorations: Decoration[] = []
          state.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return
            const text = node.text
            WIKILINK_RE.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = WIKILINK_RE.exec(text))) {
              const from = pos + match.index
              const to = from + match[0].length
              decorations.push(
                Decoration.inline(from, to, {
                  class: 'mdforge-wikilink',
                  'data-target': match[1].trim()
                })
              )
            }
          })
          return DecorationSet.create(state.doc, decorations)
        },
        handleDOMEvents: {
          mousedown: (_view, event) => {
            const el = (event.target as HTMLElement | null)?.closest?.('.mdforge-wikilink') as
              | HTMLElement
              | null
            const target = el?.getAttribute('data-target')
            if (!target) return false
            event.preventDefault()
            onOpen(target)
            return true
          }
        }
      }
    })
  })
}
