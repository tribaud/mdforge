/*
 * MDForge — custom node views.
 *
 * Milkdown's diagram and code-block presets are headless: they define the
 * schema but render no interactive UI. These views add:
 *  - a Mermaid renderer for `diagram` nodes (with a click-to-edit source box)
 *  - an editable language field for `code_block` nodes
 */
import { codeBlockSchema } from '@milkdown/preset-commonmark'
import { diagramSchema } from '@milkdown/plugin-diagram'
import { mathBlockSchema, mathInlineSchema } from '@milkdown/plugin-math'
import { $view } from '@milkdown/utils'
import mermaid from 'mermaid'
import katex from 'katex'
import { highlightMermaidInto } from './mermaid-highlight'

let mermaidCounter = 0
let mermaidReady = false

/** Initialize Mermaid once, matching the current VS Code light/dark theme. */
function ensureMermaid(): void {
  if (mermaidReady) return
  const dark = document.body.classList.contains('vscode-dark')
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'loose',
    fontFamily: 'inherit'
  })
  mermaidReady = true
}

/** Renders Mermaid diagrams; click the diagram to edit its source. */
export const diagramNodeView = $view(diagramSchema.node, () => {
  return (initialNode, view, getPos) => {
    const dom = document.createElement('div')
    dom.className = 'mdforge-mermaid'
    const preview = document.createElement('div')
    preview.className = 'mdforge-mermaid-preview'

    // Syntax-highlighted source editor: a transparent textarea over a
    // highlighted <pre> layer (kept in sync).
    const editorWrap = document.createElement('div')
    editorWrap.className = 'mdforge-code-editor'
    editorWrap.style.display = 'none'
    const highlight = document.createElement('pre')
    highlight.className = 'mdforge-code-highlight'
    highlight.setAttribute('aria-hidden', 'true')
    const highlightCode = document.createElement('code')
    highlight.appendChild(highlightCode)
    const source = document.createElement('textarea')
    source.className = 'mdforge-code-input'
    source.spellcheck = false
    editorWrap.append(highlight, source)
    dom.append(preview, editorWrap)

    let currentValue: string = initialNode.attrs.value ?? ''
    let editing = false

    const syncHighlight = (): void => {
      highlightMermaidInto(highlightCode, source.value)
      highlight.scrollTop = source.scrollTop
      highlight.scrollLeft = source.scrollLeft
    }

    const renderMermaid = async (code: string): Promise<void> => {
      ensureMermaid()
      const trimmed = (code ?? '').trim()
      if (!trimmed) {
        preview.innerHTML = '<div class="mdforge-mermaid-empty">Empty diagram — click to edit</div>'
        return
      }
      try {
        const { svg } = await mermaid.render(`mdforge-mermaid-${mermaidCounter++}`, trimmed)
        preview.innerHTML = svg
      } catch (error) {
        const pre = document.createElement('pre')
        pre.className = 'mdforge-mermaid-error'
        const message = error instanceof Error ? error.message : String(error)
        pre.textContent = `${trimmed}\n\n⚠ ${message}`
        preview.replaceChildren(pre)
      }
    }

    const setEditing = (on: boolean): void => {
      editing = on
      editorWrap.style.display = on ? 'block' : 'none'
      preview.style.display = on ? 'none' : 'block'
      if (on) {
        source.value = currentValue
        syncHighlight()
        source.focus()
      }
    }

    const commit = (): void => {
      const next = source.value
      setEditing(false)
      if (next === currentValue) {
        void renderMermaid(currentValue)
        return
      }
      const pos = getPos()
      if (pos == null) return
      const attrs = view.state.doc.nodeAt(pos)?.attrs ?? {}
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, value: next }))
    }

    preview.addEventListener('click', () => setEditing(true))
    source.addEventListener('input', syncHighlight)
    source.addEventListener('scroll', () => {
      highlight.scrollTop = source.scrollTop
      highlight.scrollLeft = source.scrollLeft
    })
    source.addEventListener('blur', commit)
    source.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setEditing(false)
        void renderMermaid(currentValue)
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    })

    void renderMermaid(currentValue)

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== 'diagram') return false
        currentValue = updatedNode.attrs.value ?? ''
        if (!editing) void renderMermaid(currentValue)
        return true
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
      destroy: () => {}
    }
  }
})

