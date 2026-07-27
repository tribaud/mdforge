/*
 * MDForge — compact MathML → LaTeX converter.
 *
 * Web pages render math with MathJax/KaTeX; when copied, the LaTeX source is
 * usually gone but the MathML survives (MathJax v2 keeps it in `data-mathml`,
 * KaTeX/MathJax3 in a MathML subtree). This converts that MathML back to LaTeX
 * so pasted formulas become real `$...$` / `$$...$$` math. It covers the common
 * school-math subset (fractions, powers, indices, roots, Greek, operators) and
 * degrades gracefully on anything exotic (unknown elements → their children).
 */

const SYMBOLS: Record<string, string> = {
  // Greek (lower)
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon',
  ζ: '\\zeta', η: '\\eta', θ: '\\theta', ι: '\\iota', κ: '\\kappa',
  λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi', ρ: '\\rho',
  σ: '\\sigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi', χ: '\\chi',
  ψ: '\\psi', ω: '\\omega',
  // Greek (upper)
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi',
  Π: '\\Pi', Σ: '\\Sigma', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega'
}

const OPERATORS: Record<string, string> = {
  '−': '-', '×': '\\times', '⋅': '\\cdot', '÷': '\\div',
  '±': '\\pm', '∓': '\\mp', '≠': '\\neq', '≤': '\\leq', '≥': '\\geq',
  '≈': '\\approx', '≡': '\\equiv', '→': '\\to', '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow', '∞': '\\infty', '∈': '\\in', '∉': '\\notin',
  '⊂': '\\subset', '⊆': '\\subseteq', '∪': '\\cup', '∩': '\\cap',
  '∀': '\\forall', '∃': '\\exists', '∅': '\\emptyset', '∂': '\\partial',
  '∇': '\\nabla', '∫': '\\int', '∑': '\\sum', '∏': '\\prod', '√': '\\sqrt',
  '⋯': '\\cdots', '…': '\\ldots', '∘': '\\circ', '·': '\\cdot',
  '′': "'", '″': "''", '°': '^{\\circ}',
  // Invisible operators (times / function application / separators)
  '⁡': '', '⁢': '', '⁣': '', '⁤': ''
}

const VARIANTS: Record<string, string> = {
  'double-struck': '\\mathbb',
  bold: '\\mathbf',
  script: '\\mathscr',
  fraktur: '\\mathfrak',
  'sans-serif': '\\mathsf',
  monospace: '\\mathtt'
}

/** Wrap a sub-expression in braces unless it's a single token. */
function brace(value: string): string {
  return value.length <= 1 ? value : `{${value}}`
}

function mapSymbol(text: string): string {
  const t = text.trim()
  if (t.length === 1 && SYMBOLS[t]) return SYMBOLS[t]
  return t
}

function elementChildren(el: Element): Element[] {
  return Array.from(el.children)
}

function convertChildren(el: Element): string {
  let out = ''
  el.childNodes.forEach((node) => {
    out += convertNode(node)
  })
  return out
}

function convertNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const kids = elementChildren(el)
  const conv = (child?: Element): string => (child ? convertNode(child) : '')

  switch (el.tagName.toLowerCase()) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'menclose':
    case 'mphantom':
      return convertChildren(el)
    case 'semantics': {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')
      return tex ? (tex.textContent ?? '') : convertChildren(el)
    }
    case 'annotation':
      return el.getAttribute('encoding') === 'application/x-tex' ? (el.textContent ?? '') : ''
    case 'mi': {
      const variant = el.getAttribute('mathvariant')
      const inner = mapSymbol(el.textContent ?? '')
      if (variant && VARIANTS[variant]) return `${VARIANTS[variant]}{${inner}}`
      return inner
    }
    case 'mn':
      return (el.textContent ?? '').trim()
    case 'mo':
      return OPERATORS[(el.textContent ?? '').trim()] ?? (el.textContent ?? '').trim()
    case 'mtext':
      return `\\text{${el.textContent ?? ''}}`
    case 'mspace':
      return ' '
    case 'msup':
      return `${brace(conv(kids[0]))}^${brace(conv(kids[1]))}`
    case 'msub':
      return `${brace(conv(kids[0]))}_${brace(conv(kids[1]))}`
    case 'msubsup':
      return `${brace(conv(kids[0]))}_${brace(conv(kids[1]))}^${brace(conv(kids[2]))}`
    case 'mfrac':
      return `\\frac{${conv(kids[0])}}{${conv(kids[1])}}`
    case 'msqrt':
      return `\\sqrt{${convertChildren(el)}}`
    case 'mroot':
      return `\\sqrt[${conv(kids[1])}]{${conv(kids[0])}}`
    case 'munderover':
      return `${brace(conv(kids[0]))}_${brace(conv(kids[1]))}^${brace(conv(kids[2]))}`
    case 'munder':
      return `${brace(conv(kids[0]))}_${brace(conv(kids[1]))}`
    case 'mover':
      return `${brace(conv(kids[0]))}^${brace(conv(kids[1]))}`
    case 'mfenced': {
      const open = el.getAttribute('open') ?? '('
      const close = el.getAttribute('close') ?? ')'
      return `\\left${open}${kids.map((k) => conv(k)).join(', ')}\\right${close}`
    }
    default:
      return convertChildren(el)
  }
}

/** Convert a MathML string to `{ latex, block }` (block = display math). */
export function mathmlToLatex(mathml: string): { latex: string; block: boolean } {
  try {
    const doc = new DOMParser().parseFromString(mathml, 'text/html')
    const math = doc.querySelector('math')
    if (!math) return { latex: '', block: false }
    const block = math.getAttribute('display') === 'block'
    const latex = convertChildren(math).replace(/\s+/g, ' ').trim()
    return { latex, block }
  } catch {
    return { latex: '', block: false }
  }
}
