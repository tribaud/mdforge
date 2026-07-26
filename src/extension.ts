import * as crypto from 'crypto'
import * as path from 'path'
import * as vscode from 'vscode'

const VIEW_TYPE = 'mdforge.editor'

export function activate(context: vscode.ExtensionContext): void {
  const outline = new OutlineProvider()
  const provider = new MdForgeEditorProvider(context, outline)

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
    })
  )
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

class MdForgeEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outline: OutlineProvider
  ) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
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

    const postConfig = (): void => {
      const config = vscode.workspace.getConfiguration('mdforge', document.uri)
      void webview.postMessage({
        type: 'config',
        config: {
          fontSize: config.get<number>('fontSize', 15),
          pageWidth: config.get<string>('pageWidth', 'comfortable'),
          enableInProgress: config.get<boolean>('checkbox.enableInProgress', true),
          mermaidTheme: config.get<string>('mermaid.theme', 'auto'),
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

    // Auto-refresh rendered images when a co-located asset file changes on disk
    // (the link is unchanged, so the webview would otherwise show a stale cache).
    const assetWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        path.dirname(document.uri.fsPath),
        '**/*.{png,jpg,jpeg,gif,webp,avif,svg,bmp}'
      )
    )
    const postRefresh = (): void => void webview.postMessage({ type: 'refreshImages' })
    assetWatcher.onDidChange(postRefresh)
    assetWatcher.onDidCreate(postRefresh)
    assetWatcher.onDidDelete(postRefresh)

    webview.onDidReceiveMessage(
      async (message: {
        type: string
        text?: string
        target?: string
        id?: number
        data?: string
        mime?: string
        name?: string
        path?: string
      }) => {
        switch (message.type) {
          case 'ready':
            postConfig()
            postDocument()
            break
          case 'edit':
            if (typeof message.text === 'string' && message.text !== document.getText()) {
              syncedText = message.text
              await this.writeDocument(document, message.text)
            }
            break
          case 'openWikilink':
            if (message.target) await this.openWikilink(document, message.target)
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
          case 'openSettings':
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              '@ext:tribaud.mdforge'
            )
            break
          case 'error':
            console.error('[MDForge webview]', message.text)
            break
        }
      }
    )

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose()
      configSubscription.dispose()
      viewStateSubscription.dispose()
      assetWatcher.dispose()
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
    message: { id?: number; path?: string }
  ): Promise<void> {
    const id = message.id ?? 0
    try {
      if (!message.path) throw new Error('no path received')
      const uri = /^[a-z][a-z0-9+.-]*:\/\//i.test(message.path)
        ? vscode.Uri.parse(message.path)
        : vscode.Uri.file(message.path)
      const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri))
      const linkStyle = vscode.workspace
        .getConfiguration('mdforge', document.uri)
        .get<string>('images.linkStyle', 'markdown')
      const originalName = path.basename(uri.fsPath, path.extname(uri.fsPath)) || 'image'
      const ext = imageExtension(undefined, uri.fsPath)
      const src = await this.saveAsset(document, bytes, ext, originalName)
      void webview.postMessage({ type: 'imageInserted', id, src, alt: originalName, linkStyle })
    } catch (error) {
      void webview.postMessage({ type: 'imageInserted', id, error: String(error) })
      void vscode.window.showErrorMessage(`MDForge: could not import image — ${error}`)
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
