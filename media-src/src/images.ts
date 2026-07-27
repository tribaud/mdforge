/*
 * MDForge — image insertion, import & local rendering.
 *
 * The webview cannot write files, so image bytes (paste / drop / file picker)
 * are sent to the extension host, which saves them next to the note following
 * the configured convention (folder + `NoteName-<hash>` naming + content dedup)
 * and posts back a *relative* link. Files dragged from the VS Code Explorer or
 * another app arrive as a `text/uri-list` instead of bytes; those are imported
 * by path (the host reads and copies them into the assets folder).
 *
 * The Markdown keeps the relative path (source of truth, round-trips with the
 * vault asset scripts); an image node view rewrites the rendered `<img>` src to
 * a webview URI rooted at the note directory, and offers click-to-edit for the
 * path and alt text.
 */
import { imageSchema } from '@milkdown/preset-commonmark'
import { $prose, $view } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { openImageDialog } from './image-dialog'

type Post = (message: unknown) => void

interface ImageResponse {
  src?: string
  alt?: string
  linkStyle?: string
  error?: string
}

let post: Post = () => {}
/** Debug: when on, each paste's raw HTML/text is sent to the host to inspect. */
let debugPaste = false
/** Webview URI of the note's directory; base for resolving relative images. */
let assetsBaseUri = ''

/** Toggle the paste-HTML debug capture (from config). */
export function setDebugPaste(on: boolean): void {
  debugPaste = on
}
let seq = 0
/** Bumped to bust the webview image cache when an asset's content changes. */
let cacheBust = 0
/** id → callback invoked when the host answers with the saved link. */
const pending = new Map<number, (response: ImageResponse) => void>()
/** Live image node views' re-apply callbacks, so a refresh reloads them all. */
const imageAppliers = new Set<() => void>()

/** Re-fetch every rendered local image (cache-busted) after a content change. */
export function refreshImages(): void {
  cacheBust += 1
  for (const apply of imageAppliers) apply()
}

/** Wire the channel to the extension host (called once from main.ts). */
export function setImagePost(fn: Post): void {
  post = fn
}

/** Set the webview base URI for the note directory (from the config message). */
export function setAssetsBaseUri(uri: string): void {
  assetsBaseUri = uri.replace(/\/$/, '')
}

/** Links that already resolve on their own (remote / inline / webview / abs). */
function isAbsolute(src: string): boolean {
  return /^(https?:|data:|blob:|vscode-webview:|vscode-resource:|file:|\/)/i.test(src)
}

/** Resolve a Markdown image src (relative to the note) to a loadable URI. */
export function resolveImageSrc(src: string): string {
  if (!src || isAbsolute(src) || !assetsBaseUri) return src
  const clean = src.replace(/^\.\//, '')
  const url = `${assetsBaseUri}/${encodeURI(clean)}`
  // A cache-busting query forces the webview to re-fetch a changed local file.
  return cacheBust > 0 ? `${url}${url.includes('?') ? '&' : '?'}mdforge=${cacheBust}` : url
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Send image bytes to the host; `handler` runs with the saved relative link. */
function saveFile(file: File, handler: (response: ImageResponse) => void): void {
  const id = (seq += 1)
  pending.set(id, handler)
  void readAsBase64(file).then((data) =>
    post({ type: 'insertImage', id, data, mime: file.type, name: file.name })
  )
}

/** Ask the host to import an existing file by path/URI into the assets folder. */
function importPath(uri: string, handler: (response: ImageResponse) => void): void {
  const id = (seq += 1)
  pending.set(id, handler)
  post({ type: 'importImagePath', id, path: uri })
}

/** Dispatch a host response to its pending handler (called from main.ts). */
export function handleImageResponse(msg: { id: number } & ImageResponse): void {
  const handler = pending.get(msg.id)
  pending.delete(msg.id)
  handler?.(msg)
}

/** Insert an image at `at`, honouring the configured link style. */
function insertImageNode(
  view: EditorView,
  at: number,
  src: string,
  alt: string,
  linkStyle?: string
): void {
  const pos = Math.min(at, view.state.doc.content.size)
  if (linkStyle === 'wikilink-embed') {
    view.dispatch(view.state.tr.insertText(`![[${src}]]`, pos))
    view.focus()
    return
  }
  const type = view.state.schema.nodes.image
  if (!type) return
  view.dispatch(view.state.tr.insert(pos, type.create({ src, alt, title: null })))
  view.focus()
}

function insertFromResponse(view: EditorView, at: number, response: ImageResponse): void {
  if (response.error || !response.src) return
  insertImageNode(view, at, response.src, response.alt ?? '', response.linkStyle)
}

/** Open the OS file picker, save the chosen image, then fill in its link. */
export function browseForImage(fill: (src: string) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) saveFile(file, (response) => response.src && fill(response.src))
  })
  input.click()
}

