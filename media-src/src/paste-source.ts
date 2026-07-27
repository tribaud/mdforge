/*
 * MDForge — append the source address when pasting from a web page.
 *
 * Like OneNote's "From <url>" footer. The source URL is almost never in the
 * clipboard (a text selection carries only the HTML fragment), so this drops a
 * `> À partir de l'adresse <url>` blockquote below the paste and puts the caret
 * on it — auto-filled if a URL is detectable, otherwise ready for the user to
 * type or paste one. Only fires for external web content (HTML present and not
 * an internal ProseMirror copy).
 */
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'

let enabled = false
let label = "À partir de l'adresse"
/** URL captured on the in-flight web paste (or '' when none was found). */
let pending: string | null = null

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

export const pasteSource = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mdforge-paste-source'),
      props: {
        handlePaste: (_view, event) => {
          if (!enabled) return false
          const html = event.clipboardData?.getData('text/html') ?? ''
          // Need rich web content; skip an internal ProseMirror copy.
          if (!html || html.includes('data-pm-slice')) return false
          pending = detectUrl(event.clipboardData)
          return false // let the normal paste proceed; we append afterwards
        }
      },
      appendTransaction: (trs, _oldState, state) => {
        if (pending === null) return null
        const isPaste = trs.some(
          (tr) => tr.getMeta('uiEvent') === 'paste' || tr.getMeta('paste')
        )
        if (!isPaste) return null

        const url = pending
        pending = null
        const blockquote = state.schema.nodes.blockquote
        const paragraph = state.schema.nodes.paragraph
        if (!blockquote || !paragraph) return null

        const text = url ? `${label} ${url}` : `${label} `
        const node = blockquote.create(null, paragraph.create(null, state.schema.text(text)))
        const sel = state.selection
        const at = sel.$to.depth >= 1 ? sel.$to.after(1) : state.doc.content.size

        const tr = state.tr.insert(at, node)
        const caret = Math.min(at + node.nodeSize - 2, tr.doc.content.size)
        tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView()
        return tr
      }
    })
)
