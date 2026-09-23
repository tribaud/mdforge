/*
 * MDForge — the host round-trip: what the editor sends, and what comes back.
 *
 * The webview posts one `edit` per keystroke. Under key repeat those messages
 * arrive faster than `applyEdit` lands, and getting that wrong is not a cosmetic
 * bug: the host used to push a stale whole-document `setContent` back into the
 * webview mid-typing, which moved the caret and ate characters. No other test
 * covered this path, and it broke twice.
 *
 * So the compiled extension is loaded here with a fake `vscode` whose document
 * really mutates and really fires `onDidChangeTextDocument`, and one editor is
 * driven through a burst. What is asserted is the contract:
 *   - opening answers `ready` with the content,
 *   - a burst leaves the document on the LAST keystroke,
 *   - and nothing of our own writing is echoed back,
 *   - while a change nobody here wrote IS forwarded.
 *
 * Run: `npm run test:sync` (compiles the extension first).
 */
const Module = require('module')
const path = require('path')
const ext = path.resolve(__dirname, '..')

const noop = () => {}
const disposable = { dispose: noop }
const evt = () => disposable
const stub = (name) => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : stub(`${name}.${String(k)}`)),
  apply: () => stub(`${name}()`),
  construct: () => stub(`new ${name}`)
})

const posted = []
const messageHandlers = []

const current = { text: '# Titre\n\nDu texte.\n' }
const vscode = {
  __onChange: [],
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }),
    joinPath: (u, ...p) => ({ ...u, fsPath: path.join(u.fsPath, ...p) }),
    parse: (s) => ({ toString: () => s })
  },
  Range: class { constructor(a, b) { this.start = a; this.end = b } },
  Position: class { constructor(l, c) { this.line = l; this.character = c } },
  WorkspaceEdit: class { replace(uri, range, text) { this.__text = text } },
  EventEmitter: class { constructor() { this.event = evt } fire() {} },
  Disposable: class { dispose() {} },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { One: 1, Beside: -2 },
  DiagnosticSeverity: { Error: 0 },
  commands: { registerCommand: () => disposable, executeCommand: async () => undefined, getCommands: async () => [] },
  languages: { getDiagnostics: () => [], onDidChangeDiagnostics: evt },
  extensions: { getExtension: () => undefined },
  env: { openExternal: async () => true, clipboard: { readText: async () => '' } },
  window: {
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: noop, hide: noop, dispose: noop }),
    registerCustomEditorProvider: (id, provider) => { vscode.__provider = provider; return disposable },
    registerTreeDataProvider: () => disposable,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    onDidChangeActiveTextEditor: evt,
    activeTextEditor: undefined,
    tabGroups: { all: [], onDidChangeTabs: evt }
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d, inspect: () => undefined, update: async () => undefined }),
    onDidChangeTextDocument: (h) => { vscode.__onChange.push(h); return disposable },
    onDidChangeConfiguration: evt,
    onDidSaveTextDocument: evt,
    onWillSaveTextDocument: evt,
    createFileSystemWatcher: () => ({ onDidChange: evt, onDidCreate: evt, onDidDelete: evt, dispose: noop }),
    applyEdit: async (edit) => {
      // One whole-document replace, exactly like the real one.
      await new Promise((r) => setTimeout(r, 5))
      current.text = edit.__text
      for (const h of vscode.__onChange) h({ document })
      return true
    },
    fs: { stat: async () => ({}), readFile: async () => new Uint8Array() },
    findFiles: async () => [],
    getWorkspaceFolder: () => undefined,
    workspaceFolders: [],
    asRelativePath: (p) => String(p),
    openTextDocument: async () => ({ getText: () => '' })
  },
  RelativePattern: class {}
}

const realLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode
  return realLoad.apply(this, arguments)
}

const api = require(path.join(ext, 'out', 'extension.js'))
const context = {
  extensionUri: vscode.Uri.file(ext),
  subscriptions: [],
  workspaceState: { get: () => undefined, update: async () => undefined }
}
api.activate(context)

const document = {
  uri: vscode.Uri.file(path.join(ext, 'examples', 'demo.md')),
  languageId: 'markdown',
  lineCount: 3,
  getText: () => current.text,
  lineAt: (n) => ({ text: current.text.split('\n')[n] ?? '' }),
  positionAt: (o) => new vscode.Position(0, o),
  save: async () => true
}
const webview = {
  options: {},
  html: '',
  cspSource: 'vscode-webview:',
  asWebviewUri: (u) => u,
  postMessage: async (m) => { posted.push(m.type); return true },
  onDidReceiveMessage: (h) => { messageHandlers.push(h); return disposable }
}
const panel = {
  webview,
  active: true,
  visible: true,
  viewColumn: 1,
  onDidDispose: evt,
  onDidChangeViewState: evt,
  reveal: noop,
  dispose: noop
}

;(async () => {
  let failures = 0
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) console.log(`  ok   ${name}`)
    else {
      failures++
      console.log(`  FAIL ${name}\n       expected ${b}\n       got      ${a}`)
    }
  }

  try {
    await vscode.__provider.resolveCustomTextEditor(document, panel, { isCancellationRequested: false })
  } catch (error) {
    console.log('resolve threw:', error && error.stack ? error.stack : error)
    process.exit(1)
  }
  check('resolve registers a message handler', messageHandlers.length, 1)
  const handler = messageHandlers[0]

  await handler({ type: 'ready' })
  check('the editor is answered with its content', posted.includes('setContent'), true)

  // A held Backspace: several whole-document edits in flight at once.
  posted.length = 0
  const burst = ['# Titre\n\nDu text', '# Titre\n\nDu tex', '# Titre\n\nDu te', '# Titre\n\nDu t']
  await Promise.all(burst.map((t) => handler({ type: 'edit', text: t })))
  await new Promise((r) => setTimeout(r, 150))
  check('the document ends on the last keystroke', current.text, burst[burst.length - 1])
  check(
    'nothing we wrote is pushed back mid-typing',
    posted.filter((p) => p === 'setContent').length,
    0
  )

  // A change nobody here wrote — a `git checkout`, another editor, a formatter.
  posted.length = 0
  current.text = '# Titre\n\nRéécrit ailleurs.\n'
  for (const h of vscode.__onChange) h({ document })
  await new Promise((r) => setTimeout(r, 20))
  check('an external change IS forwarded', posted.includes('setContent'), true)

  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
})()
