/*
 * MDForge — custom "[~] in progress" task list state.
 *
 * GitHub Flavored Markdown (via remark-gfm) only understands `[ ]` and `[x]`.
 * MDForge adds a third, non-standard state written as `[~]` ("in progress").
 *
 * Strategy:
 *  - Extend the GFM task list item schema with an extra boolean attr `inProgress`.
 *  - On parse, detect a leading `[~] ` marker in the item's first paragraph
 *    (remark-gfm leaves it as plain text since it is not a real task marker),
 *    strip it and flag the item as in-progress.
 *  - On serialize, write in-progress items back with the `[~] ` marker so the
 *    Markdown round-trips losslessly.
 *  - Render a clickable checkbox that cycles empty -> in progress -> done.
 */
import { extendListItemSchemaForTask } from '@milkdown/preset-gfm'
import { $inputRule, $prose } from '@milkdown/utils'
import { InputRule } from '@milkdown/prose/inputrules'
import { Plugin, PluginKey } from '@milkdown/prose/state'

type TaskState = 'unchecked' | 'inprogress' | 'checked'

function stateOf(attrs: { checked?: boolean | null; inProgress?: boolean }): TaskState | null {
  if (attrs.inProgress) return 'inprogress'
  if (attrs.checked === true) return 'checked'
  if (attrs.checked === false) return 'unchecked'
  return null // not a task item
}

function attrsForState(base: Record<string, unknown>, next: TaskState): Record<string, unknown> {
  return {
    ...base,
    checked: next === 'checked' ? true : next === 'unchecked' ? false : null,
    inProgress: next === 'inprogress'
  }
}

function nextState(current: TaskState, allowInProgress: boolean): TaskState {
  if (allowInProgress) {
    return current === 'unchecked' ? 'inprogress' : current === 'inprogress' ? 'checked' : 'unchecked'
  }
  return current === 'checked' ? 'unchecked' : 'checked'
}

/** Extends the GFM task item with the in-progress state. */
export const inProgressListItemSchema = extendListItemSchemaForTask.extendSchema((prev) => {
  return (ctx) => {
    const base = prev(ctx)
    return {
      ...base,
      attrs: {
        ...base.attrs,
        inProgress: { default: false, validate: 'boolean' }
      },
      parseDOM: [
        {
          tag: 'li[data-item-type="task"]',
          // Content lives in the inner wrapper we render below; fall back to the
          // <li> itself when parsing task lists authored elsewhere.
          contentElement: (dom: HTMLElement) =>
            dom.querySelector('.mdforge-task-content') ?? dom,
          getAttrs: (dom: HTMLElement | string) => {
            if (typeof dom === 'string') return {}
            const inProgress = dom.dataset.inprogress === 'true'
            return {
              label: dom.dataset.label,
              listType: dom.dataset.listType,
              spread: dom.dataset.spread,
              inProgress,
              checked: inProgress ? null : dom.dataset.checked ? dom.dataset.checked === 'true' : null
            }
          }
        },
        ...(base.parseDOM ?? [])
      ],
      toDOM: (node: any) => {
        const state = stateOf(node.attrs)
        if (state == null) return base.toDOM ? base.toDOM(node) : ['li', 0]
        // The content hole (0) must be the ONLY child of its parent, so the
        // checkbox is a sibling of the content wrapper, not of the hole.
        return [
          'li',
          {
            'data-item-type': 'task',
            'data-label': node.attrs.label,
            'data-list-type': node.attrs.listType,
            'data-spread': node.attrs.spread,
            'data-checked': String(node.attrs.checked === true),
            'data-inprogress': String(Boolean(node.attrs.inProgress)),
            class: `mdforge-task mdforge-task-${state}`
          },
          ['span', { class: 'mdforge-checkbox', contenteditable: 'false' }],
          ['div', { class: 'mdforge-task-content' }, 0]
        ]
      },
      parseMarkdown: {
        match: ({ type }: any) => type === 'listItem',
        runner: (state: any, node: any, type: any) => {
          const paragraph = Array.isArray(node.children) ? node.children[0] : undefined
          const firstText =
            paragraph && paragraph.type === 'paragraph' && Array.isArray(paragraph.children)
              ? paragraph.children[0]
              : undefined
          const isInProgress =
            node.checked == null &&
            firstText &&
            firstText.type === 'text' &&
            /^\[~\]\s+/.test(firstText.value)

          if (isInProgress) {
            firstText.value = firstText.value.replace(/^\[~\]\s+/, '')
            const label = node.label != null ? `${node.label}.` : '•'
            const listType = node.label != null ? 'ordered' : 'bullet'
            const spread = node.spread != null ? `${node.spread}` : 'true'
            state.openNode(type, { label, listType, spread, checked: null, inProgress: true })
            state.next(node.children)
            state.closeNode()
            return
          }

          base.parseMarkdown.runner(state, node, type)
        }
      },
      toMarkdown: {
        match: (node: any) => node.type.name === 'list_item',
        runner: (state: any, node: any) => {
          if (!node.attrs.inProgress) {
            base.toMarkdown.runner(state, node)
            return
          }
          const label = node.attrs.label
          const listType = node.attrs.listType
          const spread = node.attrs.spread === 'true'
          state.openNode('listItem', undefined, { label, listType, spread, checked: null })
          let injected = false
          node.content.forEach((child: any) => {
            if (!injected && child.type.name === 'paragraph') {
              injected = true
              state.openNode('paragraph')
              state.addNode('text', undefined, '[~] ')
              state.next(child.content)
              state.closeNode()
            } else {
              state.next(child)
            }
          })
          state.closeNode()
        }
      }
    }
  }
})

/** Typing `[~] ` at the start of a list item turns it into an in-progress task. */
export const inProgressInputRule = $inputRule(() => {
  return new InputRule(/^\[~\]\s$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start)
    let depth = $start.depth
    while (depth > 0 && $start.node(depth).type.name !== 'list_item') depth--
    const node = depth > 0 ? $start.node(depth) : null
    if (!node || node.attrs.checked != null || node.attrs.inProgress) return null
    const listItemPos = $start.before(depth)
    return state.tr
      .deleteRange(start, end)
      .setNodeMarkup(listItemPos, undefined, { ...node.attrs, checked: null, inProgress: true })
  })
})

/** Clicking a task checkbox cycles its state. */
export const taskCheckboxClickPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('MDFORGE_TASK_CHECKBOX_CLICK'),
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          const target = event.target as HTMLElement | null
          const box = target?.closest('.mdforge-checkbox')
          if (!box) return false
          const li = box.closest('li')
          if (!li) return false
          event.preventDefault()

          const pos = view.posAtDOM(li, 0)
          const $pos = view.state.doc.resolve(pos)
          let depth = $pos.depth
          while (depth > 0 && $pos.node(depth).type.name !== 'list_item') depth--
          const node = depth > 0 ? $pos.node(depth) : null
          if (!node || node.type.name !== 'list_item') return false

          const current = stateOf(node.attrs)
          if (current == null) return false
          const allowInProgress = document.body.classList.contains('mdforge-inprogress')
          const attrs = attrsForState(node.attrs, nextState(current, allowInProgress))
          view.dispatch(view.state.tr.setNodeMarkup($pos.before(depth), undefined, attrs))
          return true
        }
      }
    }
  })
})

/** All plugins needed for the in-progress task feature. Use after `gfm`. */
export const inProgressTask = [inProgressListItemSchema, inProgressInputRule, taskCheckboxClickPlugin].flat()
