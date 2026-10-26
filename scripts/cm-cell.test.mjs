/*
 * MDForge — editing a table cell IN the cell (headless).
 *
 * A double-click opens a cell's raw Markdown inside the cell itself, with the
 * table still rendered around it. These checks lock in what that promises: the
 * field lives in the cell and fits it, `Entrée` writes only that cell, raw HTML
 * renders (a `<script>` never survives), `Maj+Entrée` writes a `<br>` that comes
 * back as a line, and opening then closing a cell without a change writes
 * nothing.
 *
 * Run: `npm run test:cells` (builds the webview first).
 * Requires Google Chrome installed locally (playwright-core, channel: 'chrome').
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

const DOC = [
  '# Répartition',
  '',
  '| Chantier | Responsable | Échéance | État |',
  '| -------- | ----------- | -------- | ---- |',
  "| Moteur d'édition | Thierry | 2026-09-20 | terminé |",
  '| Tableaux | Équipe | 2026-09-28 | en cours |',
  '| Doc |  | 2026-10-05 | à faire |',
  '',
  'Fin.',
  ''
].join('\n')

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
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'config', config: { fontSize: 14 } } }))
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
const lineOf = (doc, start) => doc?.split('\n').find((l) => l.startsWith(start)) ?? null
/** Centre of the `col`-th cell of the body row whose first cell starts with `row`. */
const cellAt = (row, col) =>
  page.evaluate(
    ([row, col]) => {
      const tr = [...document.querySelectorAll('.cm-md-table tbody tr')].find((r) => r.cells[0].textContent.startsWith(row))
      const r = tr.cells[col].getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    [row, col]
  )
const open = async (row, col) => {
  const p = await cellAt(row, col)
  await page.mouse.dblclick(p.x, p.y)
  await page.waitForTimeout(300)
}

// 1. The field opens in the cell, holding its raw text, and fits it.
await open('Tableaux', 3)
const state = await page.evaluate(() => {
  const field = document.querySelector('.cm-td-editor-input')
  const cell = field?.closest('td')
  const wrap = document.querySelector('.cm-md-table')?.parentElement
  return {
    inCell: !!cell,
    text: field?.textContent ?? null,
    focused: document.activeElement === field,
    fieldWidth: field ? Math.round(field.getBoundingClientRect().width) : 0,
    cellWidth: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
    overflows: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : false
  }
})
check(state.inCell, '1a. the field lives inside the cell')
check(state.focused, '1b. the field takes the focus')
check(state.text === 'en cours', '1c. the field holds the raw cell', JSON.stringify(state.text))
check(state.fieldWidth <= state.cellWidth, '1d. the field fits its cell', `${state.fieldWidth} > ${state.cellWidth}`)
check(!state.overflows, '1e. the table gains no scrollbar')
await page.keyboard.press('End')
await page.keyboard.type(' **puis**')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const line1 = lineOf(await lastDoc(), '| Tableaux')
check(line1 === '| Tableaux | Équipe | 2026-09-28 | en cours **puis** |', '1f. Entrée writes that cell only', line1)
check(!(await page.$('.cm-td-editor-input')), '1g. Entrée closes the field')

// 2. Raw HTML renders; a <script> never survives.
await open('Doc', 1)
await page.keyboard.type('<span style="color:red">rouge</span> et <b>gras</b><script>alert(1)</script>')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
const html = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('.cm-md-table tbody tr')].find((r) => r.cells[0].textContent.startsWith('Doc'))
  const td = tr.cells[1]
  return {
    bold: !!td.querySelector('b, strong'),
    colored: (td.querySelector('span')?.getAttribute('style') ?? '').includes('red'),
    script: /script/i.test(td.innerHTML)
  }
})
check(lineOf(await lastDoc(), '| Doc')?.includes('<b>gras</b>'), '2a. the raw HTML lands in the cell')
check(html.bold, '2b. <b> renders as bold')
check(html.colored, '2c. an inline style survives')
check(!html.script, '2d. a <script> never survives')

// 3. Maj+Entrée writes a <br>, and re-opening shows it as a line.
await open('Moteur', 1)
await page.evaluate(() => {
  const r = document.createRange()
  r.selectNodeContents(document.querySelector('.cm-td-editor-input'))
  getSelection().removeAllRanges()
  getSelection().addRange(r)
})
await page.keyboard.type('Thierry')
await page.keyboard.press('Shift+Enter')
await page.keyboard.type('Baud')
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
check(lineOf(await lastDoc(), '| Moteur')?.includes('| Thierry<br>Baud |'), '3a. the cell holds <br>', lineOf(await lastDoc(), '| Moteur'))
await open('Moteur', 1)
const reopened = await page.evaluate(() => document.querySelector('.cm-td-editor-input')?.textContent ?? null)
check(reopened === 'Thierry\nBaud', '3b. re-opening shows a line, not the tag', JSON.stringify(reopened))

// 4. Opening and closing a cell without a change writes nothing.
const before = await edits()
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
check((await edits()) === before, '4. a no-op open/close writes nothing')

check(errors.length === 0, 'no page errors', errors.join(' | '))

await browser.close()
server.close()
console.log(failed ? `\n${failed} check(s) failed` : '\nall cell checks passed')
process.exit(failed ? 1 : 0)
