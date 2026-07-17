/*
 * MDForge — draggable block handle.
 *
 * @milkdown/plugin-block shows a drag handle to the left of the block under
 * the cursor/mouse; dragging it reorders blocks. We just provide the handle
 * element and a BlockProvider to position it.
 */
import { block, BlockProvider } from '@milkdown/plugin-block'

export { block }

export const blockView = (ctx: any) => () => {
  const content = document.createElement('div')
  content.className = 'mdforge-block-handle'
  content.setAttribute('aria-label', 'Drag to move block')
  content.draggable = true
  content.textContent = '⠿'

  const provider = new BlockProvider({ ctx, content })

  return {
    update: () => provider.update(),
    destroy: () => provider.destroy()
  }
}
