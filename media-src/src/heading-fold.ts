/*
 * MDForge — in-document heading folding.
 *
 * ProseMirror keeps headings flat (siblings, not nested), so folding a heading
 * means hiding every following top-level block until the next heading of the
 * same or a higher level. This is decoration-based and therefore
 * non-destructive: the Markdown is never touched.
 *
 * A hover chevron on each heading toggles its folded state; folded state is
 * kept in plugin state and mapped through edits so it survives typing.
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const foldKey = new PluginKey<{ folded: Set<number> }>('mdforge-heading-fold')

/** Chevron button rendered at the start of a foldable heading. */
function foldToggle(view: any, getPos: () => number | undefined, folded: boolean): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'mdforge-fold-toggle' + (folded ? ' folded' : '')
  btn.type = 'button'
  btn.contentEditable = 'false'
  btn.setAttribute('aria-label', folded ? 'Unfold section' : 'Fold section')
  btn.textContent = folded ? '▸' : '▾'
  btn.addEventListener('mousedown', (event) => event.preventDefault())
  btn.addEventListener('click', (event) => {
    event.preventDefault()
    const pos = getPos()
    if (pos == null) return
    // The widget sits just inside the heading; its start is one before.
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: pos - 1 }))
  })
  return btn
}

/** Build fold decorations: a chevron per heading + hidden blocks under folds. */
function buildDecorations(state: any, folded: Set<number>): DecorationSet {
  const children: Array<{ node: any; offset: number }> = []
  state.doc.forEach((node: any, offset: number) => children.push({ node, offset }))

  const decos: Decoration[] = []
  for (let i = 0; i < children.length; i += 1) {
    const { node, offset } = children[i]
    if (node.type.name !== 'heading') continue
    const isFolded = folded.has(offset)

    decos.push(
      Decoration.widget(offset + 1, (view, getPos) => foldToggle(view, getPos, isFolded), {
        side: -1,
        key: `fold-toggle-${offset}-${isFolded}`
      })
    )

    if (!isFolded) continue
    const level = node.attrs.level
    for (let j = i + 1; j < children.length; j += 1) {
      const next = children[j]
      if (next.node.type.name === 'heading' && next.node.attrs.level <= level) break
      decos.push(
        Decoration.node(next.offset, next.offset + next.node.nodeSize, {
          class: 'mdforge-fold-hidden'
        })
      )
    }
  }
  return DecorationSet.create(state.doc, decos)
}

export const headingFold = $prose(
  () =>
    new Plugin({
      key: foldKey,
      state: {
        init: () => ({ folded: new Set<number>() }),
        apply(tr, value) {
          let folded = value.folded
          if (tr.docChanged) {
            const mapped = new Set<number>()
            for (const pos of folded) {
              const result = tr.mapping.mapResult(pos)
              if (!result.deleted) mapped.add(result.pos)
            }
            folded = mapped
          }
          const meta = tr.getMeta(foldKey) as { toggle?: number } | undefined
          if (meta?.toggle != null) {
            folded = new Set(folded)
            if (folded.has(meta.toggle)) folded.delete(meta.toggle)
            else folded.add(meta.toggle)
          }
          return { folded }
        }
      },
      props: {
        decorations(state) {
          const value = foldKey.getState(state)
          return value ? buildDecorations(state, value.folded) : null
        }
      }
    })
)
