/*
 * MDForge (CodeMirror experiment) — Obsidian-style "Live Preview".
 *
 * Unlike the Milkdown build, the CodeMirror document IS the Markdown text: there
 * is no semantic model and no re-serialization, so an edit only ever changes the
 * exact characters typed — perfect diffs, grep-able identifiers, by construction.
 * "Rendering" is done with decorations: syntax markers (`**`, `#`, `[ ]`…) are
 * hidden and the content styled, and the raw syntax is revealed again whenever
 * the selection enters a node (so it stays fully editable).
 */
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Range } from '@codemirror/state'

/** Base URI (webview URI of the note's folder) used to resolve relative images. */
let assetsBase = ''
export function setAssetsBase(uri: string): void {
  assetsBase = uri.replace(/\/$/, '')
}
function resolveSrc(src: string): string {
  if (/^(https?:|data:|blob:|vscode-webview:|vscode-resource:)/i.test(src)) return src
  return assetsBase ? `${assetsBase}/${src.replace(/^\.\//, '')}` : src
}

/** True when a selection range touches [from, to] — then we reveal raw syntax. */
function editing(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-task-checkbox'
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('change', () => {
      // Toggle the `[ ]`/`[x]` on the clicked line — a one-character text edit.
      const line = view.state.doc.lineAt(view.posAtDOM(box))
      const m = /\[([ xX])\]/.exec(line.text)
      if (!m) return
      const from = line.from + m.index
      view.dispatch({ changes: { from, to: from + 3, insert: this.checked ? '[ ]' : '[x]' } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.src = resolveSrc(this.src)
    img.alt = this.alt
    img.className = 'cm-inline-image'
    return img
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const deco: Array<Range<Decoration>> = []
  const doc = view.state.doc
  const tree = syntaxTree(view.state)

  tree.iterate({
    enter: (node) => {
      const name = node.name
      const from = node.from
      const to = node.to

      // Headings: enlarge the whole line, hide the leading "### ".
      const headingMatch = /^ATXHeading([1-6])$/.exec(name)
      if (headingMatch) {
        const level = headingMatch[1]
        const line = doc.lineAt(from)
        deco.push(Decoration.line({ class: `cm-md-h cm-md-h${level}` }).range(line.from))
        if (!editing(view, line.from, line.to)) {
          const mark = node.node.getChild('HeaderMark')
          if (mark) deco.push(Decoration.replace({}).range(mark.from, Math.min(mark.to + 1, line.to)))
        }
        return
      }

      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'InlineCode' || name === 'Strikethrough') {
        const cls =
          name === 'StrongEmphasis'
            ? 'cm-md-strong'
            : name === 'Emphasis'
              ? 'cm-md-em'
              : name === 'InlineCode'
                ? 'cm-md-code'
                : 'cm-md-strike'
        deco.push(Decoration.mark({ class: cls }).range(from, to))
        if (!editing(view, from, to)) {
          const markName =
            name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === markName) deco.push(Decoration.replace({}).range(c.from, c.to))
          }
        }
        return
      }

      // Task checkbox: always shown as an interactive widget.
      if (name === 'TaskMarker') {
        const checked = /x/i.test(doc.sliceString(from, to))
        deco.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(from, to))
        return
      }

      // Links: hide `[`, `](url)` and style the text; reveal raw when editing.
      if (name === 'Link' && !editing(view, from, to)) {
        const open = node.node.firstChild // "["
        let close: { from: number; to: number } | null = null
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (c.name === 'LinkMark' && doc.sliceString(c.from, c.to) === ']') {
            close = { from: c.from, to: c.to }
            break
          }
        }
        if (open && open.name === 'LinkMark') deco.push(Decoration.replace({}).range(open.from, open.to))
        if (close) {
          if (close.from > (open ? open.to : from)) {
            deco.push(Decoration.mark({ class: 'cm-md-link' }).range(open ? open.to : from, close.from))
          }
          deco.push(Decoration.replace({}).range(close.from, to))
        }
        return
      }

      // Images: replace the whole `![alt](src)` with an inline <img>.
      if (name === 'Image' && !editing(view, from, to)) {
        const text = doc.sliceString(from, to)
        const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)/.exec(text)
        if (m) deco.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1]) }).range(from, to))
        return
      }
    }
  })

  return Decoration.set(deco, true)
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)
