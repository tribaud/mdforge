/*
 * MDForge — top-toolbar format popup.
 *
 * Opens the same formatting controls as the floating selection toolbar
 * (bold/italic/headings/quote/list/code block…) in a popup anchored under a
 * top-toolbar button, applied to the current selection. Reuses `formatEntries`
 * so the two menus never drift apart.
 */
import type { EditorView } from '@milkdown/prose/view'
import { formatEntries } from './toolbar'

/** Returns a `toggle(anchor)` that opens/closes the format popup under `anchor`. */
export function makeFormatMenu(
  getView: () => EditorView | null
): (anchor: HTMLElement) => void {
  let popup: HTMLElement | null = null
  const buttons: Array<{ el: HTMLElement; active?: (state: unknown) => boolean }> = []

  const refresh = (): void => {
    const view = getView()
    if (!view) return
    for (const b of buttons) b.el.classList.toggle('active', Boolean(b.active?.(view.state)))
  }

  const onDocMouseDown = (event: MouseEvent): void => {
    if (popup && event.target instanceof Node && !popup.contains(event.target)) close()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  function close(): void {
    if (!popup) return
    document.removeEventListener('mousedown', onDocMouseDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    popup.remove()
    popup = null
    buttons.length = 0
  }

  const build = (): HTMLElement => {
    const el = document.createElement('div')
    el.className = 'mdforge-format-popup'
    for (const entry of formatEntries) {
      if (entry === 'separator') {
        const sep = document.createElement('span')
        sep.className = 'mdforge-toolbar-sep'
        el.appendChild(sep)
        continue
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mdforge-toolbar-btn'
      btn.textContent = entry.label
      btn.title = entry.title
      btn.addEventListener('mousedown', (event) => event.preventDefault())
      btn.addEventListener('click', () => {
        const view = getView()
        if (!view) return
        entry.run(view)
        refresh()
        view.focus()
      })
      el.appendChild(btn)
      buttons.push({ el: btn, active: entry.active })
    }
    return el
  }

  return (anchor: HTMLElement): void => {
    if (popup) {
      close() // toggle off
      return
    }
    popup = build()
    popup.style.position = 'fixed'
    const rect = anchor.getBoundingClientRect()
    popup.style.top = `${rect.bottom + 4}px`
    popup.style.left = `${rect.left}px`
    document.body.appendChild(popup)
    // Keep the popup within the viewport's right edge.
    const overflow = popup.getBoundingClientRect().right - window.innerWidth + 8
    if (overflow > 0) popup.style.left = `${rect.left - overflow}px`
    refresh()
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onKeyDown, true)
  }
}
