/*
 * MDForge — image dialog.
 *
 * A small modal used both to insert a new image and to edit an existing one:
 * a path/URL field, an alt-text field, and an optional "Browse…" button that
 * opens the OS file picker (the chosen file is saved and its link filled in).
 */
export interface ImageDialogOptions {
  title: string
  submitLabel: string
  src?: string
  alt?: string
  /** Called with a `fill` callback that sets the path field once a file saves. */
  onBrowse?: (fill: (src: string) => void) => void
  onSubmit: (result: { src: string; alt: string }) => void
}

function field(labelText: string, value: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('label')
  row.className = 'mdforge-modal-field'
  const label = document.createElement('span')
  label.className = 'mdforge-modal-label'
  label.textContent = labelText
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'mdforge-modal-input'
  input.value = value
  row.append(label, input)
  return { row, input }
}

export function openImageDialog(options: ImageDialogOptions): void {
  const overlay = document.createElement('div')
  overlay.className = 'mdforge-modal-overlay'
  const modal = document.createElement('div')
  modal.className = 'mdforge-modal'

  const heading = document.createElement('div')
  heading.className = 'mdforge-modal-title'
  heading.textContent = options.title

  const src = field('Path or URL', options.src ?? '')
  const alt = field('Alt text', options.alt ?? '')

  const actions = document.createElement('div')
  actions.className = 'mdforge-modal-actions'

  const close = (): void => {
    document.removeEventListener('keydown', onKeyDown, true)
    overlay.remove()
  }
  const submit = (): void => {
    options.onSubmit({ src: src.input.value.trim(), alt: alt.input.value })
    close()
  }

  if (options.onBrowse) {
    const browse = document.createElement('button')
    browse.type = 'button'
    browse.className = 'mdforge-modal-btn'
    browse.textContent = 'Browse…'
    browse.addEventListener('click', () =>
      options.onBrowse?.((value) => {
        src.input.value = value
        src.input.focus()
      })
    )
    actions.appendChild(browse)
  }

  const spacer = document.createElement('span')
  spacer.className = 'mdforge-modal-spacer'
  actions.appendChild(spacer)

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'mdforge-modal-btn'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', close)

  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'mdforge-modal-btn mdforge-modal-btn-primary'
  ok.textContent = options.submitLabel
  ok.addEventListener('click', submit)

  actions.append(cancel, ok)
  modal.append(heading, src.row, alt.row, actions)
  overlay.appendChild(modal)

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter' && event.target !== cancel) {
      event.preventDefault()
      submit()
    }
  }
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  document.addEventListener('keydown', onKeyDown, true)

  document.body.appendChild(overlay)
  src.input.focus()
  src.input.select()
}
