/*
 * MDForge — lightweight Mermaid syntax highlighter for the diagram source
 * editor. Shiki has no Mermaid grammar, so this is a small heuristic tokenizer
 * (keywords, arrows, strings, comments, bracketed labels). It builds DOM nodes
 * directly (no HTML strings) so there is no escaping/injection concern.
 */
const KEYWORDS =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|subgraph|end|participant|actor|note|loop|alt|else|opt|par|and|rect|activate|deactivate|class|state|direction|section|title|dateFormat|axisFormat|click|style|linkStyle|classDef|TB|TD|BT|RL|LR)$/i

// Order matters: comments, strings, bracketed labels, arrows, identifiers.
const TOKEN_RE =
  /(%%[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\|[^|\n]*\||\[[^\]\n]*\]|\([^)\n]*\)|\{[^}\n]*\})|(-\.->|-{1,3}>|={1,3}>|<-{1,2}>|-{2}[xo]|:::|-{1,3}|={2,3})|([A-Za-z_][\w-]*)/g

/** Render highlighted Mermaid source into `container` (a <code> element). */
export function highlightMermaidInto(container: HTMLElement, code: string): void {
  container.replaceChildren()
  let last = 0
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(code))) {
    if (match.index > last) {
      container.appendChild(document.createTextNode(code.slice(last, match.index)))
    }
    let cls = ''
    if (match[1]) cls = 'mm-comment'
    else if (match[2]) cls = 'mm-string'
    else if (match[3]) cls = 'mm-label'
    else if (match[4]) cls = 'mm-arrow'
    else if (match[5] && KEYWORDS.test(match[5])) cls = 'mm-keyword'

    if (cls) {
      const span = document.createElement('span')
      span.className = cls
      span.textContent = match[0]
      container.appendChild(span)
    } else {
      container.appendChild(document.createTextNode(match[0]))
    }

    last = TOKEN_RE.lastIndex
    if (TOKEN_RE.lastIndex === match.index) TOKEN_RE.lastIndex++
  }
  if (last < code.length) container.appendChild(document.createTextNode(code.slice(last)))
  // Trailing newline keeps the highlight layer's height in sync with the textarea.
  container.appendChild(document.createTextNode('\n'))
}
