/*
 * MDForge — Tab / Shift+Tab / Enter in lists (cm-listindent.ts + main.ts).
 *
 * Pins what was broken: a child under "1. " needs 3 spaces (2 left it a
 * sibling), an item's children move with it, a numbered item takes the number
 * of its new place, and Enter on an empty nested item goes up one level
 * instead of leaving a one-space line and a new empty item.
 *
 * Run: `npm run test:lists` (builds the webview first; needs Chrome).
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
const check = (ok, label) => {
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}`)
}
const expect = async (label, want) => {
  await page.waitForTimeout(120)
  const got = await doc()
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — got ${JSON.stringify(got)}`}`)
}

await setDoc('T\n\n- un\n- deux\n  - fille\n- trois\n')
await clickText('deux', 4)
await page.keyboard.press('Tab')
await expect('1. Tab carries the children along', 'T\n\n- un\n  - deux\n    - fille\n- trois\n')
await page.keyboard.press('Shift+Tab')
await expect('2. Shift+Tab brings them back', 'T\n\n- un\n- deux\n  - fille\n- trois\n')

await setDoc('T\n\n- un\n- deux\n')
await clickText('un', 2)
await page.keyboard.press('Tab')
await page.keyboard.type('!')
await expect('3. the first item cannot go down (no stray indent)', 'T\n\n- un!\n- deux\n')

await setDoc('T\n\n1. a\n2. b\n3. c\n')
await clickText('b', 1)
await page.keyboard.press('Tab')
await expect('4. under "1. " a child is indented 3 spaces and starts at 1 (the rest renumbered)', 'T\n\n1. a\n   1. b\n2. c\n')
await clickText('c', 1)
await page.keyboard.press('Tab')
await expect('5. the next one continues the sub-list', 'T\n\n1. a\n   1. b\n   2. c\n')
await page.keyboard.press('Shift+Tab')
await expect('6. Shift+Tab takes the number after the parent', 'T\n\n1. a\n   1. b\n2. c\n')

await setDoc('T\n\n- un\n  - deux\n')
await clickText('deux', 4)
await page.keyboard.press('Enter')
await expect('7. Enter continues the nested list', 'T\n\n- un\n  - deux\n  - \n')
await page.keyboard.press('Enter')
await expect('8. Enter on an empty nested item goes up one level', 'T\n\n- un\n  - deux\n- \n')
await page.keyboard.press('Enter')
await expect('9. Enter on an empty top item leaves the list', 'T\n\n- un\n  - deux\n\n')

await setDoc('T\n\n- un\n- deux\n')
await clickText('deux', 0)
await page.keyboard.press('Tab')
await page.keyboard.type('Z')
await expect('10. the caret stays in the text after Tab', 'T\n\n- un\n  - Zdeux\n')

/** Left edge of the rendered text `txt`, in px. */
const xOf = (txt) =>
  page.evaluate((txt) => {
    for (const l of document.querySelectorAll('.cm-line')) {
      const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        const i = n.data.indexOf(txt)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + 1)
        return Math.round(r.getBoundingClientRect().left)
      }
    }
    return null
  }, txt)
const steady = async (label, text, word) => {
  await setDoc(text)
  await clickText('Fin', 1)
  const before = await xOf(word)
  // At the very start of the text: the caret then touches the marker, which
  // is what brings the raw `3. ` back (a click mid-word does not).
  await clickText(word, 0)
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  const during = await xOf(word)
  const ok = before !== null && Math.abs(before - during) <= 2
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${before}px → ${during}px`}`)
}
await steady('11. a nested numbered item keeps its place while edited', 'T\n\n1. a\n   1. b\n   2. Gamma\n\nFin\n', 'Gamma')
await steady('12. a top numbered item keeps its place while edited', 'T\n\n1. Alpha\n2. b\n\nFin\n', 'Alpha')
await steady('13. a nested bullet keeps its place while edited', 'T\n\n- a\n  - Delta\n\nFin\n', 'Delta')

// 8 spaces under `  - [ ] x` is 4 past its content column: `- Test` reads as
// the task's paragraph, not a sub-list. Shift+Tab brings it to that column.
await setDoc('T\n\n- [ ] a\n  - [ ] b\n        - Test 3\n        - Test 4\n\nFin\n')
await clickText('Test 3', 2)
await page.keyboard.press('Shift+Tab')
await expect('14. Shift+Tab snaps an over-indented dash under its parent', 'T\n\n- [ ] a\n  - [ ] b\n    - Test 3\n        - Test 4\n\nFin\n')
const isItem = await page.evaluate(() =>
  [...document.querySelectorAll('.cm-line')].some((l) => l.classList.contains('cm-md-li') && l.textContent.includes('Test 3'))
)
check(isItem, '15. ...and it renders as a list item')

