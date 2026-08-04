/*
 * MDForge (CodeMirror experiment) — paste HTML as Markdown.
 *
 * When rich HTML is pasted (from a web page, a doc, another editor), convert it
 * to Markdown with Turndown (+ GFM: tables, strikethrough, task lists) instead
 * of dropping raw HTML. Tuned to match this project's serialization style.
 *
 * Two web-paste pain points handled specially:
 *  - Over-escaping: Turndown escapes `=`, `>`, `` ` ``, `1.`, `_`… very
 *    aggressively (`x\=39`, `a\>0`, `1\.`). We disable escaping (like Milkdown)
 *    so pasted prose — and LaTeX — stays clean.
 *  - Math: a rendered MathJax/MathML page copies the *rendered* markup, which
 *    Turndown flattens to broken text (`x0=−b2a`). We pre-convert MathJax
 *    (`<script type="math/tex">`) and MathML (`<annotation>`) back to `$…$`.
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
    // Disable Turndown's aggressive backslash-escaping — it mangles pasted prose
    // and LaTeX. Round-tripping through our own editor is lossy anyway.
    service.escape = (str: string): string => str
  }
  return service
}

/** True when the clipboard HTML carries real structure worth converting. */
export function isRichHtml(html: string): boolean {
  return /<(a|strong|b|em|i|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|pre|code|img|del|s|math|script)\b/i.test(
    html
  )
}

/** Rebuild `$…$` / `$$…$$` from rendered MathJax/MathML so math isn't flattened. */
function preprocessMath(doc: Document): void {
  // MathJax v2: the original TeX survives in a sibling <script type="math/tex">.
  doc.querySelectorAll('script[type^="math/tex"]').forEach((script) => {
    const tex = (script.textContent || '').trim()
    if (!tex) return
    const display = /mode\s*=\s*display/.test(script.getAttribute('type') || '')
    // Remove the visual MathJax nodes that precede the script (they'd flatten).
    let prev = script.previousElementSibling
    while (prev && /MathJax/i.test(prev.className || '')) {
      const before = prev.previousElementSibling
      prev.remove()
      prev = before
    }
    script.replaceWith(doc.createTextNode(display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`))
  })
  // MathML with a TeX annotation.
  doc.querySelectorAll('math').forEach((m) => {
    const ann = m.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]')
    const tex = ann ? (ann.textContent || '').trim() : ''
    if (tex) m.replaceWith(doc.createTextNode(`$${tex}$`))
  })
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  preprocessMath(doc)
  return getService()
    .turndown(doc.body)
    .replace(/\n{3,}/g, '\n\n')
    // Turndown pads list markers with extra spaces (`-   x`); collapse to the
    // project's single-space style (`- x`) so pasted lists match the rest.
    .replace(/^(\s*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .trim()
}
