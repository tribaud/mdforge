import * as crypto from 'crypto'
import * as path from 'path'
import * as vscode from 'vscode'
import { QuickDiff } from './quickdiff'
import { searchMatches } from './searchreveal'

const VIEW_TYPE = 'mdforge.editor'

export function activate(context: vscode.ExtensionContext): void {
  const outline = new OutlineProvider()
  const tagIndex = new TagIndex(context)
  const provider = new MdForgeEditorProvider(context, outline, tagIndex)

  const presentationStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  )
  presentationStatus.text = '$(book) Presentation'
  presentationStatus.tooltip = 'MDForge: toggle presentation (read-only) mode'
  presentationStatus.command = 'mdforge.togglePresentation'
  outline.presentationStatus = presentationStatus

  context.subscriptions.push(
    presentationStatus,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.window.registerTreeDataProvider('mdforge.outline', outline),
    vscode.commands.registerCommand('mdforge.outline.reveal', (index: number) => {
      outline.active?.webview.postMessage({ type: 'revealHeading', index })
    }),
    vscode.commands.registerCommand('mdforge.togglePresentation', () => {
      if (!outline.active) {
        void vscode.window.showInformationMessage('Open a document with MDForge first.')
        return
      }
      void outline.active.webview.postMessage({ type: 'togglePresentation' })
    }),
    vscode.commands.registerCommand('mdforge.openEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri
      if (!target) {
        void vscode.window.showInformationMessage('Open a Markdown file first.')
        return
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE)
    }),
    vscode.commands.registerCommand('mdforge.openWithTextEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri
      if (!target) {
        return
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'default')
    }),
    // Diff editor has a single shared title bar (no per-pane menu), so we expose
    // one button per side that reads the active tab's diff input and opens the
    // chosen side in MDForge. The original side is often a read-only `git:`
    // resource (view-only); the modified side is the working file.
    vscode.commands.registerCommand('mdforge.openDiffOriginal', async () => {
      const input = activeDiffInput()
      if (input) await vscode.commands.executeCommand('vscode.openWith', input.original, VIEW_TYPE)
    }),
    vscode.commands.registerCommand('mdforge.openDiffModified', async () => {
      const input = activeDiffInput()
      if (input) await vscode.commands.executeCommand('vscode.openWith', input.modified, VIEW_TYPE)
    }),
    // On-demand reformat of the active note (blank lines + paragraphs).
    vscode.commands.registerCommand('mdforge.normalizeBlankLines', async () => {
      const active = outline.active
      if (!active) {
        void vscode.window.showInformationMessage('Open a document with MDForge first.')
        return
      }
      const doc = active.document
      const norm = formatMarkdown(doc.getText(), joinParagraphsEnabled(doc.uri))
      if (norm === doc.getText()) return
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        doc.uri,
        new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
        norm
      )
      await vscode.workspace.applyEdit(edit)
    }),
    // A saved Markdown file's own tags join the known list — the only automatic
    // upkeep of the index (no watcher, no rescan).
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === 'markdown' || /\.(md|markdown)$/i.test(doc.uri.fsPath)) {
        tagIndex.mergeFromText(doc.getText())
      }
    }),
    // Opt-in format-on-save (`mdforge.format.onSave`): run the same reformat as
    // the toolbar's ¶ button just before the file is written, only for notes open
    // in an MDForge editor.
    vscode.workspace.onWillSaveTextDocument((event) => {
      const onSave = reformatOnSave(event.document.uri)
      if (!onSave.on) return
      if (!provider.isOpen(event.document.uri)) return
      const norm = formatMarkdown(
        event.document.getText(),
        onSave.joinParas && joinParagraphsEnabled(event.document.uri)
      )
      if (norm === event.document.getText()) return
      const range = new vscode.Range(
        event.document.positionAt(0),
        event.document.positionAt(event.document.getText().length)
      )
      event.waitUntil(Promise.resolve([vscode.TextEdit.replace(range, norm)]))
    })
  )
}

/** The active tab's diff input (original/modified URIs), if it is a text diff. */
function activeDiffInput(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  return input instanceof vscode.TabInputTextDiff ? input : undefined
}

/**
 * Normalize blank lines to a markdownlint-friendly shape WITHOUT reflowing any
 * content — the CodeMirror engine never rewrites prose, so this is opt-in (a
 * command / format-on-save), not automatic. Rules applied:
 *  - MD012: collapse runs of blank lines to a single one.
 *  - MD022: a blank line before and after every ATX heading.
 *  - MD031: a blank line around fenced code blocks.
 *  - MD047: exactly one trailing newline.
 * Blank lines inside fenced code and YAML frontmatter are left untouched (they
 * are significant there).
 */