// Enter at the end of a nested task, Backspace to drop the box, then a dash:
// the box alone goes, the line stays a list item at the task's level.
await setDoc('- [ ] Click\n  - [ ] Test\n\nFin\n')
await clickText('Test', 4)
await page.keyboard.press('Enter')
await page.keyboard.press('Backspace')
await expect('16. Backspace after a task box removes the box only', '- [ ] Click\n  - [ ] Test\n  - \n\nFin\n')
await page.keyboard.type('pas bon')
await page.keyboard.press('Tab')
await expect('17. ...the bullet then goes under the task with Tab', '- [ ] Click\n  - [ ] Test\n    - pas bon\n\nFin\n')
await clickText('Fin', 1)
await page.waitForTimeout(150)
check(
  await page.evaluate(() =>
    [...document.querySelectorAll('.cm-line')].some((l) => l.classList.contains('cm-md-li') && l.textContent.includes('pas bon'))
  ),
  '18. ...and renders as a bullet'
)
await setDoc('- [x] fait\n\nFin\n')
await clickText('fait', 0)
await page.keyboard.press('Backspace')
await expect('19. a checked box goes the same way', '- fait\n\nFin\n')

// Bullets ⇄ numbers ⇄ tasks: the whole list under the caret, children follow
// the new content column.
const key = (k) => page.keyboard.press(`ControlOrMeta+Shift+${k}`)
await setDoc('- a\n- b\n  - child\n- c\n\nFin\n')
await clickText('b', 1)
await key('7')
await expect('20. Ctrl/⌘+Maj+7 numbers the whole list, children follow', '1. a\n2. b\n   - child\n3. c\n\nFin\n')
await key('8')
await expect('21. Ctrl/⌘+Maj+8 turns it back into bullets', '- a\n- b\n  - child\n- c\n\nFin\n')
await key('9')
await expect('22. Ctrl/⌘+Maj+9 makes it a task list', '- [ ] a\n- [ ] b\n  - child\n- [ ] c\n\nFin\n')

await setDoc('- a\n  - x\n  - y\n\nFin\n')
await clickText('x', 1)
await key('7')
await expect('23. a nested list keeps its indentation', '- a\n  1. x\n  2. y\n\nFin\n')

await setDoc('1. a\n2. b\n3. c\n\nFin\n')
await clickText('b', 1)
await page.keyboard.press('Tab')
await expect('24. Tab renumbers the list it leaves', '1. a\n   1. b\n2. c\n\nFin\n')

await setDoc('1. a\n1. b\n1. c\n\nFin\n')
await clickText('c', 1)
await page.keyboard.press('Tab')
await expect('25. the lazy 1. 1. 1. style is kept', '1. a\n1. b\n   1. c\n\nFin\n')

await setDoc(Array.from({ length: 10 }, (_, n) => `- i${n}`).join('\n') + '\n  - child\n\nFin\n')
await clickText('i0', 1)
await key('7')
const ten = await doc()
check(ten.includes('\n10. i9\n    - child\n'), '26. past 9 the child moves to the wider content column')

await setDoc('1. a\n2. b\n\nFin\n')
await clickText('Fin', 1)
await page.evaluate(() => {
  const mark = [...document.querySelectorAll('.cm-li-mark-menu')].find((m) => m.textContent === '2.')
  const r = mark.getBoundingClientRect()
  window.__markAt = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})
const at = await page.evaluate(() => window.__markAt)
await page.mouse.click(at.x, at.y)
await page.waitForTimeout(150)
const items = await page.evaluate(() => [...document.querySelectorAll('.cm-list-menu .cm-suggest-item')].map((e) => e.textContent))
check(items.length === 4, '27. a click on the number opens the list menu', JSON.stringify(items))
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.cm-list-menu .cm-suggest-item')].find((e) => e.textContent.includes('Puces'))
  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
})
await expect('28. ...and "Puces" converts the list', '- a\n- b\n\nFin\n')
check(!(await page.evaluate(() => !!document.querySelector('.cm-list-menu'))), '29. ...and closes the menu')

if (errors.length) {
  failed++
  console.log('  ✗ page errors', errors)
}
await browser.close()
server.close()
if (failed) process.exit(1)
