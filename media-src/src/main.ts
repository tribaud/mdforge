import { Editor, rootCtx, defaultValueCtx, editorViewCtx, editorViewOptionsCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { $prose } from '@milkdown/utils'
import { gapCursor } from '@milkdown/prose/gapcursor'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { history } from '@milkdown/plugin-history'
import { clipboard } from '@milkdown/plugin-clipboard'
import { math } from '@milkdown/plugin-math'
import { diagram } from '@milkdown/plugin-diagram'
import { inProgressTask } from './inprogress-task'
import { nodeViews, setMermaidTheme } from './views'
import { slash, slashPluginView } from './slash'
import { toolbar, toolbarPluginView } from './toolbar'
import { githubAlert } from './github-alerts'
import { footnoteJump } from './footnotes'
import { frontmatter } from './frontmatter'
import { block, blockView } from './block'
import { wikilinks } from './wikilinks'
import { shikiHighlight } from './shiki-highlight'
import {
  imagePaste,
  imageNodeView,
  openInsertImageDialog,
  handleImageResponse,
  setAssetsBaseUri,
  setImagePost
} from './images'
import { createTopbar } from './topbar'
import { headingFold } from './heading-fold'
import 'katex/dist/katex.min.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
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
  mermaidTheme?: string
  assetsBaseUri?: string
}

const vscode = acquireVsCodeApi()
const root = document.getElementById('app') as HTMLElement

// Route image bytes from paste/drop/picker to the extension host.
setImagePost((message) => vscode.postMessage(message))

// Gap cursor: lets you place the caret (and start typing) after a trailing
// block that is not a paragraph — e.g. a code block, table or diagram at the
// very end of the document. Non-destructive: the Markdown is untouched until
// you actually type.
const gapCursorPlugin = $prose(() => gapCursor())

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
/** Read-only presentation mode. */
let presentation = false
/** Raw Markdown source view (editable textarea) instead of the WYSIWYG editor. */
let sourceMode = false
let currentView: any = null

// Editable raw-source textarea, shown when source view is toggled on. Lives
// outside the Milkdown root and persists across editor recreation.
const sourceTextarea = document.createElement('textarea')
sourceTextarea.className = 'mdforge-source'
sourceTextarea.spellcheck = false

// Persistent top toolbar (document-level actions). Lives outside the Milkdown
// root so it survives editor recreation on external changes.
const topbar = createTopbar({
  getView: () => currentView,
  insertImage: (view) => openInsertImageDialog(view),
  localizeAssets: () => vscode.postMessage({ type: 'localizeAssets' }),
  renameNote: () => vscode.postMessage({ type: 'renameNote' }),
  moveNote: () => vscode.postMessage({ type: 'moveNote' }),
  toggleSource: () => toggleSource(),
  togglePresentation: () => togglePresentation(),
  openSettings: () => vscode.postMessage({ type: 'openSettings' })
})
document.body.insertBefore(topbar, root)
document.body.appendChild(sourceTextarea)

async function createEditor(initial: string): Promise<void> {
  currentText = initial
  editor = await Editor.make()
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
      ctx.set(toolbar.key, { view: toolbarPluginView })
      ctx.set(block.key, { view: blockView(ctx) })
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => !presentation }))
    })
    .use(commonmark)
    .use(gfm)
    .use(frontmatter)
    .use(inProgressTask)
    .use(listener)
    .use(history)
    .use(clipboard)
    .use(math)
    .use(diagram)
    .use(nodeViews)
    .use(slash)
    .use(toolbar)
    .use(githubAlert)
    .use(footnoteJump)
    .use(block)
    .use(wikilinks((target) => vscode.postMessage({ type: 'openWikilink', target })))
    .use(shikiHighlight)
    .use(imagePaste)
    .use(imageNodeView)
    .use(gapCursorPlugin)
    .use(headingFold)
    .create()

  currentView = editor.ctx.get(editorViewCtx)
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
    // An external change while viewing source: reflect it in the textarea.
    if (sourceMode) sourceTextarea.value = text
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
  if (config.assetsBaseUri) setAssetsBaseUri(config.assetsBaseUri)
  if (config.mermaidTheme) setMermaidTheme(config.mermaidTheme)
}

function revealHeading(index: number): void {
  const headings = document.querySelectorAll(
    '.milkdown .ProseMirror h1, .milkdown .ProseMirror h2, .milkdown .ProseMirror h3, .milkdown .ProseMirror h4, .milkdown .ProseMirror h5, .milkdown .ProseMirror h6'
  )
  const target = headings[index] as HTMLElement | undefined
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function togglePresentation(): void {
  // Source view and presentation are mutually exclusive; leave source first.
  if (!presentation && sourceMode) void toggleSource()
  presentation = !presentation
  document.body.classList.toggle('mdforge-presentation', presentation)
  // Re-evaluate the editable prop (read from editorViewOptionsCtx).
  if (currentView) currentView.dispatch(currentView.state.tr)
  vscode.postMessage({ type: 'presentationState', enabled: presentation })
}

/**
 * Toggle the raw Markdown source view. Entering mirrors the current Markdown
 * into an editable textarea; leaving commits any edits back to the WYSIWYG
 * editor and the host (whole-document replace), rebuilding Milkdown from source.
 */
async function toggleSource(): Promise<void> {
  if (!sourceMode) {
    sourceMode = true
    sourceTextarea.value = currentText
    document.body.classList.add('mdforge-source-mode')
    sourceTextarea.focus()
    return
  }
  sourceMode = false
  document.body.classList.remove('mdforge-source-mode')
  const next = sourceTextarea.value
  if (next === currentText) {
    currentView?.focus?.()
    return
  }
  currentText = next
  vscode.postMessage({ type: 'edit', text: next })
  applyingRemote = true
  try {
    if (editor) {
      await editor.destroy()
      editor = null
    }
    await createEditor(next)
    currentView?.focus?.()
  } catch (error) {
    showError(error)
  } finally {
    applyingRemote = false
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data as {
    type: string
    text?: string
    config?: MdForgeConfig
    index?: number
    id?: number
    src?: string
    alt?: string
    linkStyle?: string
    error?: string
  }
  switch (msg.type) {
    case 'setContent':
      if (typeof msg.text === 'string') void setContent(msg.text)
      break
    case 'config':
      if (msg.config) applyConfig(msg.config)
      break
    case 'imageInserted':
      if (typeof msg.id === 'number') handleImageResponse(msg as { id: number })
      break
    case 'revealHeading':
      if (typeof msg.index === 'number') revealHeading(msg.index)
      break
    case 'togglePresentation':
      togglePresentation()
      break
  }
})

// Tell the host we are ready to receive the initial document + config.
vscode.postMessage({ type: 'ready' })
