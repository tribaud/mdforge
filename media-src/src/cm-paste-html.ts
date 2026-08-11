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

/**
 * True when the clipboard HTML is essentially a lone image (a plain image copy),
 * with no text and no block structure around it. In that case the bitmap the OS
 * also puts on the clipboard should be saved instead of converting the `<img>`
 * to a remote/embedded link. A OneNote note or a web selection carries real text
 * or structure alongside its images, so it does NOT match here — it gets
 * converted to Markdown (and its images localized).
 */
export function htmlIsJustImage(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const hasText = (doc.body.textContent || '').trim().length > 0
  const structural = doc.body.querySelector('table,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,a')
  const hasImage = doc.body.querySelector('img')
  return Boolean(hasImage) && !hasText && !structural
}

/**
 * Fix OneNote's mis-nested lists. OneNote (and Word) emit a sub-list as a
 * **direct child of the parent list** — a `<ol>`/`<ul>` sibling of the `<li>`s,
 * not inside one — which is invalid HTML. Turndown then can't indent it, so
 * nested `1. 2. 3.` levels flatten into an unreadable single sequence. Move each
 * such sub-list into the `<li>` that immediately precedes it, which is the
 * HTML-correct structure Turndown indents properly. Repeated until stable so
 * deeper levels are re-parented after their ancestors move.
 */
function fixNestedLists(doc: Document): void {
  const precedingLi = (node: Element): Element | null => {
    let prev = node.previousElementSibling
    while (prev && prev.tagName !== 'LI') prev = prev.previousElementSibling
    return prev
  }
  // A bounded loop (not recursion) — each pass re-parents one list; the DOM
  // shrinks toward a fixpoint. The cap guards against a pathological tree.
  for (let guard = 0; guard < 2000; guard++) {
    const misnested = Array.from(doc.querySelectorAll('ol, ul')).find((list) => {
      const parent = list.parentElement
      return Boolean(parent && (parent.tagName === 'OL' || parent.tagName === 'UL') && precedingLi(list))
    })
    if (!misnested) break
    precedingLi(misnested)!.appendChild(misnested)
  }
}

/** The deepest last `<li>` of a list — descends into a trailing nested list, so
 * an image after a closed sub-list attaches to the sub-step it illustrates. */
function deepestLastLi(list: Element): Element | null {
  const items = Array.from(list.children).filter((c) => c.tagName === 'LI')
  if (!items.length) return null
  const last = items[items.length - 1]
  const nested = Array.from(last.children)
    .reverse()
    .find((c) => c.tagName === 'OL' || c.tagName === 'UL')
  return (nested && deepestLastLi(nested)) || last
}

/** A `<p>`/`<div>` whose only content is image(s) — no meaningful text. */
function isImageOnlyBlock(el: Element | null): boolean {
  if (!el || (el.tagName !== 'P' && el.tagName !== 'DIV')) return false
  return (el.textContent || '').trim() === '' && el.querySelector('img') !== null
}

/**
 * Pull images OneNote lifted out of a list back into it. OneNote emits an image
 * that illustrates a step as a `<p>` sibling *after* the list (positioned by a
 * `margin-left`), which both breaks the numbering and leaves the image
 * un-indented. Move each such image into the step it follows (the list's deepest
 * last item), so it renders indented under its step instead of splitting the list.
 */
function pullImagesIntoLists(doc: Document): void {
  for (let guard = 0; guard < 2000; guard++) {
    const image = Array.from(doc.querySelectorAll('p, div')).find((el) => {
      const prev = el.previousElementSibling
      return (
        isImageOnlyBlock(el) &&
        el.parentElement?.tagName !== 'LI' &&
        Boolean(prev && (prev.tagName === 'OL' || prev.tagName === 'UL'))
      )
    })
    if (!image) break
    const target = deepestLastLi(image.previousElementSibling as Element)
    if (!target) break
    target.appendChild(image)
  }
}

/** Direct `<li>` children of a list. */
const listItems = (list: Element): Element[] => Array.from(list.children).filter((c) => c.tagName === 'LI')
/** The explicit number of a list's first item (`<li value=N>`), or null. */
function firstItemValue(list: Element): number | null {
  const v = listItems(list)[0]?.getAttribute('value') ?? ''
  return /^\d+$/.test(v) ? Number(v) : null
}
/** The number the list's next item would carry (first value, or 1, + item count). */
const nextValueOf = (list: Element): number => (firstItemValue(list) ?? 1) + listItems(list).length
/** OneNote's `margin-left` (in inches) → nesting level: .375in→1, .75in→2, … */
function marginLevel(el: Element): number | null {
  const m = /margin-left:\s*([\d.]+)in/i.exec(el.getAttribute('style') || '')
  if (!m) return null
  const level = Math.round(parseFloat(m[1]) / 0.375)
  return level >= 1 ? level : null
}

