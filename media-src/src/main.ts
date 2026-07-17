import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { history } from '@milkdown/plugin-history'
import { clipboard } from '@milkdown/plugin-clipboard'
import { math } from '@milkdown/plugin-math'
import { diagram } from '@milkdown/plugin-diagram'
import { inProgressTask } from './inprogress-task'
import { nodeViews } from './views'
import { slash, slashPluginView } from './slash'
import { githubAlert } from './github-alerts'
import { footnoteJump } from './footnotes'
import { getHighlighter, createShikiPlugin } from './shiki-highlight'
import 'katex/dist/katex.min.css'
import './github-theme.css'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

interface MdForgeConfig {
  fontSize: number
  pageWidth: 'comfortable' | 'full'
  enableInProgress: boolean
}

const vscode = acquireVsCodeApi()
const root = document.getElementById('app') as HTMLElement

/** Turn a blank page into a visible error so failures are diagnosable. */
function showError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const pre = document.createElement('pre')
  pre.style.cssText =
    'white-space:pre-wrap;word-break:break-word;color:#f85149;padding:16px;font:12px/1.5 monospace'
  pre.textContent = `MDForge failed to initialize:\n\n${detail}`
  root.replaceChildren(pre)
  vscode.postMessage({ type: 'error', text: detail })
}

window.addEventListener('error', (event) => showError(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => showError(event.reason))

let editor: Editor | null = null
/** Last markdown we are in sync with (from either side). Guards echo loops. */
let currentText = ''
/** True while we are applying a change coming from the extension host. */
let applyingRemote = false

async function createEditor(initial: string): Promise<void> {
  currentText = initial
  let builder = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, initial)
      ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
        if (applyingRemote) return
        if (markdown === currentText) return
        currentText = markdown
        vscode.postMessage({ type: 'edit', text: markdown })
      })
      ctx.set(slash.key, { view: slashPluginView })
    })
    .use(commonmark)
    .use(gfm)
    .use(inProgressTask)
    .use(listener)
    .use(history)
    .use(clipboard)
    .use(math)
    .use(diagram)
    .use(nodeViews)
    .use(slash)
    .use(githubAlert)
    .use(footnoteJump)

  // Syntax highlighting (Shiki). Non-fatal if it fails to initialize.
  try {
    builder = builder.use(createShikiPlugin(await getHighlighter()))
  } catch (error) {
    console.error('[MDForge] Shiki highlighter failed to initialize', error)
  }

  editor = await builder.create()
}

/**
 * Replace the whole document when the change originates from the extension host
 * (external edit, git checkout, undo in the text editor...). Milkdown has no
 * cheap "set whole value" that preserves the schema state, so we recreate the
 * editor. External edits are rare, so the cursor reset is acceptable for now.
 */
async function setContent(text: string): Promise<void> {
  if (text === currentText) return
  applyingRemote = true
  try {
    if (editor) {
      await editor.destroy()
      editor = null
    }
    await createEditor(text)
  } catch (error) {
    showError(error)
  } finally {
    applyingRemote = false
  }
}

function applyConfig(config: MdForgeConfig): void {
  document.documentElement.style.setProperty('--mdforge-font-size', `${config.fontSize}px`)
  document.body.classList.toggle('mdforge-width-full', config.pageWidth === 'full')
  document.body.classList.toggle('mdforge-inprogress', config.enableInProgress)
}

window.addEventListener('message', (event) => {
  const msg = event.data as { type: string; text?: string; config?: MdForgeConfig }
  switch (msg.type) {
    case 'setContent':
      if (typeof msg.text === 'string') void setContent(msg.text)
      break
    case 'config':
      if (msg.config) applyConfig(msg.config)
      break
  }
})

// Tell the host we are ready to receive the initial document + config.
vscode.postMessage({ type: 'ready' })
