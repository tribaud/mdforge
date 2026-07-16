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
import { mathBlockSchema } from '@milkdown/plugin-math'
import { $view } from '@milkdown/utils'
import mermaid from 'mermaid'
import katex from 'katex'

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
    const source = document.createElement('textarea')
    source.className = 'mdforge-mermaid-source'
    source.spellcheck = false
    source.style.display = 'none'
    dom.append(preview, source)

    let currentValue: string = initialNode.attrs.value ?? ''
    let editing = false

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
        void renderMermaid(currentValue)
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

export const nodeViews = [diagramNodeView, codeBlockNodeView, mathBlockNodeView]
