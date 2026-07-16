import * as path from 'path'
import * as vscode from 'vscode'

const VIEW_TYPE = 'mdforge.editor'

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MdForgeEditorProvider(context)

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
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

export function deactivate(): void {}

class MdForgeEditorProvider implements vscode.CustomTextEditorProvider {
  public constructor(private readonly context: vscode.ExtensionContext) {}

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
          enableInProgress: config.get<boolean>('checkbox.enableInProgress', true)
        }
      })
    }

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return
      // Ignore the change we caused ourselves when writing the webview's edit back.
      if (event.document.getText() === syncedText) return
      syncedText = event.document.getText()
      postDocument()
    })

    const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mdforge', document.uri)) postConfig()
    })

    webview.onDidReceiveMessage(async (message: { type: string; text?: string }) => {
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
      }
    })

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose()
      configSubscription.dispose()
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
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`
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
