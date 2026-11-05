/*
 * MDForge — the table-of-contents panel resized with the mouse.
 *
 * The grip on the panel's right edge paints the width live and posts
 * `setTocWidth` ONCE, on release; a double-click puts the default back; the
 * width is clamped; a `config` echo applies the setting.
 *
 * Run: `npm run test:toc` (builds the webview first; needs Chrome).
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'media', 'dist')
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' }

if (!fs.existsSync(path.join(dist, 'main.js'))) {
  console.error('media/dist/main.js missing — run `npm run build:webview` first.')
  process.exit(1)
}

const DOC = ['# Un', '', 'texte', '', '## Deux', '', 'texte', ''].join('\n')

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><html data-vscode-theme-kind="vscode-light"><head><meta charset="utf-8">' +
        '<link rel="stylesheet" href="/main.css"></head>' +
        '<body class="vscode-light"><div id="app"></div><script type="module" src="/main.js"></script></body></html>'
    )
    return
  }
  fs.readFile(path.join(dist, path.basename(url)), (err, buf) => {
    if (err) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(url)] || 'application/octet-stream' })
    res.end(buf)
  })
})
await new Promise((r) => server.listen(0, r))

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.addInitScript(() => {
  window.__posted = []
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState() {}, setState() {} })
})
await page.goto(`http://localhost:${server.address().port}/`)
await page.evaluate((text) => {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config: { fontSize: 14, tocVisible: true } } }))
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'setContent', text } }))
}, DOC)
await page.waitForTimeout(600)

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const lastDoc = () => page.evaluate(() => [...window.__posted].reverse().find((m) => m.type === 'edit')?.text ?? null)
const edits = () => page.evaluate(() => window.__posted.filter((m) => m.type === 'edit').length)
const tocWidth = () => page.evaluate(() => Math.round(document.querySelector('.cm-toc').getBoundingClientRect().width))
const posts = () => page.evaluate(() => window.__posted.filter((m) => m.type === 'setTocWidth').map((m) => m.width))
const grip = async () => {
  const r = await page.evaluate(() => {
    const b = document.querySelector('.cm-toc-resizer').getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + 200, w: b.width }
  })
  return r
}

check((await tocWidth()) === 240, '1. default width is 240px', String(await tocWidth()))
let g = await grip()
check(g.w > 0, '2. the grip is shown with the panel')
const editorLeft = () => page.evaluate(() => Math.round(document.querySelector('#app').getBoundingClientRect().left))
check(Math.abs((await editorLeft()) - 240) <= 1, '3. the grip takes no room of its own', String(await editorLeft()))

await page.mouse.move(g.x, g.y)
await page.mouse.down()
await page.mouse.move(g.x + 50, g.y, { steps: 5 })
check((await tocWidth()) === 290, '4. the width follows the drag live', String(await tocWidth()))
check((await posts()).length === 0, '5. nothing is posted while dragging')
await page.mouse.move(g.x + 60, g.y, { steps: 2 })
await page.mouse.up()
check(JSON.stringify(await posts()) === '[300]', '6. one setTocWidth on release', JSON.stringify(await posts()))
check(!(await page.evaluate(() => document.body.classList.contains('mdforge-toc-resizing'))), '7. teardown on release')

g = await grip()
await page.mouse.move(g.x, g.y)
await page.mouse.down()
await page.mouse.move(g.x - 800, g.y, { steps: 5 })
await page.mouse.up()
check((await tocWidth()) === 140, '8. clamped at the minimum', String(await tocWidth()))

g = await grip()
await page.mouse.dblclick(g.x, g.y)
check((await tocWidth()) === 240, '9. double-click puts the default back', String(await tocWidth()))
check((await posts()).at(-1) === 240, '10. ...and writes it')

g = await grip()
await page.mouse.click(g.x, g.y)
await page.waitForTimeout(400)
const n = (await posts()).length
check(n === 3, '11. a plain click writes nothing', String(n))

await page.evaluate(() =>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config: { tocWidth: 420 } } }))
)
check((await tocWidth()) === 420, '12. the setting applies from config', String(await tocWidth()))

await page.evaluate(() =>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config: { tocVisible: false } } }))
)
check((await page.evaluate(() => getComputedStyle(document.querySelector('.cm-toc-resizer')).display)) === 'none', '13. the grip hides with the panel')

check(errors.length === 0, 'no page errors', errors.join(' | '))
await browser.close()
server.close()
if (failed) process.exit(1)