/**
 * Rebuild the nesting OneNote destroys when a list holds images. OneNote splits
 * one logical list into many sibling `<ol>` blocks (an image between two steps
 * closes and reopens the list) and — crucially — emits every resumption at the
 * container's top level, *losing the indentation*, so a sub-step after an image
 * drops back to level 1. The only surviving depth signals are the resumption's
 * `<li value=N>` and the `margin-left` of the images (`.375in`→L1, `.75in`→L2…).
 *
 * Reconstruct the tree with a value-keyed stack of open lists: a fragment whose
 * first value continues an open list at some level is merged back into it (the
 * preceding image's `margin-left` disambiguates when two levels expect the same
 * number); a fragment starting at 1 opens a new top-level list. Images are
 * attached to the step at their own `margin-left` level as we go. This only ever
 * moves items into a sibling/ancestor list — it never drops or reorders content.
 */
function mergeSplitLists(doc: Document): void {
  const containers = Array.from(doc.querySelectorAll('ul, div, section, body')).filter((p) => {
    const kids = Array.from(p.children)
    return kids.filter((c) => c.tagName === 'OL').length >= 2 && !kids.some((c) => c.tagName === 'LI')
  })
  for (const container of containers) {
    // stack[i] = the open ordered list at level i+1, with its next expected number.
    const stack: Array<{ list: Element; next: number }> = []
    let pendingImageLevel: number | null = null
    // After (re)opening the list at the top of the stack, follow any trailing
    // nested `<ol>` down — those sub-lists are open for continuation too.
    const openTrailing = (): void => {
      for (;;) {
        const top = stack[stack.length - 1]?.list
        if (!top) break
        const lastLi = listItems(top).at(-1)
        const nested = lastLi && Array.from(lastLi.children).reverse().find((c) => c.tagName === 'OL')
        if (!nested || stack.some((e) => e.list === nested)) break
        stack.push({ list: nested, next: nextValueOf(nested) })
      }
    }
    for (const child of Array.from(container.children)) {
      if (isImageOnlyBlock(child)) {
        const level = marginLevel(child)
        if (stack.length) {
          const idx = level ? Math.min(level, stack.length) - 1 : stack.length - 1
          deepestLastLi(stack[idx].list)?.appendChild(child)
        }
        pendingImageLevel = level
        continue
      }
      if (child.tagName !== 'OL') {
        // Prose or a heading between lists ends the current list context.
        if ((child.textContent || '').trim()) stack.length = 0
        continue
      }
      const value = firstItemValue(child) ?? 1
      // Pick the level to continue: the preceding image's level when it matches,
      // else the shallowest open list expecting this number.
      let level: number | null = null
      if (pendingImageLevel && pendingImageLevel <= stack.length && stack[pendingImageLevel - 1].next === value) {
        level = pendingImageLevel
      } else {
        const idx = stack.findIndex((e) => e.next === value)
        if (idx >= 0) level = idx + 1
      }
      pendingImageLevel = null
      if (level !== null) {
        const target = stack[level - 1].list
        const items = listItems(child)
        items.forEach((li) => target.appendChild(li))
        stack[level - 1].next += items.length
        stack.length = level
        openTrailing()
        child.remove()
      } else {
        // A fresh top-level list (value 1, or an unmatched resumption).
        stack.length = 0
        stack.push({ list: child, next: nextValueOf(child) })
        openTrailing()
      }
    }
  }
}

/**
 * Carry OneNote's list numbering across split lists. OneNote breaks one logical
 * numbered list into several `<ol>` blocks (a paragraph or image between two
 * steps closes and reopens the list) and marks each resumption with `<li
 * value=N>` on its first item — but never `start` on the `<ol>`. Turndown honors
 * `<ol start>` and ignores `<li value>`, so every chunk restarts at `1.`. Copy
 * the first item's `value` onto its `<ol>` as `start` so the sequence continues
 * (e.g. `5. 6. 7.` instead of a second `1. 2. 3.`). Runs after `mergeSplitLists`
 * for any fragment it left standing (a resumption with no open list to rejoin).
 */
function carryListStart(doc: Document): void {
  doc.querySelectorAll('ol').forEach((ol) => {
    if (ol.hasAttribute('start')) return
    const firstLi = Array.from(ol.children).find((c) => c.tagName === 'LI')
    const value = firstLi?.getAttribute('value') ?? ''
    if (/^\d+$/.test(value) && Number(value) > 1) ol.setAttribute('start', value)
  })
}

/**
 * Resolve a pasted image `src` (a `data:` URI, a `http(s)`/`file:` URL) to a
 * local, note-relative path — or `null` to leave it untouched. Used to pull
 * OneNote/web images into the note's assets folder on paste (their original URLs
 * are often behind Office/CDN auth and stop resolving quickly).
 */
export type ImageResolver = (src: string, alt: string) => Promise<string | null>

/** Rewrite every `<img>` whose source the resolver can localize, in parallel. */
async function localizeImages(doc: Document, resolve: ImageResolver): Promise<void> {
  const imgs = Array.from(doc.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || ''
      if (!src) return
      try {
        const local = await resolve(src, img.getAttribute('alt') || '')
        if (local) img.setAttribute('src', local)
      } catch {
        // Unreachable/auth-gated source → keep the original link.
      }
    })
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

