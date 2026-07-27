/*
 * MDForge — recover math when pasting from the web.
 *
 * MathJax/KaTeX pages copy math as rendered markup, which Milkdown would drop to
 * plain text. This rewrites the pasted HTML so each formula becomes the DOM that
 * Milkdown's math plugin understands — `<span data-type="math_inline" ...>` /
 * `<div data-type="math_block" ...>` carrying the LaTeX in `data-value` — so
 * ProseMirror parses them as real math nodes (and serializes them as `$...$`).
 *
 * Used as a `transformPastedHTML` step (chained with Milkdown's own).
 */
import { mathmlToLatex } from './mathml-to-latex'

function makeMathNode(doc: Document, latex: string, block: boolean): HTMLElement {
  const el = doc.createElement(block ? 'div' : 'span')
  el.setAttribute('data-type', block ? 'math_block' : 'math_inline')
  el.setAttribute('data-value', latex)
  el.textContent = latex
  return el
}

/** Rewrite MathJax/KaTeX/MathML markup in pasted HTML into Milkdown math nodes. */
export function transformPastedMath(html: string): string {
  // Fast path: nothing math-like to do.
  if (!/data-mathml|<math|application\/x-tex/i.test(html)) return html

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  let changed = false

  // Prefer an explicit TeX annotation (KaTeX / MathJax 3) — lossless.
  doc.querySelectorAll('annotation[encoding="application/x-tex"]').forEach((ann) => {
    const latex = (ann.textContent ?? '').trim()
    if (!latex) return
    const math = ann.closest('math')
    const host = math?.closest('.katex, .MathJax, mjx-container') ?? math
    if (!host) return
    const block = math?.getAttribute('display') === 'block'
    host.replaceWith(makeMathNode(doc, latex, block))
    changed = true
  })

  // MathJax v2: the MathML lives (HTML-escaped) in a `data-mathml` attribute.
  doc.querySelectorAll('[data-mathml]').forEach((el) => {
    const mathml = el.getAttribute('data-mathml')
    if (!mathml) return
    const { latex, block } = mathmlToLatex(mathml)
    if (!latex) return
    const displayWrap = el.closest('.MathJax_Display')
    ;(displayWrap ?? el).replaceWith(makeMathNode(doc, latex, block || Boolean(displayWrap)))
    changed = true
  })

  // Raw MathML left in the paste (some sources).
  doc.querySelectorAll('math').forEach((math) => {
    const { latex, block } = mathmlToLatex(math.outerHTML)
    if (!latex) return
    math.replaceWith(makeMathNode(doc, latex, block))
    changed = true
  })

  return changed ? doc.body.innerHTML : html
}
