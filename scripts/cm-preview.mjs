/*
 * Headless preview of the MDForge webview — a stand-in for F5 when there is no
 * GUI. Serves media/dist, mocks the VS Code webview API, feeds a Markdown
 * sample, drives it in headless Chrome (system install), and writes a PNG +
 * reports any console/page errors.
 *
 * Usage: node scripts/cm-preview.mjs [file.md] [out.png]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'media', 'dist')

const inFile = process.argv[2]
const outPng = path.resolve(process.argv[3] || path.join(root, 'preview.png'))

const SAMPLE = `# MDForge — aperçu

Du texte **gras**, *italique*, \`code\`, ~~barré~~ et un [lien](https://example.com).

- [ ] à faire zfs_backup
- [~] en cours
- [x] fait

## Tableau

| Feature | État |
| :------ | :--: |
| Mermaid | ok   |
| Tables  | ok   |

## Diagramme

\`\`\`mermaid
graph TD
  A[Start] --> B{OK?}
  B -->|oui| C[Rendu]
  B -->|non| D[Erreur]
\`\`\`

\`\`\`js
const x = 1
\`\`\`
`

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

const DARK = process.env.THEME === 'dark'
const LIGHT_VARS = `
  --vscode-editor-background:#ffffff; --vscode-editor-foreground:#1f2328;
  --vscode-textLink-foreground:#0969da; --vscode-editorCursor-foreground:#1f2328;
  --vscode-editor-selectionBackground:#cce5ff;
  --vscode-editorWidget-border:#d0d7de; --vscode-editorWidget-background:#ffffff;
  --vscode-textCodeBlock-background:#f6f8fa; --vscode-toolbar-hoverBackground:#eaeef2;
  --vscode-descriptionForeground:#656d76;`
const DARK_VARS = `
  --vscode-editor-background:#1f1f1f; --vscode-editor-foreground:#cccccc;
  --vscode-textLink-foreground:#4daafc; --vscode-editorCursor-foreground:#cccccc;
  --vscode-editor-selectionBackground:#264f78;
  --vscode-editorWidget-border:#454545; --vscode-editorWidget-background:#252526;
  --vscode-textCodeBlock-background:#2a2a2a; --vscode-toolbar-hoverBackground:#3a3a3a;
  --vscode-descriptionForeground:#9d9d9d;`

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/main.css">
<style>:root{${DARK ? DARK_VARS : LIGHT_VARS}}</style></head><body><div id="app"></div>
<script type="module" src="/main.js"></script></body></html>`)
    return
  }
  const file = path.join(dist, path.basename(url))
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
})

await new Promise((r) => server.listen(0, r))
const port = server.address().port

const doc = inFile ? fs.readFileSync(path.resolve(inFile), 'utf8') : SAMPLE
const errors = []

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 1100 }, deviceScaleFactor: 2 })
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

await page.addInitScript(() => {
  window.__posted = []
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    getState: () => undefined,
    setState: () => undefined
  })
})

await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
await page.evaluate((text) => {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config: { fontSize: 15, mermaidTheme: 'default' } } }))
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'setContent', text } }))
}, doc)

// Give Mermaid (dynamic import) time to render.
await page.waitForTimeout(1500)

const posted = await page.evaluate(() => window.__posted)
await page.screenshot({ path: outPng, fullPage: true })
await browser.close()
server.close()

console.log(`screenshot: ${outPng}`)
console.log(`posted messages: ${JSON.stringify(posted?.map((m) => m.type))}`)
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console/page errors')