export function normalizeBlankLines(text: string): string {
  const src = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  const pushBlank = (): void => {
    if (out.length && out[out.length - 1] !== '') out.push('')
  }
  const fenceOf = (s: string): RegExpExecArray | null => /^\s*(`{3,}|~{3,})/.exec(s)
  const isHeading = (s: string): boolean => /^#{1,6}\s/.test(s)

  let inFence = false
  let fenceCh = ''
  let inFrontmatter = false

  for (let i = 0; i < src.length; i++) {
    const line = src[i]

    // YAML frontmatter at the very top: copy verbatim.
    if (!inFence && !inFrontmatter && i === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true
      out.push(line)
      continue
    }
    if (inFrontmatter) {
      out.push(line)
      if (/^---\s*$/.test(line)) inFrontmatter = false
      continue
    }

    const fence = fenceOf(line)
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) {
        pushBlank() // MD031: blank before an opening fence
        inFence = true
        fenceCh = ch
      } else if (ch === fenceCh) {
        inFence = false
      }
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line) // inside code: verbatim (blank lines matter)
      continue
    }

    if (line.trim() === '') {
      pushBlank() // MD012: collapse consecutive blanks
      continue
    }

    // Content right after a closing fence → insert the MD031 blank.
    if (out.length && fenceOf(out[out.length - 1])) pushBlank()

    if (isHeading(line)) {
      pushBlank() // MD022: blank before…
      out.push(line)
      if (i + 1 < src.length && src[i + 1].trim() !== '') out.push('') // …and after
      continue
    }

    out.push(line)
  }

  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.length ? out.join('\n') + '\n' : ''
}

/**
 * Put each paragraph back on a SINGLE line (undo hard-wrapping). This is what
 * makes justified text possible: `text-align: justify` never stretches the last
 * line of a block, and in the editor every *source* line is its own block — so a
 * paragraph wrapped over five lines can never be justified. Opt-in
 * (`mdforge.format.paragraphs`), because unlike the blank-line pass this rewrites
 * prose lines.
 *
 * Left verbatim: YAML frontmatter, fenced and indented code, block math, tables,
 * blockquotes, headings, HTML blocks, thematic breaks, link/footnote definitions
 * — and any line ending with a Markdown hard break (two spaces, `\` or `<br>`),
 * which is a deliberate break rather than wrapping. A wrapped list item IS joined
 * onto its marker line: that is the same paragraph.
 */
export function joinParagraphs(text: string): string {
  const src = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  const FENCE = /^\s*(`{3,}|~{3,})/
  const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/
  const THEMATIC = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/

  /** A GFM delimiter row: only pipes, dashes and colons, with both present.
   * It is what identifies a table — the border pipes are OPTIONAL, so a table
   * written `Nom | Âge` used to be collapsed into one prose line. */
  const isDelimiterRow = (s: string): boolean => /^[\s|:-]+$/.test(s) && s.includes('-') && s.includes('|')
  /** Line indices belonging to a table (header, delimiter and body rows). */
  const inTable = new Set<number>()
  for (let i = 1; i < src.length; i++) {
    if (!isDelimiterRow(src[i]) || !src[i - 1].includes('|')) continue
    inTable.add(i - 1)
    for (let n = i; n < src.length && src[n].trim() !== '' && src[n].includes('|'); n++) inTable.add(n)
  }

  /** A line that opens its own block — never appended to the previous one. */
  const startsBlock = (s: string, i: number): boolean =>
    s.trim() === '' ||
    inTable.has(i) || // table row, with or without border pipes
    /^\s{0,3}#{1,6}\s/.test(s) || // ATX heading
    /^\s{0,3}>/.test(s) || // blockquote
    LIST_ITEM.test(s) ||
    /^\s{0,3}\|/.test(s) ||
    FENCE.test(s) ||
    THEMATIC.test(s) ||
    /^\s{0,3}(=+|-+)\s*$/.test(s) || // setext underline
    /^\s*<[a-zA-Z!/]/.test(s) || // HTML block
    /^ {4,}\S/.test(s) || // indented code
    /^\s{0,3}\[\^?[^\]]+\]:/.test(s) || // footnote or link definition
    /^\s{0,3}\$\$/.test(s) || // block math
    /^\s{0,3}:\s/.test(s) // definition list

  /**
   * A line that may absorb the next one. Anything that OPENS a block cannot —
   * the one exception is a list item, whose wrapped text belongs to it. Deriving
   * this from `startsBlock` (rather than a second, shorter list) is what stops a
   * setext underline or a `[ref]: url` line from swallowing the paragraph below.
   */
  const canAbsorb = (s: string, i: number): boolean =>
    s.trim() !== '' && (!startsBlock(s, i) || (LIST_ITEM.test(s) && !THEMATIC.test(s) && !inTable.has(i)))

  /** Markdown hard break at the end of a line: keep the break. */
  const hardBreak = (s: string): boolean => /(\s{2}|\\|<br\s*\/?>)$/i.test(s)

  let inFence = false
  let fenceCh = ''
  let inFrontmatter = false
  let inMath = false
  let open = false // the last pushed line can absorb a continuation

  for (let i = 0; i < src.length; i++) {
    const line = src[i]

    if (!inFrontmatter && i === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true
      out.push(line)
      continue
    }
    if (inFrontmatter) {
      out.push(line)
      if (/^---\s*$/.test(line)) inFrontmatter = false
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const ch = fence[1][0]
      if (!inFence) {
        inFence = true
        fenceCh = ch
      } else if (ch === fenceCh) inFence = false
      out.push(line)
      open = false
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    // Block math: `$$` toggles, and its content is significant.
    const dollars = (line.match(/\$\$/g) || []).length
    if (inMath) {
      out.push(line)
      if (dollars % 2 === 1) inMath = false
      open = false
      continue
    }
    if (/^\s{0,3}\$\$/.test(line)) {
      out.push(line)
      if (dollars % 2 === 1) inMath = true
      open = false
      continue
    }

    if (open && !startsBlock(line, i) && !hardBreak(out[out.length - 1])) {
      out[out.length - 1] += ' ' + line.trim()
      continue
    }
    out.push(line)
    open = canAbsorb(line, i)
  }
  return out.join('\n')
}

/** The document formatter behind the ¶ button, the command and format-on-save:
 * the optional paragraph unwrap, then the blank-line pass. */
export function formatMarkdown(text: string, joinParas: boolean): string {
  return normalizeBlankLines(joinParas ? joinParagraphs(text) : text)
}

/** True when `mdforge.format.paragraphs` asks for one line per paragraph. */
function joinParagraphsEnabled(uri: vscode.Uri): boolean {
  return (
    vscode.workspace.getConfiguration('mdforge', uri).get<string>('format.paragraphs', 'oneLine') === 'oneLine'
  )
}

/**
 * Whether the reformat runs on every save, and how much of it. The switch used to
 * be `format.blankLines: onSave` — a name that read like "which rules apply" when
 * it only ever answered "automatically, or on demand?". It is now the boolean
 * `format.onSave`; an explicit value wins.
 *
 * The old setting is still honoured, but **blank lines only**: it promised that
 * and nothing else, and paragraph unwrapping is now on by default — someone who
 * opted into tidying blank lines on save must not discover their prose rewritten.
 */
function reformatOnSave(uri: vscode.Uri): { on: boolean; joinParas: boolean } {
  const cfg = vscode.workspace.getConfiguration('mdforge', uri)
  const set = cfg.inspect<boolean>('format.onSave')
  const explicit = set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue
  if (typeof explicit === 'boolean') return { on: explicit, joinParas: true }
  return { on: cfg.get<string>('format.blankLines', 'off') === 'onSave', joinParas: false }
}

interface Heading {
  level: number
  text: string
  index: number
}

/** Extract ATX headings from Markdown, ignoring fenced code blocks. */
function parseHeadings(markdown: string): Heading[] {
  const headings: Heading[] = []
  let inFence = false
  let fence = ''
  let index = 0
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[2][0]
      if (!inFence) {
        inFence = true
        fence = marker
      } else if (marker === fence) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (match) {
      headings.push({ level: match[1].length, text: match[2].trim(), index: index++ })
    }
  }
  return headings
}

interface HeadingNode extends Heading {
  children: HeadingNode[]
}

/** Nest a flat heading list into a tree by heading level. */
function buildHeadingTree(headings: Heading[]): HeadingNode[] {
  const roots: HeadingNode[] = []
  const stack: HeadingNode[] = []
  for (const heading of headings) {
    const node: HeadingNode = { ...heading, children: [] }
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

/** Collapsible tree view listing the active MDForge document's headings. */
class OutlineProvider implements vscode.TreeDataProvider<HeadingNode> {
  private readonly emitter = new vscode.EventEmitter<void>()
  public readonly onDidChangeTreeData = this.emitter.event
  public active: { document: vscode.TextDocument; webview: vscode.Webview } | undefined
  public presentationStatus: vscode.StatusBarItem | undefined

  public setActive(document: vscode.TextDocument, webview: vscode.Webview): void {
    this.active = { document, webview }
    void vscode.commands.executeCommand('setContext', 'mdforge.active', true)
    this.presentationStatus?.show()
    this.emitter.fire()
  }

  public clear(document: vscode.TextDocument): void {
    if (this.active?.document.uri.toString() !== document.uri.toString()) return
    this.active = undefined
    void vscode.commands.executeCommand('setContext', 'mdforge.active', false)
    this.presentationStatus?.hide()
    this.emitter.fire()
  }

  public refresh(): void {
    this.emitter.fire()
  }

  public getTreeItem(node: HeadingNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.text || "Untitled",
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    )
    item.tooltip = `H${node.level}: ${node.text}`
    item.command = {
      command: "mdforge.outline.reveal",
      title: "Reveal heading",
      arguments: [node.index]
    }
    return item
  }

  public getChildren(element?: HeadingNode): HeadingNode[] {
    if (element) return element.children
    if (!this.active) return []
    return buildHeadingTree(parseHeadings(this.active.document.getText()))
  }
}

export function deactivate(): void {}

/** Pick a file extension for a saved image from its MIME type or source name. */
function imageExtension(mime: string | undefined, name: string | undefined): string {
  const byMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp'
  }
  if (mime && byMime[mime]) return byMime[mime]
  const ext = name ? path.extname(name).replace('.', '').toLowerCase() : ''
  return ext || 'png'
}

