/*
 * MDForge (CodeMirror) — table of contents, in a collapsible panel on the left.
 *
 * The headings come from the Lezer tree, so the list is the note's own structure
 * (a `#` inside fenced code is not a heading). A click scrolls the heading to
 * the top WITHOUT moving the caret — the panel is for reading, and a caret
 * landing on a heading would reveal its `##` — and unfolds it first when it sits
 * inside a folded section. The heading under the top of the viewport is marked.
 */
import { EditorView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree, foldedRanges, unfoldEffect } from '@codemirror/language'
import type { StateEffect } from '@codemirror/state'

export type TocHeading = { level: number; text: string; from: number }

/** Inline Markdown down to what a reader sees: `**a**`, `[a](b)`, `` `a` ``… */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a: string, b: string) => b || a)
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .trim()
}

export function tocHeadings(state: EditorState): TocHeading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state)
  const out: TocHeading[] = []
  tree.iterate({
    enter: (node) => {
      const m = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name)
      if (!m) return node.name === 'FencedCode' ? false : undefined
      const line = state.doc.lineAt(node.from)
      const raw = node.name.startsWith('ATX') ? line.text.replace(/^\s*#{1,6}\s*/, '').replace(/\s+#+\s*$/, '') : line.text
      const text = plain(raw)
      if (text) out.push({ level: Number(m[1]), text, from: line.from })
      return false
    }
  })
  return out
}

/** Builds the panel. `update` is called from the editor's update listener. */
export function createToc(view: EditorView): { el: HTMLElement; update: (docChanged: boolean) => void } {
  const el = document.createElement('nav')
  el.className = 'cm-toc'
  el.setAttribute('aria-label', 'Table des matières')
  const title = document.createElement('div')
  title.className = 'cm-toc-title'
  title.textContent = 'Sommaire'
  const list = document.createElement('div')
  list.className = 'cm-toc-list'
  el.append(title, list)

  let headings: TocHeading[] = []
  let items: HTMLElement[] = []
  let active = -1

  const go = (pos: number): void => {
    const effects: StateEffect<unknown>[] = []
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      if (from <= pos && pos <= to) effects.push(unfoldEffect.of({ from, to }))
    })
    effects.push(EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }))
    view.dispatch({ effects })
  }

  const render = (): void => {
    headings = tocHeadings(view.state)
    list.replaceChildren()
    items = headings.map((h) => {
      const item = document.createElement('a')
      item.className = `cm-toc-item cm-toc-h${h.level}`
      item.textContent = h.text
      item.title = h.text
      item.addEventListener('mousedown', (e) => e.preventDefault())
      item.addEventListener('click', (e) => {
        e.preventDefault()
        go(h.from)
      })
      list.appendChild(item)
      return item
    })
    if (!headings.length) {
      const empty = document.createElement('div')
      empty.className = 'cm-toc-empty'
      empty.textContent = 'Aucun titre dans cette note.'
      list.appendChild(empty)
    }
    active = -1
    mark()
  }

  /** The last heading at or above the top of the viewport — or, once the note
   * is scrolled to its end, the last one in view: the closing headings of a
   * note can never reach the top, and a click on one would mark the one before. */
  const mark = (): void => {
    if (!headings.length || !el.isConnected || el.offsetParent === null) return
    const sd = view.scrollDOM
    const rect = sd.getBoundingClientRect()
    const atEnd = sd.scrollTop + sd.clientHeight >= sd.scrollHeight - 2
    const probe = atEnd ? rect.bottom - 24 : rect.top + 24
    const pos = view.lineBlockAtHeight(probe - view.documentTop).from
    let next = 0
    for (let i = 0; i < headings.length; i++) if (headings[i].from <= pos) next = i
    if (next === active) return
    items[active]?.classList.remove('cm-toc-active')
    items[next]?.classList.add('cm-toc-active')
    items[next]?.scrollIntoView({ block: 'nearest' })
    active = next
  }

  view.scrollDOM.addEventListener('scroll', () => window.requestAnimationFrame(mark), { passive: true })

  // The list is rebuilt from the tree, debounced: a keystroke must not re-walk
  // a long note's headings each time.
  let timer = 0
  let lastTree = syntaxTree(view.state)
  const update = (docChanged: boolean): void => {
    const tree = syntaxTree(view.state)
    if (!docChanged && tree === lastTree) return
    lastTree = tree
    window.clearTimeout(timer)
    timer = window.setTimeout(render, docChanged ? 250 : 0)
  }
  render()
  return { el, update }
}