/** Toolbar / slash entry: dialog to browse a file or type a path/URL + alt. */
export function openInsertImageDialog(view: EditorView): void {
  const at = view.state.selection.from
  openImageDialog({
    title: 'Insert image',
    submitLabel: 'Insert',
    onBrowse: browseForImage,
    onSubmit: ({ src, alt }) => {
      if (src) insertImageNode(view, at, src, alt)
    }
  })
}

function imageFileFrom(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith('image/')) return file
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

function dataUrlToFile(dataUrl: string): File | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl)
  if (!match) return null
  const mime = match[1]
  try {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], `pasted.${mime.split('/')[1] ?? 'png'}`, { type: mime })
  } catch {
    return null
  }
}

function dataImageFromHtml(html: string): string | null {
  const match = /<img[^>]+src=["'](data:image\/[^"']+)["']/i.exec(html)
  return match ? match[1] : null
}

/** First image-looking URI in a `text/uri-list` (comments and blanks skipped). */
function firstImageUri(uriList: string): string | null {
  for (const line of uriList.split(/\r?\n/)) {
    const uri = line.trim()
    if (!uri || uri.startsWith('#')) continue
    if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?|#|$)/i.test(uri)) return uri
  }
  return null
}

/**
 * Paste / drop capture. We listen on `document` in the CAPTURE phase so we run
 * *before* Milkdown's clipboard plugin — otherwise it wins the paste and inlines
 * the image as a base64 `data:` URI. We only stop the event for actual images.
 */
export const imagePaste = $prose(
  () =>
    new Plugin({
      view: (view) => {
        const owns = (event: Event): boolean =>
          event.target instanceof Node && view.dom.contains(event.target)

        const dropPos = (event: DragEvent): number =>
          view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ??
          view.state.selection.from

        const onPaste = (event: ClipboardEvent): void => {
          if (!owns(event)) return
          if (debugPaste) {
            // Non-destructive: capture what's on the clipboard, then let the
            // paste proceed as usual.
            post({
              type: 'debugPasteHtml',
              html: event.clipboardData?.getData('text/html') ?? '',
              text: event.clipboardData?.getData('text/plain') ?? ''
            })
          }
          const file = imageFileFrom(event.clipboardData)
          if (file) {
            event.preventDefault()
            event.stopImmediatePropagation()
            const at = view.state.selection.from
            saveFile(file, (response) => insertFromResponse(view, at, response))
            return
          }
          const html = event.clipboardData?.getData('text/html') ?? ''
          const dataUrl = html ? dataImageFromHtml(html) : null
          const asFile = dataUrl ? dataUrlToFile(dataUrl) : null
          if (asFile) {
            event.preventDefault()
            event.stopImmediatePropagation()
            const at = view.state.selection.from
            saveFile(asFile, (response) => insertFromResponse(view, at, response))
          }
        }

        const onDrop = (event: DragEvent): void => {
          if (!owns(event)) return
          const data = event.dataTransfer
          const file = imageFileFrom(data)
          if (file) {
            event.preventDefault()
            event.stopImmediatePropagation()
            const at = dropPos(event)
            saveFile(file, (response) => insertFromResponse(view, at, response))
            return
          }
          const uriList = data?.getData('text/uri-list') || data?.getData('text/plain') || ''
          const uri = firstImageUri(uriList)
          if (uri) {
            event.preventDefault()
            event.stopImmediatePropagation()
            const at = dropPos(event)
            importPath(uri, (response) => insertFromResponse(view, at, response))
          }
        }

        // `dragover` must be cancelled for a drop to fire on the target.
        const onDragOver = (event: DragEvent): void => {
          if (!owns(event)) return
          const data = event.dataTransfer
          const hasImage =
            Array.from(data?.items ?? []).some((i) => i.type.startsWith('image/')) ||
            (data?.types ?? []).includes('Files') ||
            (data?.types ?? []).includes('text/uri-list')
          if (hasImage) event.preventDefault()
        }

        document.addEventListener('paste', onPaste, true)
        document.addEventListener('drop', onDrop, true)
        document.addEventListener('dragover', onDragOver, true)
        return {
          destroy: () => {
            document.removeEventListener('paste', onPaste, true)
            document.removeEventListener('drop', onDrop, true)
            document.removeEventListener('dragover', onDragOver, true)
          }
        }
      }
    })
)