/** Strip characters illegal in file names while keeping the note-derived name. */
function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '').trim() || 'image'
}

/** Fetch a remote or decode an embedded (`data:`) image to bytes + extension. */
async function fetchImageBytes(url: string): Promise<{ bytes: Buffer; ext: string }> {
  if (/^data:image\//i.test(url)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(url)
    if (!match) throw new Error('invalid data URI')
    return { bytes: Buffer.from(match[2], 'base64'), ext: imageExtension(match[1], undefined) }
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
  const ext = imageExtension(contentType, url.split(/[?#]/)[0])
  return { bytes, ext }
}

/**
 * Suggest a note file name that follows the vault convention: accents stripped,
 * words PascalCased and dash-joined, truncated to 60 chars on a word boundary.
 * Mirrors `note_renamer.py` (e.g. "O365 (Admin)" → "O365-Admin").
 */
function suggestNoteName(name: string): string {
  let decoded = name
  try {
    decoded = decodeURIComponent(name)
  } catch {
    decoded = name.replace(/%20/gi, ' ')
  }
  const deaccented = decoded.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const words = deaccented
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())

  let result = ''
  for (const word of words) {
    const next = result ? `${result}-${word}` : word
    if (next.length > 60) break
    result = next
  }
  if (!result && words.length) result = words[0].slice(0, 60)
  return result || 'Untitled'
}

/** Derive a base name (no extension, no query) from a remote image URL. */
function remoteBaseName(url: string): string {
  const clean = url.split(/[?#]/)[0]
  const base = clean.substring(clean.lastIndexOf('/') + 1)
  return path.basename(base, path.extname(base)) || 'image'
}

/**
 * Tags declared in a document's YAML frontmatter. Deliberately narrow — the three
 * shapes people actually write:
 *   tags: [a, b]      (flow)      tags: a, b     (bare)      tags:
 *                                                              - a
 * Anything else is ignored rather than half-parsed: this feeds an autocompletion
 * list, so a wrong guess is worse than a missing one.
 */
export function parseFrontmatterTags(text: string): string[] {
  const head = text.replace(/\r\n?/g, '\n')
  if (!head.startsWith('---\n')) return []
  const end = head.indexOf('\n---', 3)
  if (end === -1) return []
  const lines = head.slice(4, end).split('\n')
  const out: string[] = []
  const push = (raw: string): void => {
    const tag = raw.trim().replace(/^["']|["']$/g, '').trim()
    if (tag && !/[:{}[\]]/.test(tag)) out.push(tag)
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^(tags|keywords)\s*:\s*(.*)$/i.exec(lines[i])
    if (!m) continue
    const inline = m[2].trim()
    if (inline) {
      const flow = /^\[(.*)\]$/.exec(inline)
      ;(flow ? flow[1] : inline).split(',').forEach(push)
      continue
    }
    // Block list: the indented `- item` lines that follow.
    for (let n = i + 1; n < lines.length; n++) {
      const item = /^\s+-\s*(.+)$/.exec(lines[n])
      if (!item) break
      push(item[1])
      i = n
    }
  }
  return out
}

/**
 * Top-level frontmatter key names of a document. Free with the tag sweep (the
 * frontmatter is already parsed), and it lets the "add a property" menu offer the
 * keys this vault actually uses, next to the curated PKM list.
 */
export function parseFrontmatterKeys(text: string): string[] {
  const head = text.replace(/\r\n?/g, '\n')
  if (!head.startsWith('---\n')) return []
  const end = head.indexOf('\n---', 3)
  if (end === -1) return []
  const out: string[] = []
  for (const line of head.slice(4, end).split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9_.-]{0,40})\s*:/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/** What the webview is told about the tag index. */
interface TagSnapshot {
  tags: string[]
  keys: string[]
  scannedAt: number
  files: number
  truncated: boolean
}

/** Hard cap on the sweep: past this, tell the user rather than crawl for minutes. */
const TAG_SCAN_LIMIT = 3000

/**
 * The known-tags list behind the frontmatter tag editor: one recursive sweep of
 * the workspace's Markdown frontmatter, cached in `workspaceState` (so reopening
 * VS Code is instant) and refreshed only when asked. No watcher, no database —
 * the only automatic upkeep is merging a document's own tags when it is saved,
 * which keeps the list right for the file you are working on.
 */
class TagIndex {
  private tags = new Set<string>()
  private keys = new Set<string>()
  private scannedAt = 0
  private files = 0
  private truncated = false
  private scanning: Promise<void> | null = null
  private static readonly KEY = 'mdforge.tagIndex'

  public constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<TagSnapshot>(TagIndex.KEY)
    if (saved) {
      saved.tags.forEach((t) => this.tags.add(t))
      // `keys` arrived after `tags`: a cache written by an older build has none.
      ;(saved.keys ?? []).forEach((k) => this.keys.add(k))
      this.scannedAt = saved.scannedAt
      this.files = saved.files
      this.truncated = saved.truncated
    }
  }

  public get scanned(): boolean {
    return this.scannedAt > 0
  }

  public snapshot(): TagSnapshot {
    const sorted = (set: Set<string>): string[] =>
      [...set].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))
    return {
      tags: sorted(this.tags),
      keys: sorted(this.keys),
      scannedAt: this.scannedAt,
      files: this.files,
      truncated: this.truncated
    }
  }

  /** Add one document's tags and keys (cheap: a regex over its frontmatter). */
  public mergeFromText(text: string): void {
    let added = false
    for (const tag of parseFrontmatterTags(text)) {
      if (!this.tags.has(tag)) {
        this.tags.add(tag)
        added = true
      }
    }
    for (const key of parseFrontmatterKeys(text)) {
      if (!this.keys.has(key)) {
        this.keys.add(key)
        added = true
      }
    }
    if (added && this.scanned) void this.persist()
  }

  /** Sweep the workspace. Concurrent calls share the one in flight. */
  public async scan(showProgress: boolean): Promise<void> {
    if (this.scanning) return this.scanning
    const run = showProgress
      ? Promise.resolve(
          vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'MDForge : analyse des tags…' },
            (progress) => this.sweep((done, total) => progress.report({ message: `${done}/${total} fichiers` }))
          )
        )
      : this.sweep()
    this.scanning = run.finally(() => {
      this.scanning = null
    })
    await this.scanning
  }

  private async sweep(onProgress?: (done: number, total: number) => void): Promise<void> {
    const found = await vscode.workspace.findFiles(
      '**/*.{md,markdown}',
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}',
      TAG_SCAN_LIMIT + 1
    )
    this.truncated = found.length > TAG_SCAN_LIMIT
    const uris = this.truncated ? found.slice(0, TAG_SCAN_LIMIT) : found
    const tags = new Set<string>()
    const keys = new Set<string>()
    let done = 0
    let next = 0
    // Only the head of each file is decoded — frontmatter is at the top, and a
    // vault can hold thousands of notes.
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= uris.length) return
        try {
          const bytes = await vscode.workspace.fs.readFile(uris[i])
          const head = decoder.decode(bytes.subarray(0, 4096))
          parseFrontmatterTags(head).forEach((t) => tags.add(t))
          parseFrontmatterKeys(head).forEach((k) => keys.add(k))
        } catch {
          // unreadable file: skip it, the list is best-effort
        }
        done++
        if (onProgress && done % 25 === 0) onProgress(done, uris.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, uris.length) }, worker))
    this.tags = tags
    this.keys = keys
    this.files = uris.length
    this.scannedAt = Date.now()
    await this.persist()
  }

  private persist(): Thenable<void> {
    return this.context.workspaceState.update(TagIndex.KEY, this.snapshot())
  }
}