/** Adds an editable language field above code blocks. */
export const codeBlockNodeView = $view(codeBlockSchema.node, () => {
  return (initialNode, view, getPos) => {
    const dom = document.createElement('div')
    dom.className = 'mdforge-codeblock'

    const toolbar = document.createElement('div')
    toolbar.className = 'mdforge-codeblock-toolbar'
    toolbar.contentEditable = 'false'
    const input = document.createElement('input')
    input.className = 'mdforge-codeblock-lang'
    input.setAttribute('placeholder', 'plain text')
    input.value = initialNode.attrs.language ?? ''
    toolbar.appendChild(input)

    const pre = document.createElement('pre')
    const code = document.createElement('code')
    pre.appendChild(code)
    dom.append(toolbar, pre)

    const applyLanguage = (): void => {
      const pos = getPos()
      if (pos == null) return
      const attrs = view.state.doc.nodeAt(pos)?.attrs ?? {}
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, language: input.value }))
    }
    input.addEventListener('change', applyLanguage)
    input.addEventListener('blur', applyLanguage)

    return {
      dom,
      contentDOM: code,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== 'code_block') return false
        if (document.activeElement !== input) input.value = updatedNode.attrs.language ?? ''
        return true
      },
      stopEvent: (event: Event) => event.target === input,
      ignoreMutation: (mutation: any) => !code.contains(mutation.target as Node)
    }
  }
})

/** Renders block math with KaTeX; click to edit the LaTeX source. */
export const mathBlockNodeView = $view(mathBlockSchema.node, () => {
  return (initialNode, view, getPos) => {
    const dom = document.createElement('div')
    dom.className = 'mdforge-math'
    const preview = document.createElement('div')
    preview.className = 'mdforge-math-preview'
    const source = document.createElement('textarea')
    source.className = 'mdforge-math-source'
    source.spellcheck = false
    source.style.display = 'none'
    dom.append(preview, source)

    let currentValue: string = initialNode.attrs.value ?? ''
    let editing = false

    const renderMath = (code: string): void => {
      const trimmed = (code ?? '').trim()
      if (!trimmed) {
        preview.innerHTML = '<span class="mdforge-math-empty">Empty equation — click to edit</span>'
        return
      }
      try {
        katex.render(trimmed, preview, { displayMode: true, throwOnError: false })
      } catch (error) {
        preview.textContent = error instanceof Error ? error.message : String(error)
      }
    }

    const setEditing = (on: boolean): void => {
      editing = on
      source.style.display = on ? 'block' : 'none'
      preview.style.display = on ? 'none' : 'block'
      if (on) {
        source.value = currentValue
        source.focus()
      }
    }

    const commit = (): void => {
      const next = source.value
      setEditing(false)
      if (next === currentValue) {
        renderMath(currentValue)
        return
      }
      const pos = getPos()
      if (pos == null) return
      const attrs = view.state.doc.nodeAt(pos)?.attrs ?? {}
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, value: next }))
    }

    preview.addEventListener('click', () => setEditing(true))
    source.addEventListener('blur', commit)
    source.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setEditing(false)
        renderMath(currentValue)
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    })

    renderMath(currentValue)

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== 'math_block') return false
        currentValue = updatedNode.attrs.value ?? ''
        if (!editing) renderMath(currentValue)
        return true
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
      destroy: () => {}
    }
  }
})

/**
 * Renders inline math with KaTeX; click to edit. Unlike the block variant,
 * inline math stores its LaTeX as the node's text content, so committing
 * replaces the whole node.
 */
export const mathInlineNodeView = $view(mathInlineSchema.node, () => {
  return (initialNode, view, getPos) => {
    const dom = document.createElement('span')
    dom.className = 'mdforge-math-inline'
    let current: string = initialNode.textContent ?? ''
    let editing = false

    const renderMath = (): void => {
      editing = false
      try {
        katex.render(current || '\\,', dom, { throwOnError: false })
      } catch {
        dom.textContent = current
      }
    }

    const startEdit = (): void => {
      editing = true
      const input = document.createElement('input')
      input.className = 'mdforge-math-inline-input'
      input.value = current
      input.size = Math.max(current.length, 2)
      dom.replaceChildren(input)
      input.focus()
      input.select()

      const finish = (commit: boolean): void => {
        const next = input.value
        if (!commit || next === current) {
          renderMath()
          return
        }
        const pos = getPos()
        if (pos == null) {
          renderMath()
          return
        }
        const node = view.state.doc.nodeAt(pos)
        if (!node) {
          renderMath()
          return
        }
        const type = view.state.schema.nodes.math_inline
        const content = next ? view.state.schema.text(next) : undefined
        view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, type.create(node.attrs, content)))
      }

      input.addEventListener('blur', () => finish(true))
      input.addEventListener('input', () => {
        input.size = Math.max(input.value.length, 2)
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      })
    }

    dom.addEventListener('mousedown', (event) => {
      if (editing) return
      event.preventDefault()
      startEdit()
    })

    renderMath()

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== 'math_inline') return false
        current = updatedNode.textContent ?? ''
        if (!editing) renderMath()
        return true
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
      destroy: () => {}
    }
  }
})

export const nodeViews = [
  diagramNodeView,
  codeBlockNodeView,
  mathBlockNodeView,
  mathInlineNodeView
]
