/*
 * MDForge — footnotes.
 *
 * The GFM preset already parses and renders footnote references (`[^1]`) and
 * definitions, so this only adds the interaction GitHub has: clicking a
 * reference scrolls to its definition. Styling lives in github-theme.css.
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'

export const footnoteJump = $prose(() => {
  return new Plugin({
    key: new PluginKey('MDFORGE_FOOTNOTE_JUMP'),
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null
          const ref = target?.closest('sup[data-type="footnote_reference"]') as HTMLElement | null
          if (!ref) return false
          const label = ref.dataset.label ?? ''
          const definition = view.dom.querySelector(
            `dl[data-type="footnote_definition"][data-label="${CSS.escape(label)}"]`
          )
          if (!definition) return false
          event.preventDefault()
          ;(definition as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' })
          return true
        }
      }
    }
  })
})