class MdForgeEditorProvider implements vscode.CustomTextEditorProvider {
  /** Asset paths currently being re-hashed, to ignore the watcher events that
   *  the rename itself triggers (and to avoid double prompts). */
  private readonly rehashing = new Set<string>()

  /** URIs currently open in an MDForge editor — gates format-on-save so it only
   *  touches documents this editor owns, not every Markdown file. */
  private readonly openDocs = new Set<string>()
  public isOpen(uri: vscode.Uri): boolean {
    return this.openDocs.has(uri.toString())
  }

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outline: OutlineProvider,
    private readonly tagIndex: TagIndex
  ) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    this.openDocs.add(document.uri.toString())
    const webview = webviewPanel.webview
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.file(path.dirname(document.uri.fsPath))
      ]
    }
    webview.html = this.getHtml(webview)

    /** Text we last pushed to / received from the webview; guards echo loops. */
    let syncedText = document.getText()

    const postDocument = (): void => {
      void webview.postMessage({ type: 'setContent', text: document.getText() })
    }

    // Forward VS Code diagnostics (markdownlint, spell checkers…) so the webview
    // can paint them as underlines — a custom editor never shows the native ones.
    const postDiagnostics = (): void => {
      const items = vscode.languages.getDiagnostics(document.uri).map((d) => {
        const codeObj = typeof d.code === 'object' && d.code !== null ? d.code : undefined
        return {
          from: { line: d.range.start.line, character: d.range.start.character },
          to: { line: d.range.end.line, character: d.range.end.character },
          severity: d.severity,
          message: d.message,
          code: d.code != null ? String(codeObj ? codeObj.value : d.code) : undefined,
          source: d.source,
          href: codeObj?.target?.toString()
        }
      })
      void webview.postMessage({ type: 'diagnostics', items })
    }

    const postConfig = (): void => {
      const config = vscode.workspace.getConfiguration('mdforge', document.uri)
      void webview.postMessage({
        type: 'config',
        config: {
          fontSize: config.get<number>('fontSize', 15),
          pageWidth: config.get<string>('pageWidth', 'comfortable'),
          textAlign: config.get<string>('textAlign', 'left'),
          lineNumbers: config.get<boolean>('lineNumbers', true),
          appendSource: config.get<boolean>('paste.appendSource', false),
          sourceLabel: config.get<string>('paste.sourceLabel', "À partir de l'adresse"),
          debugPasteHtml: config.get<boolean>('debug.pasteHtml', false),
          enableInProgress: config.get<boolean>('checkbox.enableInProgress', true),
          mermaidTheme: config.get<string>('mermaid.theme', 'auto'),
          mermaidFitWidth: config.get<boolean>('mermaid.fitWidth', true),
          quickDiff: config.get<boolean>('quickDiff', true),
          assetsBaseUri: webview
            .asWebviewUri(vscode.Uri.file(path.dirname(document.uri.fsPath)))
            .toString()
        }
      })
    }

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return
      // Keep the outline in sync with heading edits (even our own round-trips).
      if (this.outline.active?.document.uri.toString() === document.uri.toString()) {
        this.outline.refresh()
      }
      // Ignore the change we caused ourselves when writing the webview's edit back.
      if (event.document.getText() === syncedText) return
      syncedText = event.document.getText()
      postDocument()
    })

    // Track which MDForge editor is active so the outline follows it.
    if (webviewPanel.active) this.outline.setActive(document, webview)
    const viewStateSubscription = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) this.outline.setActive(document, webview)
    })

    const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mdforge', document.uri)) postConfig()
    })

    const diagnosticsSubscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (event.uris.some((u) => u.toString() === document.uri.toString())) postDiagnostics()
    })

    // Added/modified/deleted markers in MDForge's own margin: a custom editor
    // gets none of VS Code's gutter decorations, and the API that would let it
    // render inside the diff editor is still proposed (CLAUDE.md §9).
    const quickDiff = new QuickDiff(document, (changes) => {
      void webview.postMessage({ type: 'quickDiff', changes })
    })

    // Auto-refresh rendered images when a co-located asset file changes on disk
    // (the link is unchanged, so the webview would otherwise show a stale cache).
    const assetWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.dirname(document.uri.fsPath),
        '**/*.{png,jpg,jpeg,gif,webp,avif,svg,bmp}'
      )
    )
    const postRefresh = (): void => void webview.postMessage({ type: 'refreshImages' })
    assetWatcher.onDidChange((uri) => {
      postRefresh()
      void this.rehashAsset(document, uri)
    })
    assetWatcher.onDidCreate(postRefresh)
    assetWatcher.onDidDelete(postRefresh)

    /*
     * A click on a workspace-search result opens MDForge with no idea of where
     * the match was: VS Code drops the range for a custom editor. The positions
     * are dug back out of the search view itself (src/searchreveal.ts), once,
     * when the editor opens.
     */
    const revealSearchMatch = async (): Promise<void> => {
      const enabled = vscode.workspace
        .getConfiguration('mdforge', document.uri)
        .get<boolean>('revealSearchMatch', true)
      if (!enabled) return
      const matches = await searchMatches(document.uri)
      if (matches.length > 0) void webview.postMessage({ type: 'searchMatches', matches })
    }

    webview.onDidReceiveMessage(
      async (message: {
        type: string
        text?: string
        target?: string
        url?: string
        id?: number
        data?: string
        mime?: string
        name?: string
        path?: string
        quiet?: boolean
        value?: string
        html?: string
        dump?: string
        refresh?: boolean
        range?: {
          from: { line: number; character: number }
          to: { line: number; character: number }
        }
      }) => {
        switch (message.type) {
          case 'ready':
            postConfig()
            postDocument()
            postDiagnostics()
            quickDiff.refresh()
            void revealSearchMatch()
            break
          case 'edit':
            // NOT merged into the tag index here: this fires on every keystroke,
            // so a tag being typed would persist every prefix of itself (`p`,
            // `pr`, `pro`…) with no way to take them back. Saving does it.
            if (typeof message.text === 'string' && message.text !== document.getText()) {
              syncedText = message.text
              await this.writeDocument(document, message.text)
            }
            break
          case 'openWikilink':
            if (message.target) await this.openWikilink(document, message.target)
            break
          case 'openExternal':
            if (message.url) await vscode.env.openExternal(vscode.Uri.parse(message.url))
            break
          case 'openTextEditor':
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default')
            break
          case 'insertImage':
            await this.insertImage(document, webview, message)
            break
          case 'importImagePath':
            await this.importImagePath(document, webview, message)
            break
          case 'localizeAssets':
            await this.localizeAssets(document)
            break
          case 'renameNote':
            await this.renameNote(document)
            break
          case 'moveNote':
            await this.moveNote(document)
            break
          case 'deleteNote':
            await this.deleteNote(document)
            break
          case 'normalizeBlankLines': {
            const norm = formatMarkdown(document.getText(), joinParagraphsEnabled(document.uri))
            if (norm !== document.getText()) await this.writeDocument(document, norm)
            break
          }
          case 'requestQuickFix':
            if (message.range) await this.runQuickFix(document, message.range)
            break
          case 'requestTags': {
            // First ask sweeps the workspace; afterwards the cache answers
            // instantly and only an explicit refresh sweeps again.
            const refresh = message.refresh === true
            if (refresh || !this.tagIndex.scanned) await this.tagIndex.scan(refresh)
            void webview.postMessage({ type: 'tags', ...this.tagIndex.snapshot() })
            break
          }
          case 'setPageWidth':
            // The toolbar button is a shortcut for `mdforge.pageWidth`, and the
            // config watcher echoes the new value to every open MDForge editor.
            // Write it back at the level where it is already set: a plain Global
            // write under a workspace value would be shadowed by it — the button
            // would flip, the echo would snap it back, and the user's global
            // preference would have changed behind their back. Default: Global,
            // a reading width being a user preference, not a project's.
            if (message.value === 'comfortable' || message.value === 'full') {
              const cfg = vscode.workspace.getConfiguration('mdforge', document.uri)
              const at = cfg.inspect<string>('pageWidth')
              const target =
                at?.workspaceFolderValue !== undefined
                  ? vscode.ConfigurationTarget.WorkspaceFolder
                  : at?.workspaceValue !== undefined
                    ? vscode.ConfigurationTarget.Workspace
                    : vscode.ConfigurationTarget.Global
              await cfg.update('pageWidth', message.value, target)
            }
            break
          case 'openSettings':
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:tribaud.mdforge'
            )
            break
          case 'debugPasteHtml': {
            // `dump` is the full multi-type clipboard dump from the debug button;
            // fall back to the old html/text shape for any legacy caller.
            const content =
              message.dump ??
              `==== text/html ====\n${message.html || '(empty)'}\n\n==== text/plain ====\n${message.text || '(empty)'}\n`
            const doc = await vscode.workspace.openTextDocument({
              content,
              language: message.dump ? 'markdown' : 'html'
            })
            await vscode.window.showTextDocument(doc, { preview: false })
            break
          }
          case 'error':
            console.error('[MDForge webview]', message.text)
            break
        }
      }
    )

    webviewPanel.onDidDispose(() => {
      this.openDocs.delete(document.uri.toString())
      changeSubscription.dispose()
      configSubscription.dispose()
      viewStateSubscription.dispose()
      diagnosticsSubscription.dispose()
      assetWatcher.dispose()
      quickDiff.dispose()
      this.outline.clear(document)
    })
  }

  /** Replace the entire document with new text in a single edit. */
  private async writeDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit()
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    )
    edit.replace(document.uri, fullRange, text)
    await vscode.workspace.applyEdit(edit)
  }

  /**
   * Run VS Code's code-action provider for a range (the diagnostic the user
   * clicked) and let them pick a quick fix from a native menu — the webview has
   * no lightbulb of its own. Applies the chosen action's edit and/or command.
   */
  private async runQuickFix(
    document: vscode.TextDocument,
    range: { from: { line: number; character: number }; to: { line: number; character: number } }
  ): Promise<void> {
    const target = new vscode.Range(
      range.from.line,
      range.from.character,
      range.to.line,
      range.to.character
    )
    const results = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
      'vscode.executeCodeActionProvider',
      document.uri,
      target
    )
    const actions = (results ?? []).filter(
      (a): a is vscode.CodeAction => a instanceof vscode.CodeAction
    )
    if (!actions.length) {
      void vscode.window.showInformationMessage('MDForge : aucune correction rapide disponible ici.')
      return
    }
    const pick = await vscode.window.showQuickPick(
      actions.map((a, index) => ({ label: a.title, index })),
      { placeHolder: 'Corrections rapides' }
    )
    if (!pick) return
    const chosen = actions[pick.index]
    if (chosen.edit) await vscode.workspace.applyEdit(chosen.edit)
    if (chosen.command) {
      await vscode.commands.executeCommand(chosen.command.command, ...(chosen.command.arguments ?? []))
    }
  }

  /**
   * Write image bytes next to the note following the configured convention
   * (folder + name pattern + content dedup) and return the note-relative link.
   * Shared by paste/drop/pick insertion and the "localize remote images" action.
   */
  private async saveAsset(
    document: vscode.TextDocument,
    bytes: Buffer,
    ext: string,
    originalName: string
  ): Promise<string> {
    const { relPath, dirUri, targetUri } = this.assetTarget(document, bytes, ext, originalName)
    // Dedup: reuse an existing file with identical content, else write it.
    let reused = false
    try {
      const existing = await vscode.workspace.fs.readFile(targetUri)
      if (Buffer.from(existing).equals(bytes)) reused = true
    } catch {
      // not present yet
    }
    if (!reused) {
      await vscode.workspace.fs.createDirectory(dirUri)
      await vscode.workspace.fs.writeFile(targetUri, bytes)
    }
    return relPath
  }

  /**
   * Compute the convention-conforming target (name + location) for an asset.
   * `noteNameOverride` lets a pending rename compute names for the *future*
   * note name while the file is still at its current path.
   */
  private assetTarget(
    document: vscode.TextDocument,
    bytes: Buffer,
    ext: string,
    originalName: string,
    noteNameOverride?: string
  ): { relPath: string; dirUri: vscode.Uri; targetUri: vscode.Uri; fileName: string } {
    const config = vscode.workspace.getConfiguration('mdforge', document.uri)
    const folder = (config.get<string>('images.folder', 'assets') ?? '').trim()
    const naming = config.get<string>('images.naming', '${noteName}-${hash}')
    const hashLength = Math.max(4, Math.min(32, config.get<number>('images.hashLength', 8)))

    const hash = crypto.createHash('md5').update(bytes).digest('hex').slice(0, hashLength)
    const noteName =
      noteNameOverride ?? path.basename(document.uri.fsPath).replace(/\.(md|markdown)$/i, '')
    const base = naming
      .replace(/\$\{noteName\}/g, noteName)
      .replace(/\$\{originalName\}/g, originalName)
      .replace(/\$\{hash\}/g, hash)
    const fileName = `${sanitizeFileName(base)}.${ext}`

    const noteDir = path.dirname(document.uri.fsPath)
    const dirUri = folder ? vscode.Uri.file(path.join(noteDir, folder)) : vscode.Uri.file(noteDir)
    const targetUri = vscode.Uri.joinPath(dirUri, fileName)
    return { relPath: folder ? `${folder}/${fileName}` : fileName, dirUri, targetUri, fileName }
  }

  /**
   * Rename every local asset referenced by the note to the convention name
   * (`NoteName-<hash>.ext` in the assets folder) and rewrite the links. Content
   * is unchanged, so only the note-derived name/location is corrected. Mirrors
   * `asset_fixer.py`. Returns the number of assets moved. Remote/`data:` links
   * are left to `localizeAssets`.
   */
  private async reconcileAssets(
    document: vscode.TextDocument,
    noteNameOverride?: string
  ): Promise<number> {
    const text = document.getText()
    const noteDir = path.dirname(document.uri.fsPath)
    const findLinks = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

    const sources = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = findLinks.exec(text)) !== null) {
      const src = match[1]
      if (!/^(https?:|data:|blob:|file:|vscode-|\/)/i.test(src)) sources.add(src)
    }
    if (sources.size === 0) return 0

    const moved = new Map<string, string>()
    for (const src of sources) {
      try {
        const decoded = decodeURI(src)
        const sourceUri = vscode.Uri.file(path.resolve(noteDir, decoded))
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(sourceUri))
        const ext =
          path.extname(sourceUri.fsPath).replace('.', '').toLowerCase() ||
          imageExtension(undefined, sourceUri.fsPath)
        const originalName = path.basename(sourceUri.fsPath, path.extname(sourceUri.fsPath))
        const { relPath, dirUri, targetUri } = this.assetTarget(
          document,
          bytes,
          ext,
          originalName,
          noteNameOverride
        )
        if (src.replace(/^\.\//, '') === relPath) continue // already conforms
        if (path.resolve(targetUri.fsPath) === path.resolve(sourceUri.fsPath)) continue

        // Dedup: if the target already holds this content, drop the source.
        let targetHasSame = false
        try {
          const existing = Buffer.from(await vscode.workspace.fs.readFile(targetUri))
          targetHasSame = existing.equals(bytes)
        } catch {
          // target free
        }
        if (targetHasSame) {
          await vscode.workspace.fs.delete(sourceUri)
        } else {
          await vscode.workspace.fs.createDirectory(dirUri)
          await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: false })
        }
        moved.set(src, relPath)
      } catch {
        // unreadable / missing → leave the link untouched
      }
    }

    if (moved.size > 0) {
      const newText = text.replace(
        /(!\[[^\]]*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g,
        (whole, pre: string, url: string, post: string) => {
          const rel = moved.get(url)
          return rel ? `${pre}${rel}${post}` : whole
        }
      )
      if (newText !== text) await this.writeDocument(document, newText)
    }
    return moved.size
  }

  /**
   * Save an image sent from the webview next to the note, then post the relative
   * link back so the webview can insert it at its saved position.
   */
  private async insertImage(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    message: { id?: number; data?: string; mime?: string; name?: string }
  ): Promise<void> {
    const id = message.id ?? 0
    try {
      if (!message.data) throw new Error('no image data received')
      const linkStyle = vscode.workspace
        .getConfiguration('mdforge', document.uri)
        .get<string>('images.linkStyle', 'markdown')
      const bytes = Buffer.from(message.data, 'base64')
      const originalName = message.name
        ? path.basename(message.name, path.extname(message.name))
        : 'image'
      const ext = imageExtension(message.mime, message.name)
      const src = await this.saveAsset(document, bytes, ext, originalName)
      void webview.postMessage({ type: 'imageInserted', id, src, alt: originalName, linkStyle })
    } catch (error) {
      void webview.postMessage({ type: 'imageInserted', id, error: String(error) })
      void vscode.window.showErrorMessage(`MDForge: could not insert image — ${error}`)
    }
  }

  /**
   * Import an existing file (dragged from the Explorer / another app as a URI)
   * into the assets folder and post the relative link back for insertion.
   */
  private async importImagePath(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    message: { id?: number; path?: string; quiet?: boolean }
  ): Promise<void> {
    const id = message.id ?? 0
    try {
      const source = message.path
      if (!source) throw new Error('no path received')
      let bytes: Buffer
      let ext: string
      let originalName: string
      // `data:`/`http(s):` can't be read through the file system — decode or
      // download them; a bare path or `file:`/other URI is a real file to read.
      if (/^data:image\//i.test(source) || /^https?:/i.test(source)) {
        const fetched = await fetchImageBytes(source)
        bytes = fetched.bytes
        ext = fetched.ext
        originalName = /^data:/i.test(source) ? 'image' : remoteBaseName(source)
      } else {
        const uri = /^[a-z][a-z0-9+.-]*:\/\//i.test(source)
          ? vscode.Uri.parse(source)
          : vscode.Uri.file(source)
        bytes = Buffer.from(await vscode.workspace.fs.readFile(uri))
        ext = imageExtension(undefined, uri.fsPath)
        originalName = path.basename(uri.fsPath, path.extname(uri.fsPath)) || 'image'
      }
      const linkStyle = vscode.workspace
        .getConfiguration('mdforge', document.uri)
        .get<string>('images.linkStyle', 'markdown')
      const src = await this.saveAsset(document, bytes, ext, originalName)
      void webview.postMessage({ type: 'imageInserted', id, src, alt: originalName, linkStyle })
    } catch (error) {
      void webview.postMessage({ type: 'imageInserted', id, error: String(error) })
      // Paste localization tries many images and expects some (auth-gated OneNote/
      // CDN URLs) to fail — stay quiet then, only log; a single drop/import warns.
      if (message.quiet) console.warn(`MDForge: could not import pasted image — ${error}`)
      else void vscode.window.showErrorMessage(`MDForge: could not import image — ${error}`)
    }
  }

  /**
   * Download every remote (`http(s):`) or embedded (`data:`) image referenced by
   * the note into the assets folder and rewrite the links to the local files.
   * Mirrors the vault's `asset_fixer.py` remote-download behavior.
   */
  private async localizeAssets(document: vscode.TextDocument): Promise<void> {
    const text = document.getText()
    const imageLink = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
    const urls = new Set<string>()
    let match: RegExpExecArray | null
    while ((match = imageLink.exec(text)) !== null) {
      const url = match[1]
      if (/^https?:/i.test(url) || /^data:image\//i.test(url)) urls.add(url)
    }
    if (urls.size === 0) {
      // Nothing to download, but still conform any existing local asset names.
      const conformed = await this.reconcileAssets(document)
      void vscode.window.showInformationMessage(
        conformed > 0
          ? `MDForge: renamed ${conformed} asset(s) to match the convention.`
          : 'MDForge: no remote images to localize and all asset names conform.'
      )
      return
    }

    const resolved = new Map<string, string>()
    let failed = 0
    for (const url of urls) {
      try {
        const { bytes, ext } = await fetchImageBytes(url)
        const originalName = /^data:/i.test(url) ? 'image' : remoteBaseName(url)
        resolved.set(url, await this.saveAsset(document, bytes, ext, originalName))
      } catch {
        failed += 1
      }
    }

    const newText = text.replace(
      /(!\[[^\]]*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g,
      (whole, pre: string, url: string, post: string) => {
        const rel = resolved.get(url)
        return rel ? `${pre}${rel}${post}` : whole
      }
    )
    if (newText !== text) await this.writeDocument(document, newText)

    // Also conform any pre-existing local asset names to the convention.
    const renamed = await this.reconcileAssets(document)

    const parts = [`localized ${resolved.size} image(s)`]
    if (failed) parts.push(`${failed} failed (left as links)`)
    if (renamed) parts.push(`renamed ${renamed} local asset(s)`)
    void vscode.window.showInformationMessage(`MDForge: ${parts.join(', ')}.`)
    // The document write triggers onDidChangeTextDocument → setContent, which
    // refreshes the webview with the now-local (rendered) images.
  }

  /**
   * When a co-located image's content changes, its file name's `<hash>` no longer
   * matches — re-hash (rename) it and update the link, per the configured policy
   * (`prompt` / `auto` / `off`). Triggered by the asset file-system watcher.
   */
  private async rehashAsset(document: vscode.TextDocument, changedUri: vscode.Uri): Promise<void> {
    const policy = vscode.workspace
      .getConfiguration('mdforge', document.uri)
      .get<string>('images.renameOnChange', 'prompt')
    if (policy === 'off') return

    const key = path.resolve(changedUri.fsPath)
    if (this.rehashing.has(key)) return // our own rename, or already handling

    const asset = this
      .localAssets(document)
      .find((a) => path.resolve(a.absPath) === key)
    if (!asset) return // not an image this note references

    let bytes: Buffer
    try {
      bytes = Buffer.from(await vscode.workspace.fs.readFile(changedUri))
    } catch {
      return
    }
    const ext =
      path.extname(changedUri.fsPath).replace('.', '').toLowerCase() ||
      imageExtension(undefined, changedUri.fsPath)
    const originalName = path.basename(changedUri.fsPath, path.extname(changedUri.fsPath))
    const { relPath, dirUri, targetUri, fileName } = this.assetTarget(
      document,
      bytes,
      ext,
      originalName
    )
    if (fileName === path.basename(changedUri.fsPath)) return // hash still matches

    // Guard before the prompt so rapid duplicate change events don't double-ask.
    const targetKey = path.resolve(targetUri.fsPath)
    this.rehashing.add(key)
    this.rehashing.add(targetKey)
    try {
      if (policy === 'prompt') {
        const choice = await vscode.window.showInformationMessage(
          `MDForge: "${path.basename(changedUri.fsPath)}" changed — rename to "${fileName}" so its hash matches the new content?`,
          'Rename',
          'Keep'
        )
        if (choice !== 'Rename') return
      }
      await vscode.workspace.fs.createDirectory(dirUri)
      await vscode.workspace.fs.rename(changedUri, targetUri, { overwrite: false })
      const text = document.getText()
      const newText = text.replace(
        /(!\[[^\]]*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g,
        (whole, pre: string, url: string, post: string) =>
          url === asset.src ? `${pre}${relPath}${post}` : whole
      )
      if (newText !== text) await this.writeDocument(document, newText)
    } catch (error) {
      void vscode.window.showErrorMessage(`MDForge: could not rename changed image — ${error}`)
    } finally {
      this.rehashing.delete(key)
      this.rehashing.delete(targetKey)
    }
  }

  /**
   * Rename the note file via a native input box, offering a one-click suggestion
   * that conforms to the vault convention (PascalCase-With-Dashes, ≤60 chars).
   * The file extension is preserved; open editors follow the rename.
   */
  private async renameNote(document: vscode.TextDocument): Promise<void> {
    const oldUri = document.uri
    const dir = path.dirname(oldUri.fsPath)
    const ext = path.extname(oldUri.fsPath)
    const currentBase = path.basename(oldUri.fsPath, ext)

    const validate = (raw: string): string | undefined => {
      const value = raw.trim()
      if (!value) return 'Name cannot be empty'
      if (value.length > 60) return `Too long (${value.length}/60)`
      if (/[\\/:*?"<>|]/.test(value)) return 'Contains characters not allowed in a file name'
      return undefined
    }

    const input = vscode.window.createInputBox()
    input.title = 'MDForge — Rename note'
    input.value = currentBase
    input.prompt = 'New file name (PascalCase-With-Dashes, ≤60 characters). Extension is kept.'
    input.buttons = [
      {
        iconPath: new vscode.ThemeIcon('sparkle'),
        tooltip: 'Suggest a PascalCase-With-Dashes name (≤60 chars)'
      }
    ]
    input.onDidChangeValue((value) => {
      input.validationMessage = validate(value)
    })
    input.onDidTriggerButton(() => {
      input.value = suggestNoteName(input.value || currentBase)
    })
    input.onDidAccept(async () => {
      const value = input.value.trim()
      const error = validate(value)
      if (error) {
        input.validationMessage = error
        return
      }
      if (value === currentBase) {
        input.hide()
        return
      }
      const newUri = vscode.Uri.file(path.join(dir, value + ext))
      try {
        await vscode.workspace.fs.stat(newUri)
        input.validationMessage = 'A file with that name already exists'
        return
      } catch {
        // free to use
      }
      input.busy = true
      try {
        // Reconcile assets to the FUTURE name and rewrite links *before* the
        // rename, while the document is still the one the open editor is bound
        // to — so the webview refreshes (otherwise it keeps the stale links and
        // the renamed images render broken until the file is reopened).
        const count = await this.reconcileAssets(document, value)
        if (document.isDirty) await document.save()
        // Now move the note file; the editor follows, content already correct.
        const edit = new vscode.WorkspaceEdit()
        edit.renameFile(oldUri, newUri)
        const done = await vscode.workspace.applyEdit(edit)
        if (!done) throw new Error('rename was rejected')
        input.hide()
        if (count > 0) {
          void vscode.window.showInformationMessage(
            `MDForge: renamed note and ${count} asset(s) to match.`
          )
        }
      } catch (renameError) {
        input.validationMessage = `Rename failed: ${renameError}`
      } finally {
        input.busy = false
      }
    })
    input.onDidHide(() => input.dispose())
    input.show()
  }

  /** Local (relative) image links of a note, as `{ src, absPath }`. */
  private localAssets(document: vscode.TextDocument): Array<{ src: string; absPath: string }> {
    const noteDir = path.dirname(document.uri.fsPath)
    const findLinks = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
    const assets: Array<{ src: string; absPath: string }> = []
    const seen = new Set<string>()
    let match: RegExpExecArray | null
    const text = document.getText()
    while ((match = findLinks.exec(text)) !== null) {
      const src = match[1]
      if (/^(https?:|data:|blob:|file:|vscode-|\/)/i.test(src)) continue
      if (seen.has(src)) continue
      seen.add(src)
      assets.push({ src, absPath: path.resolve(noteDir, decodeURI(src)) })
    }
    return assets
  }

  /** Which of `assetPaths` are also referenced by another note in the workspace. */
  private async assetsSharedElsewhere(
    document: vscode.TextDocument,
    assetPaths: Set<string>
  ): Promise<string[]> {
    if (assetPaths.size === 0) return []
    const files = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**')
    const shared = new Set<string>()
    for (const file of files) {
      if (file.toString() === document.uri.toString()) continue
      let text: string
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')
      } catch {
        continue
      }
      const dir = path.dirname(file.fsPath)
      const re = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const src = m[1]
        if (/^(https?:|data:|blob:|file:|vscode-|\/)/i.test(src)) continue
        const abs = path.resolve(dir, decodeURI(src))
        if (assetPaths.has(abs)) {
          shared.add(`${path.basename(abs)} (also in ${path.basename(file.fsPath)})`)
        }
      }
    }
    return [...shared]
  }

  /**
   * Move the note and its co-located assets to another workspace folder. Aborts
   * with a warning if any asset is also used by a different note (moving it
   * would break that note). Links are relative, so preserving the folder layout
   * keeps them valid — no rewrite needed. Mirrors `para_mover.py`.
   */
  private async moveNote(document: vscode.TextDocument): Promise<void> {
    const oldUri = document.uri
    const noteDir = path.dirname(oldUri.fsPath)
    const assets = this.localAssets(document)

    // Safety: refuse to move assets shared with another note.
    const shared = await this.assetsSharedElsewhere(
      document,
      new Set(assets.map((a) => a.absPath))
    )
    if (shared.length > 0) {
      void vscode.window.showWarningMessage(
        `MDForge: cannot move — these assets are used by other notes:\n${shared.join('\n')}`,
        { modal: true }
      )
      return
    }

    // Pick the destination folder.
    const workspaceUri = vscode.workspace.getWorkspaceFolder(oldUri)?.uri
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: workspaceUri,
      openLabel: 'Move here',
      title: 'Move note & assets to…'
    })
    if (!picked || picked.length === 0) return
    const destDir = picked[0].fsPath
    if (path.resolve(destDir) === path.resolve(noteDir)) return // same folder

    const newUri = vscode.Uri.file(path.join(destDir, path.basename(oldUri.fsPath)))
    try {
      await vscode.workspace.fs.stat(newUri)
      void vscode.window.showErrorMessage('MDForge: a note with that name already exists there.')
      return
    } catch {
      // free to use
    }

    try {
      // Move each asset, preserving its path relative to the note (keeps links valid).
      for (const asset of assets) {
        const sourceUri = vscode.Uri.file(asset.absPath)
        try {
          await vscode.workspace.fs.stat(sourceUri)
        } catch {
          continue // asset missing on disk → skip it, leave the link
        }
        const targetUri = vscode.Uri.file(path.resolve(destDir, decodeURI(asset.src)))
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)))
        await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: false })
      }
      // Move the note file (the open editor follows it).
      const edit = new vscode.WorkspaceEdit()
      edit.renameFile(oldUri, newUri)
      const done = await vscode.workspace.applyEdit(edit)
      if (!done) throw new Error('move was rejected')

      // Re-open fresh at the new location so the webview rebinds its asset base
      // URI + local-resource root to the destination folder (images resolve).
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.commands.executeCommand('vscode.openWith', newUri, VIEW_TYPE)

      void vscode.window.showInformationMessage(
        `MDForge: moved note${assets.length ? ` and ${assets.length} asset(s)` : ''} to ${vscode.workspace.asRelativePath(destDir)}.`
      )
    } catch (moveError) {
      void vscode.window.showErrorMessage(`MDForge: move failed — ${moveError}`)
    }
  }

  /** Which of `assetPaths` are also referenced by another note (as abs paths). */
  private async sharedAssetPaths(
    document: vscode.TextDocument,
    assetPaths: Set<string>
  ): Promise<Set<string>> {
    const shared = new Set<string>()
    if (assetPaths.size === 0) return shared
    const files = await vscode.workspace.findFiles('**/*.{md,markdown}', '**/node_modules/**')
    for (const file of files) {
      if (file.toString() === document.uri.toString()) continue
      let text: string
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')
      } catch {
        continue
      }
      const dir = path.dirname(file.fsPath)
      const re = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const src = m[1]
        if (/^(https?:|data:|blob:|file:|vscode-|\/)/i.test(src)) continue
        const abs = path.resolve(dir, decodeURI(src))
        if (assetPaths.has(abs)) shared.add(abs)
      }
    }
    return shared
  }

  /**
   * Delete the note and its co-located assets, after a modal confirmation that
   * lists exactly what will go. Assets also referenced by another note are kept
   * (deleting them would break that note) and listed as such. Everything goes to
   * the OS trash (recoverable), not a hard delete.
   */
  private async deleteNote(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri
    const name = path.basename(uri.fsPath)

    // Assets referenced by this note that actually exist on disk.
    const existing: string[] = []
    for (const asset of this.localAssets(document)) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(asset.absPath))
        existing.push(asset.absPath)
      } catch {
        // missing on disk → nothing to delete
      }
    }
    const shared = await this.sharedAssetPaths(document, new Set(existing))
    const toDelete = existing.filter((p) => !shared.has(p))
    const kept = existing.filter((p) => shared.has(p))

    const sections: string[] = []
    if (toDelete.length) {
      sections.push(
        `Assets to delete (${toDelete.length}):\n` +
          toDelete.map((p) => `  • ${path.basename(p)}`).join('\n')
      )
    }
    if (kept.length) {
      sections.push(
        `Kept — shared with other notes (${kept.length}):\n` +
          kept.map((p) => `  • ${path.basename(p)}`).join('\n')
      )
    }
    const detail = sections.join('\n\n') || 'This note has no co-located assets.'

    const choice = await vscode.window.showWarningMessage(
      `Delete “${name}” and its assets? This moves them to the trash.`,
      { modal: true, detail },
      'Delete'
    )
    if (choice !== 'Delete') return

    try {
      for (const p of toDelete) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true })
        } catch {
          // best-effort per asset; keep going
        }
      }
      // Close this editor before removing the file so no stale view lingers.
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.workspace.fs.delete(uri, { useTrash: true })
      void vscode.window.showInformationMessage(
        `MDForge: deleted ${name}${toDelete.length ? ` and ${toDelete.length} asset(s)` : ''}.`
      )
    } catch (deleteError) {
      void vscode.window.showErrorMessage(`MDForge: delete failed — ${deleteError}`)
    }
  }

  /** Resolve a `[[wikilink]]` target relative to the document and open it. */
  private async openWikilink(document: vscode.TextDocument, target: string): Promise<void> {
    const dir = path.dirname(document.uri.fsPath)
    const candidates = [target]
    if (!/\.[a-z0-9]+$/i.test(target)) candidates.push(`${target}.md`, `${target}.markdown`)
    for (const relative of candidates) {
      const uri = vscode.Uri.file(path.resolve(dir, relative))
      try {
        await vscode.workspace.fs.stat(uri)
        await vscode.commands.executeCommand('vscode.open', uri)
        return
      } catch {
        // try the next candidate
      }
    }
    void vscode.window.showWarningMessage(`MDForge: wikilink target not found: ${target}`)
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce()
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dist', 'main.js')
    )
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dist', 'main.css')
    )
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'`,
      `worker-src ${webview.cspSource} blob:`,
      `connect-src ${webview.cspSource} https: data: blob:`
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>MDForge</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let text = ''
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return text
}
