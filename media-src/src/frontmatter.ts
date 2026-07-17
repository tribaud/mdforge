/*
 * MDForge — YAML frontmatter.
 *
 * Commonmark ignores `---` frontmatter, so we register remark-frontmatter to
 * parse it into a `yaml` mdast node, map it to a dedicated ProseMirror node,
 * and render it discreetly: a small "Frontmatter" bar that expands to a YAML
 * editor on click. The Markdown round-trips as a normal `---` block.
 */
import remarkFrontmatter from 'remark-frontmatter'
import { $nodeSchema, $remark, $view } from '@milkdown/utils'

// Pass the 'yaml' preset explicitly: Milkdown defaults a remark plugin's
// options to `{}`, which remark-frontmatter rejects with
// "Missing `type` in matter `{}`".
export const frontmatterRemark = $remark('mdforgeFrontmatter', () => remarkFrontmatter, ['yaml'])

export const frontmatterSchema = $nodeSchema('frontmatter', () => ({
  content: '',
  group: 'block',
  atom: true,
  marks: '',
  defining: true,
  isolating: true,
  attrs: {
    value: { default: '' }
  },
  parseDOM: [
    {
      tag: 'div[data-type="frontmatter"]',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement | string) =>
        typeof dom === 'string' ? {} : { value: dom.dataset.value ?? '' }
    }
  ],
  toDOM: (node: any) => ['div', { 'data-type': 'frontmatter', 'data-value': node.attrs.value }],
  parseMarkdown: {
    match: ({ type }: any) => type === 'yaml',
    runner: (state: any, node: any, type: any) => {
      state.addNode(type, { value: node.value ?? '' })
    }
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'frontmatter',
    runner: (state: any, node: any) => {
      state.addNode('yaml', undefined, node.attrs.value ?? '')
    }
  }
}))

export const frontmatterView = $view(frontmatterSchema.node, () => {
  return (initialNode, view, getPos) => {
    const dom = document.createElement('div')
    dom.className = 'mdforge-frontmatter'

    // Show the YAML `title:` as an H1, like mark-sharp.
    const titleEl = document.createElement('h1')
    titleEl.className = 'mdforge-frontmatter-title'
    titleEl.contentEditable = 'false'

    const bar = document.createElement('div')
    bar.className = 'mdforge-frontmatter-bar'
    bar.textContent = 'Frontmatter'
    bar.contentEditable = 'false'

    const source = document.createElement('textarea')
    source.className = 'mdforge-frontmatter-source'
    source.spellcheck = false
    source.style.display = 'none'

    dom.append(titleEl, bar, source)

    let current: string = initialNode.attrs.value ?? ''
    let editing = false

    const renderTitle = (): void => {
      const match = /^title:[ \t]*(.+?)[ \t]*$/m.exec(current)
      const title = match ? match[1].replace(/^["']|["']$/g, '').trim() : ''
      titleEl.textContent = title
      titleEl.style.display = title ? '' : 'none'
    }

    const setEditing = (on: boolean): void => {
      editing = on
      source.style.display = on ? 'block' : 'none'
      bar.classList.toggle('open', on)
      if (on) {
        source.value = current
        source.focus()
      }
    }

    const commit = (): void => {
      const next = source.value
      setEditing(false)
      if (next === current) return
      const pos = getPos()
      if (pos == null) return
      const attrs = view.state.doc.nodeAt(pos)?.attrs ?? {}
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, value: next }))
    }

    bar.addEventListener('mousedown', (event) => {
      event.preventDefault()
      setEditing(!editing)
    })
    source.addEventListener('blur', commit)
    source.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setEditing(false)
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    })

    renderTitle()

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== 'frontmatter') return false
        current = updatedNode.attrs.value ?? ''
        renderTitle()
        return true
      },
      stopEvent: () => editing,
      ignoreMutation: () => true,
      destroy: () => {}
    }
  }
})

export const frontmatter = [frontmatterRemark, frontmatterSchema, frontmatterView].flat()
