/*
 * MDForge (CodeMirror experiment) — paste HTML as Markdown.
 *
 * When rich HTML is pasted (from a web page, a doc, another editor), convert it
 * to Markdown with Turndown (+ GFM: tables, strikethrough, task lists) instead
 * of dropping raw HTML into the document. Tuned to match this project's
 * serialization style (ATX headings, `-` bullets, `*`/`**` emphasis, fenced
 * code) so pasted content reads like the rest of the file.
 */
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

let service: TurndownService | null = null
function getService(): TurndownService {
  if (!service) {
    service = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      hr: '---',
      linkStyle: 'inlined'
    })
    service.use(gfm)
  }
  return service
}

/** True when the clipboard HTML carries real structure worth converting (not
 * just a plain-text wrapper, which we let CodeMirror paste verbatim). */
export function isRichHtml(html: string): boolean {
  return /<(a|strong|b|em|i|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|code|img|del|s)\b/i.test(html)
}

export function htmlToMarkdown(html: string): string {
  return getService()
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    // Turndown pads list markers with extra spaces (`-   x`); collapse to the
    // project's single-space style (`- x`) so pasted lists match the rest.
    .replace(/^(\s*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .trim()
}
