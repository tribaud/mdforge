/*
 * MDForge — top toolbar.
 *
 * A persistent bar above the editor (unlike the selection bubble it is always
 * visible) for document-level actions: insert an image, localize remote /
 * embedded images into the assets folder, toggle presentation mode, and open
 * the MDForge settings. It lives outside the Milkdown root so it survives the
 * editor being recreated on external changes.
 */
import type { EditorView } from '@milkdown/prose/view'

export interface TopbarActions {
  getView: () => EditorView | null
  insertImage: (view: EditorView) => void
  localizeAssets: () => void
  renameNote: () => void
  toggleSource: () => void
  togglePresentation: () => void
  openSettings: () => void
}

const ICONS = {
  image:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  localize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 17l4 4 4-4"/><path d="M12 12v9"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>',
  present:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  rename:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  source:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
}

interface TopbarButton {
  title: string
  icon: string
  run: (actions: TopbarActions) => void
  /** Extra class for CSS targeting (e.g. keeping this button in presentation). */
  extraClass?: string
}

const LEFT: TopbarButton[] = [
  {
    title: 'Insert image',
    icon: ICONS.image,
    run: (a) => {
      const view = a.getView()
      if (view) a.insertImage(view)
    }
  },
  {
    title: 'Localize remote & embedded images into the assets folder',
    icon: ICONS.localize,
    run: (a) => a.localizeAssets()
  },
  { title: 'Rename note', icon: ICONS.rename, run: (a) => a.renameNote() }
]

const RIGHT: TopbarButton[] = [
  {
    title: 'Toggle Markdown source view',
    icon: ICONS.source,
    run: (a) => a.toggleSource(),
    extraClass: 'mdforge-topbar-btn-source'
  },
  {
    title: 'Toggle presentation mode',
    icon: ICONS.present,
    run: (a) => a.togglePresentation(),
    extraClass: 'mdforge-topbar-btn-present'
  },
  { title: 'MDForge settings', icon: ICONS.settings, run: (a) => a.openSettings() }
]

function button(def: TopbarButton, actions: TopbarActions): HTMLElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = def.extraClass ? `mdforge-topbar-btn ${def.extraClass}` : 'mdforge-topbar-btn'
  el.title = def.title
  el.setAttribute('aria-label', def.title)
  el.innerHTML = def.icon
  // Keep the editor selection when clicking a toolbar button.
  el.addEventListener('mousedown', (event) => event.preventDefault())
  el.addEventListener('click', () => def.run(actions))
  return el
}

/** Build the top toolbar element (caller inserts it above the editor root). */
export function createTopbar(actions: TopbarActions): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'mdforge-topbar'
  const inner = document.createElement('div')
  inner.className = 'mdforge-topbar-inner'

  for (const def of LEFT) inner.appendChild(button(def, actions))
  const spacer = document.createElement('span')
  spacer.className = 'mdforge-topbar-spacer'
  inner.appendChild(spacer)
  for (const def of RIGHT) inner.appendChild(button(def, actions))

  bar.appendChild(inner)
  return bar
}
