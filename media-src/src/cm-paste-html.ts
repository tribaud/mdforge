/*
 * MDForge (CodeMirror experiment) — paste HTML as Markdown.
 *
 * When rich HTML is pasted (from a web page, a doc, another editor), convert it
 * to Markdown with Turndown (+ GFM: tables, strikethrough, task lists) instead
 * of dropping raw HTML. Tuned to match this project's serialization style.
 *
 * Web-paste pain points handled specially:
 *  - Over-escaping: Turndown escapes `=`, `>`, `` ` ``, `1.`, `_`… aggressively.
 *    We disable escaping (like Milkdown) so prose — and LaTeX — stays clean.
 *  - Math: browsers strip the `<script type="math/tex">` on copy, but keep
 *    MathJax's assistive MathML. We convert that MathML back to `$…$` LaTeX.
 *  - Footnotes: web footnote refs are links to page anchors and the notes list
 *    duplicates the number (`1. [1](…)`). We rewrite refs to `[^n]` and note
 *    items to `[^n]: …` definitions.
 */
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { MathMLToLaTeX } from 'mathml-to-latex'

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
    // and LaTeX (`x\=39`, `a\>0`, `1\.`, `x\_0`). Round-tripping is lossy anyway.
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

function mathToLatex(mathHtml: string): string {
  try {
    return MathMLToLaTeX.convert(mathHtml).replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

/** Rebuild `$…$` / `$$…$$` from copied MathJax so math isn't flattened.
 *
 * MathJax v2 puts the whole visual + assistive markup inside one `.MathJax`
 * span that also carries the source MathML in a `data-mathml` attribute — the
 * cleanest hook: convert it and replace the entire span (dropping the visual
 * glyphs and assistive copy at once). Falls back to `math/tex` scripts, bare
 * assistive spans and bare `<math>`. */
function preprocessMath(doc: Document): void {
  const emit = (latex: string, display: boolean): Text =>
    doc.createTextNode(display ? `\n\n$$${latex}$$\n\n` : `$${latex}$`)

  // 1) The visual `.MathJax` span with its source MathML in `data-mathml`.
  //    Replace the whole `.MathJax_Display` wrapper when present, otherwise the
  //    span — so the emitted `$$…$$` isn't nuked with the wrapper in step 4.
  doc.querySelectorAll('[data-mathml]').forEach((el) => {
    const mml = el.getAttribute('data-mathml') || ''
    const latex = mml ? mathToLatex(mml) : ''
    if (!latex) return
    const target = el.closest('.MathJax_Display') ?? el
    target.replaceWith(emit(latex, /display\s*=\s*["']?block/i.test(mml)))
  })

  // 2) Original TeX in a math/tex script (some copies keep it).
  doc.querySelectorAll('script[type^="math/tex"]').forEach((script) => {
    const tex = (script.textContent || '').trim()
    if (!tex) return
    script.replaceWith(emit(tex, /mode\s*=\s*display/.test(script.getAttribute('type') || '')))
  })

  // 3) Bare assistive MathML span (no data-mathml wrapper).
  doc.querySelectorAll('.MJX_Assistive_MathML').forEach((span) => {
    const math = span.querySelector('math')
    const latex = math ? mathToLatex(math.outerHTML) : ''
    if (latex) span.replaceWith(emit(latex, span.classList.contains('MJX_Assistive_MathML_Block')))
  })

  // 4) Any remaining bare MathML, then strip leftover visual MathJax nodes.
  doc.querySelectorAll('math').forEach((m) => {
    const latex = mathToLatex(m.outerHTML)
    if (latex) m.replaceWith(emit(latex, m.getAttribute('display') === 'block'))
  })
  doc.querySelectorAll('.MathJax, .MathJax_Display, .MathJax_Preview').forEach((n) => n.remove())
}

/**
 * Turn web footnotes into Markdown footnotes.
 *  - Note/biblio list items `N. [k](…#footnoterefM_slug) text` → `[^M]: text`.
 *  - Inline refs `[k](…#footnoteM_slug)` → `[^M]`.
 * The global anchor number M (not the display number k) links refs to defs.
 */
function rewriteFootnotes(md: string): string {
  return (
    md
      // Definitions first: an ordered-list item whose back-link identifies note M.
      .replace(
        /^[ \t]*\d+\.[ \t]+\[\d+\]\([^)]*#footnoteref(\d+)_[^)]*\)[ \t]*(.*)$/gm,
        (_m, n: string, rest: string) => `[^${n}]: ${rest.trim()}`
      )
      // Inline references to a note anchor.
      .replace(/\[\d+\]\([^)]*#footnote(\d+)_[^)]*\)/g, (_m, n: string) => `[^${n}]`)
  )
}

/** Renumber footnotes 1, 2, 3… in order of first reference (both refs and defs),
 * so the labels read cleanly instead of the source's scattered anchor numbers. */
function renumberFootnotes(md: string): string {
  const order: string[] = []
  const seen = new Set<string>()
  const note = (n: string): void => {
    if (!seen.has(n)) {
      seen.add(n)
      order.push(n)
    }
  }
  for (const m of md.matchAll(/\[\^(\d+)\](?!:)/g)) note(m[1]) // references, in reading order
  for (const m of md.matchAll(/^\[\^(\d+)\]:/gm)) note(m[1]) // then any unreferenced defs
  if (!order.length) return md
  const map = new Map(order.map((n, i) => [n, String(i + 1)]))
  return md.replace(/\[\^(\d+)\](:?)/g, (whole, n: string, colon: string) =>
    map.has(n) ? `[^${map.get(n)}]${colon}` : whole
  )
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  preprocessMath(doc)
  // Footnote links carry the note text as a `title` tooltip; it duplicates the
  // note definition and, with parentheses inside, breaks the `[n](url)` output.
  doc.querySelectorAll('a[href*="#footnote"]').forEach((a) => a.removeAttribute('title'))
  let md = getService().turndown(doc.body)
  md = renumberFootnotes(rewriteFootnotes(md))
  return md
    .replace(/\n{3,}/g, '\n\n')
    // Turndown pads list markers (`-   x`); collapse to single-space `- x`.
    .replace(/^(\s*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .trim()
}
