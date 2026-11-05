/*
 * MDForge — undo / redo stay in CodeMirror, and an external change neither
 * moves the view nor lands in the history.
 *
 * Cmd+Z used to undo TWICE: CodeMirror, then VS Code on the TextDocument (the
 * webview forwards every keydown to the window, where VS Code listens). The
 * second undo came back as a whole-document `setContent`, which moved the
 * scroll and entered CodeMirror's history — the next Cmd+Z undid that.
 *
 * Run: `npm run test:undo` (builds the webview first; needs Chrome).
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
  // Stands in for VS Code's webview listener, which sits on the window.
  window.__vscodeUndo = 0
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) window.__vscodeUndo++
  })
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState() {}, setState() {} })
})
await page.goto(`http://localhost:${server.address().port}/`)
await page.evaluate(() =>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config: { fontSize: 14 } } }))
)

const doc = () => page.evaluate(() => [...window.__posted].reverse().find((m) => m.type === 'edit')?.text ?? '')
const setDoc = async (text) => {
  await page.evaluate(
    (text) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setContent', text } })),
    text
  )
  await page.waitForTimeout(300)
}
/** Clicks inside the rendered text `txt`, `dx` characters in. */
const clickText = async (txt, dx = 0) => {
  const p = await page.evaluate(
    ([txt, dx]) => {
      for (const l of document.querySelectorAll('.cm-line')) {
        const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          const i = n.data.indexOf(txt)
          if (i < 0) continue
          const r = document.createRange()
          r.setStart(n, i + dx)
          r.setEnd(n, i + dx)
          const b = r.getBoundingClientRect()
          return { x: b.left + 1, y: b.top + b.height / 2 }
        }
      }
      return null
    },
    [txt, dx]
  )
  if (!p) throw new Error(`text not found: ${txt}`)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(100)
}

let failed = 0
const check = (ok, label, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const vscodeUndos = () => page.evaluate(() => window.__vscodeUndo)
const scrollTop = () => page.evaluate(() => Math.round(document.querySelector('.cm-scroller').scrollTop))
const caret = () => page.evaluate(() => { const s = window.getSelection(); return s.anchorNode?.parentElement?.closest('.cm-line')?.textContent + '@' + s.anchorOffset })

const lines = Array.from({ length: 200 }, (_, n) => `Ligne ${n}`)
const base = lines.join('\n') + '\n'
await setDoc(base)

// Scroll to the middle, type there.
await page.evaluate(() => (document.querySelector('.cm-scroller').scrollTop = 2000))
await page.waitForTimeout(200)
const target = await page.evaluate(() => [...document.querySelectorAll('.cm-line')].find((l) => l.getBoundingClientRect().top > 300)?.textContent)
await clickText(target, target.length)
await page.keyboard.type('XYZ')
await page.waitForTimeout(700)
await page.keyboard.type('W')
await page.waitForTimeout(150)
check((await doc()).includes(target + 'XYZW'), '1. typed in the middle of a long note')

await page.keyboard.press('ControlOrMeta+z')
await page.waitForTimeout(150)
check((await doc()).includes(target + 'XYZ\n'), '2. Cmd+Z undoes the last edit', JSON.stringify((await doc()).match(new RegExp(target + '.*'))?.[0]))
check((await vscodeUndos()) === 0, '3. ...and never reaches VS Code', String(await vscodeUndos()))

// An external change far from the caret (line 2): no scroll, no caret move.
const top = await scrollTop()
const where = await caret()
const current = await doc()
await setDoc(current.replace('Ligne 2\n', 'Ligne 2 (modifiée ailleurs)\n'))
check(Math.abs((await scrollTop()) - top) <= 1, '4. an external change elsewhere does not scroll', `${top} → ${await scrollTop()}`)
check((await caret()) === where, '5. ...nor move the caret', `${where} → ${await caret()}`)

// Cmd+Z now undoes the USER's edit, not the external one.
await page.keyboard.press('ControlOrMeta+z')
await page.waitForTimeout(150)
const after = await doc()
check(after.includes(target + '\n') && !after.includes(target + 'X'), '6. the next Cmd+Z undoes the user\'s edit')
check(after.includes('Ligne 2 (modifiée ailleurs)'), '7. ...and keeps the external change')
check(Math.abs((await scrollTop()) - top) <= 40, '8. ...without jumping away', `${top} → ${await scrollTop()}`)

await page.keyboard.press('ControlOrMeta+Shift+z')
await page.waitForTimeout(150)
check((await doc()).includes(target + 'XYZ\n'), '9. Cmd+Maj+Z redoes')

// Nothing left: Cmd+Z must not empty the note (the first load is not undoable).
for (let n = 0; n < 6; n++) await page.keyboard.press('ControlOrMeta+z')
await page.waitForTimeout(150)
check((await doc()).includes('Ligne 199'), '10. undoing everything never empties the note')
check((await vscodeUndos()) === 0, '11. still nothing reached VS Code')

// From the search field: the browser's undo, not VS Code's.
await page.keyboard.press('ControlOrMeta+f')
await page.waitForTimeout(150)
await page.keyboard.type('Lig')
await page.keyboard.press('ControlOrMeta+z')
await page.waitForTimeout(100)
check((await vscodeUndos()) === 0, '12. Cmd+Z in the search field stays in the webview')

if (errors.length) {
  failed++
  console.log('  ✗ page errors', errors)
}
await browser.close()
server.close()
if (failed) process.exit(1)
