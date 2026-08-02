/*
 * MDForge — append the source address when pasting from a web page.
 *
 * Like OneNote's "From <url>" footer. The source URL is almost never in the
 * clipboard (a text selection carries only the HTML fragment), so this drops a
 * `> À partir de l'adresse <url>` blockquote below the paste and puts the caret
 * on it — auto-filled if a URL is detectable, otherwise ready for the user to
 * type or paste one. Only fires for external web content.
 *
 * Wired as an editor-prop `handlePaste` (which runs *before* Milkdown's
 * clipboard plugin, that consumes the paste). We don't consume it — we let the
 * clipboard plugin do the actual paste and append our line in a microtask,
 * once the pasted content is in the document.
 */
import { TextSelection } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

let enabled = false
let label = "À partir de l'adresse"

/** Configure from settings (mdforge.paste.appendSource / .sourceLabel). */
export function setAppendSource(on: boolean, sourceLabel?: string): void {
  enabled = on
  if (sourceLabel) label = sourceLabel
}

/** Best-effort: a URL from the clipboard's uri-list or a bare-URL plain text. */
function detectUrl(data: DataTransfer | null): string {
  const uriList = data?.getData('text/uri-list') ?? ''
  const uri = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && /^https?:\/\//i.test(line))
  if (uri) return uri
  const text = (data?.getData('text/plain') ?? '').trim()
  return /^https?:\/\/\S+$/i.test(text) ? text : ''
}

/** Insert the source blockquote below the paste, caret on it.
 *
 * Layout is `<label> :` then a hard line break then the URL, so a long address
 * lands on its own line — justified text stretched a URL across the whole width
 * with huge gaps when label + URL shared one line. */
function insertSource(view: EditorView, url: string): void {
  const { state } = view
  const blockquote = state.schema.nodes.blockquote
  const paragraph = state.schema.nodes.paragraph
  const hardbreak = state.schema.nodes.hardbreak
  if (!blockquote || !paragraph) return

  // Drop any trailing colon on the configured label so we never double it.
  const head = label.replace(/\s*:\s*$/, '')
  const content: any[] = [state.schema.text(`${head} :`)]
  if (hardbreak) content.push(hardbreak.create())
  else content.push(state.schema.text(' ')) // fallback: keep it on one line
  if (url) content.push(state.schema.text(url))
  const node = blockquote.create(null, paragraph.create(null, content))
  const sel = state.selection
  const at = sel.$to.depth >= 1 ? sel.$to.after(1) : state.doc.content.size

  const tr = state.tr.insert(at, node)
  const caret = Math.min(at + node.nodeSize - 2, tr.doc.content.size)
  tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView()
  view.dispatch(tr)
  view.focus()
}

/**
 * Editor-prop `handlePaste`: for external web content, schedule the source line
 * and return false so the normal (clipboard-plugin) paste still runs.
 */
export function handleSourcePaste(view: EditorView, event: ClipboardEvent): boolean {
  if (!enabled) return false
  const html = event.clipboardData?.getData('text/html') ?? ''
  // Need rich web content; skip an internal ProseMirror copy.
  if (!html || html.includes('data-pm-slice')) return false
  const url = detectUrl(event.clipboardData)
  queueMicrotask(() => {
    try {
      insertSource(view, url)
    } catch {
      // best-effort; never break the paste
    }
  })
  return false
}
