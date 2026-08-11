/*
 * MDForge — paste-conversion tests (headless).
 *
 * Covers the OneNote/web paste path: rich HTML on the clipboard is converted to
 * Markdown (it wins over the fallback bitmap the source also copies), and images
 * embedded in that HTML (`data:`/remote) are pulled into the note's assets folder
 * so the emitted link points at a local file, not an auth-gated URL.
 *
 * It drives the real webview bundle in headless Chrome with a mocked VS Code API
 * that ALSO answers `importImagePath` (standing in for the host asset save), then
 * asserts on the `edit` message the webview posts back.
 *
 * Run: `npm run test:paste` (builds the webview first).
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

// A tiny 1×1 transparent PNG as a data URI — stands in for a OneNote image.
const PNG_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// OneNote-style clipboard HTML: a heading, a paragraph and an embedded image.
const ONENOTE_HTML = `<html><body>
<h1>Ma note</h1>
<p>Un <b>paragraphe</b> avec du texte.</p>
<p><img src="${PNG_DATA}" alt=""></p>
</body></html>`

// A plain image copy: a lone <img>, no text — the bitmap should win, so the
// paste handler must NOT convert this (it returns false → default handling).
const LONE_IMAGE_HTML = `<html><body><img src="${PNG_DATA}"></body></html>`

// OneNote's mis-nested numbered list: the sub-list is a direct child of the
// parent <ol> (a sibling of the <li>s), not inside a <li> — invalid HTML that
// must be re-parented so the sub-steps indent under item 2.
const NESTED_LIST_HTML = `<html><body>
<ol type=1>
  <li value=1>Navigate to the site.</li>
  <li>Create a new group.</li>
  <ol type=1>
    <li value=1>Click the PLUS icon.</li>
    <li>Set the name.</li>
  </ol>
</ol>
</body></html>`

// OneNote splits one numbered list into chunks (an image/paragraph between two
// steps closes and reopens the <ol>), marking each resumption with <li value=N>.
// The numbering must continue (1, 2, 3), not restart at 1 each chunk.
const SPLIT_LIST_HTML = `<html><body>
<ol type=1><li value=1>First step.</li></ol>
<p>An interrupting note.</p>
<ol type=1><li value=2>Second step.</li></ol>
<p>Another note.</p>
<ol type=1><li value=3>Third step.</li></ol>
</body></html>`

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/main.css"></head>' +
        '<body><div id="app"></div><script type="module" src="/main.js"></script></body></html>'
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
const port = server.address().port

const browser = await chromium.launch({ channel: 'chrome', headless: true })

/** Load a page whose mocked host also answers `importImagePath` (asset save). */
async function open() {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  await page.addInitScript(() => {
    window.__posted = []
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => {
        window.__posted.push(m)
        // Stand in for the host: every localized image is "saved" under a stable
        // local name so the assertion can check the rewritten link.
        if (m && m.type === 'importImagePath') {
          setTimeout(
            () =>
              window.dispatchEvent(
                new MessageEvent('message', {
                  data: { type: 'imageInserted', id: m.id, src: 'assets/Ma-Note-abc123.png', alt: 'image', linkStyle: 'markdown' }
                })
              ),
            0
          )
        }
      },
      getState: () => undefined,
      setState: () => undefined
    })
  })
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setContent', text: '' } })))
  await page.waitForTimeout(200)
  return page
}

/** Fire a paste carrying `text/html` on the editor content and return the last
 * `edit` text the webview posted (or the count of edits when none is expected). */
async function pasteHtml(page, html) {
  await page.evaluate((h) => {
    const dt = new DataTransfer()
    dt.setData('text/html', h)
    const content = document.querySelector('.cm-content')
    content.focus()
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, html)
  await page.waitForTimeout(300)
}
const posted = (page) => page.evaluate(() => window.__posted)
const lastEdit = async (page) => (await posted(page)).filter((m) => m.type === 'edit').map((m) => m.text).at(-1)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  // 1) A OneNote-style note pastes as Markdown, not as a flat bitmap.
  {
    const page = await open()
    await pasteHtml(page, ONENOTE_HTML)
    const out = (await lastEdit(page)) || ''
    check('1. HTML converti en Markdown (titre + gras)', out.includes('# Ma note') && out.includes('**paragraphe**'), JSON.stringify(out.slice(0, 60)))
    check('2. image data: localisée (assets/…, plus de data:)', out.includes('assets/Ma-Note-abc123.png') && !out.includes('data:image/'), out.includes('data:image/') ? 'data: encore présent' : '')
    await page.close()
  }

  // 2) A lone image copy is NOT converted (the bitmap path handles it) — the
  //    handler returns false, so no image is localized via importImagePath.
  {
    const page = await open()
    await pasteHtml(page, LONE_IMAGE_HTML)
    const all = await posted(page)
    const localized = all.some((m) => m.type === 'importImagePath')
    check('3. image seule non convertie (bitmap gagne)', !localized, localized ? 'importImagePath déclenché à tort' : '')
    await page.close()
  }

  // 3) A OneNote mis-nested sub-list indents under its parent item.
  {
    const page = await open()
    await pasteHtml(page, NESTED_LIST_HTML)
    const out = (await lastEdit(page)) || ''
    // The two sub-steps must be indented (nested), not flattened to top level.
    const indented = /^ {2,4}1\. Click the PLUS icon\./m.test(out) && /^ {2,4}2\. Set the name\./m.test(out)
    check('4. sous-liste numérotée indentée sous l’item 2', indented, JSON.stringify(out))
    await page.close()
  }

  // 4) A list OneNote split into chunks keeps counting (1, 2, 3), not 1, 1, 1.
  {
    const page = await open()
    await pasteHtml(page, SPLIT_LIST_HTML)
    const out = (await lastEdit(page)) || ''
    const continues = /^1\. First step\./m.test(out) && /^2\. Second step\./m.test(out) && /^3\. Third step\./m.test(out)
    check('5. numérotation continue après découpage (1,2,3)', continues, JSON.stringify(out))
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