/**
 * Drop a redundant image `title` that merely mirrors the `alt`. Milkdown's image
 * `parseDOM` defaults `title` to `alt` (`title || alt`), so pasted HTML images
 * serialize as `![alt](src "alt")` — a duplicated caption. Clearing the title
 * when it equals the alt restores `![alt](src)`; a distinct title is kept.
 */
export const imageTitleNormalizer = $prose(
  () =>
    new Plugin({
      appendTransaction: (trs, _oldState, newState) => {
        if (!trs.some((tr) => tr.docChanged)) return null
        let tr: ReturnType<typeof newState.tr.setNodeMarkup> | null = null
        newState.doc.descendants((node, pos) => {
          if (
            node.type.name === 'image' &&
            node.attrs.title &&
            node.attrs.title === node.attrs.alt
          ) {
            tr = (tr ?? newState.tr).setNodeMarkup(pos, undefined, { ...node.attrs, title: '' })
          }
        })
        return tr
      }
    })
)

/** Image node view: render a resolved URI + a hover "edit" button (path/alt). */
export const imageNodeView = $view(imageSchema.node, () => (initialNode, view, getPos) => {
  let node = initialNode
  const dom = document.createElement('span')
  dom.className = 'mdforge-image-wrap'

  const img = document.createElement('img')
  img.className = 'mdforge-image'
  dom.appendChild(img)

  const edit = document.createElement('button')
  edit.type = 'button'
  edit.className = 'mdforge-image-edit'
  edit.textContent = '✎'
  edit.title = 'Edit image (path & alt text)'
  edit.contentEditable = 'false'
  edit.addEventListener('mousedown', (event) => event.preventDefault())
  edit.addEventListener('click', (event) => {
    event.preventDefault()
    openImageDialog({
      title: 'Edit image',
      submitLabel: 'Save',
      src: node.attrs.src ?? '',
      alt: node.attrs.alt ?? '',
      onBrowse: browseForImage,
      onSubmit: ({ src, alt }) => {
        const pos = getPos()
        if (pos == null) return
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src, alt })
        )
      }
    })
  })
  dom.appendChild(edit)

  const apply = (): void => {
    img.src = resolveImageSrc(node.attrs.src ?? '')
    img.alt = node.attrs.alt ?? ''
    if (node.attrs.title) img.title = node.attrs.title
  }
  apply()
  imageAppliers.add(apply)

  return {
    dom,
    update: (updated) => {
      if (updated.type.name !== node.type.name) return false
      node = updated
      apply()
      return true
    },
    destroy: () => {
      imageAppliers.delete(apply)
    }
  }
})