/**
 * Renumber footnotes independently per definition section (Notes 1…, then a
 * second section — e.g. Bibliographie — as b1…, a third as c1…), and remap the
 * body references to match. Web pages share one global numbering across Notes
 * and Bibliography, which reads as scattered numbers; this gives each section
 * its own clean sequence without collisions (distinct label prefixes).
 */
function renumberFootnotes(md: string): string {
  const lines = md.split('\n')
  const headingOf = (line: string): string | null => {
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    return h ? h[1].trim() : null
  }
  const defOf = (line: string): string | null => {
    const d = /^\[\^([^\]\s]+)\]:/.exec(line)
    return d ? d[1] : null
  }
  // 1) Group each definition by the heading it sits under, in document order.
  const sections: string[] = []
  const sectionOf = new Map<string, string>()
  let heading = ''
  for (const line of lines) {
    const h = headingOf(line)
    if (h !== null) {
      heading = h
      continue
    }
    const n = defOf(line)
    if (n && !sectionOf.has(n)) {
      sectionOf.set(n, heading)
      if (!sections.includes(heading)) sections.push(heading)
    }
  }
  if (!sectionOf.size) return md

  // 2) One label prefix per section: first plain, then b, c, d…
  const prefixes = ['', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const prefixOf = new Map(sections.map((s, i) => [s, prefixes[i] ?? `s${i + 1}`]))

  // 3) Number definitions within each section, in document order.
  const counter = new Map<string, number>()
  const map = new Map<string, string>()
  heading = ''
  for (const line of lines) {
    const h = headingOf(line)
    if (h !== null) {
      heading = h
      continue
    }
    const n = defOf(line)
    if (n && !map.has(n)) {
      const idx = (counter.get(heading) ?? 0) + 1
      counter.set(heading, idx)
      map.set(n, `${prefixOf.get(heading)}${idx}`)
    }
  }

  // 4) Rewrite every reference and definition to its new label.
  return md.replace(/\[\^([^\]\s]+)\](:?)/g, (whole, n: string, colon: string) =>
    map.has(n) ? `[^${map.get(n)}]${colon}` : whole
  )
}

/**
 * A compact structural outline of the HTML's lists and images — tag, `value`,
 * `margin-left`, and elided item text — for the paste-debug dump. Strips the
 * noise so the list nesting (and where OneNote drops images) is legible at a
 * glance, which is what the conversion heuristics key off.
 */
export function describeHtmlStructure(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const lines: string[] = []
  const marginLeft = (el: Element): string => {
    const m = /margin-left:\s*([^;]+)/i.exec(el.getAttribute('style') || '')
    return m ? ` ml=${m[1].trim()}` : ''
  }
  const walk = (el: Element, depth: number): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'ol' || tag === 'ul') {
        lines.push(`${'  '.repeat(depth)}<${tag}${marginLeft(child)}>`)
        walk(child, depth + 1)
      } else if (tag === 'li') {
        const value = child.getAttribute('value')
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48)
        lines.push(`${'  '.repeat(depth)}<li${value ? ` value=${value}` : ''}${marginLeft(child)}> ${text}`)
        walk(child, depth + 1)
      } else if ((tag === 'p' || tag === 'div') && child.querySelector('img') && !(child.textContent || '').trim()) {
        lines.push(`${'  '.repeat(depth)}<${tag}${marginLeft(child)}>[img]`)
      } else {
        walk(child, depth)
      }
    }
  }
  walk(doc.body, 0)
  return lines.length ? lines.join('\n') : '(no lists or images)'
}

export async function htmlToMarkdown(html: string, resolveImage?: ImageResolver): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  preprocessMath(doc)
  // Rebuild OneNote's list structure: fix sub-lists mis-parented as siblings of
  // the `<li>`s; re-nest the fragments OneNote split at each image (restoring the
  // indentation and attaching images to their step); pull any remaining lifted
  // image into the step it follows; then carry the start number across any list
  // fragment left standing so numbering doesn't reset.
  fixNestedLists(doc)
  mergeSplitLists(doc)
  pullImagesIntoLists(doc)
  carryListStart(doc)
  // Footnote links carry the note text as a `title` tooltip; it duplicates the
  // note definition and, with parentheses inside, breaks the `[n](url)` output.
  doc.querySelectorAll('a[href*="#footnote"]').forEach((a) => a.removeAttribute('title'))
  // Pull embedded/remote images into the note's assets folder before converting,
  // so the emitted `![](…)` points at a local file, not an auth-gated URL.
  if (resolveImage) await localizeImages(doc, resolveImage)
  let md = getService().turndown(doc.body)
  md = renumberFootnotes(rewriteFootnotes(md))
  return md
    .replace(/\n{3,}/g, '\n\n')
    // Turndown pads list markers (`-   x`); collapse to single-space `- x`.
    .replace(/^(\s*)([-*+]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .trim()
}
