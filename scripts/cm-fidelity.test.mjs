/*
 * MDForge — source-fidelity acceptance tests (headless).
 *
 * The CodeMirror engine's promise is that the document IS the Markdown text: no
 * parse→serialize round-trip, so editing never reformats the source. These tests
 * lock that in against regressions. They drive the real webview bundle in
 * headless Chrome (system install, like scripts/cm-preview.mjs) with a mocked
 * VS Code API, and assert on the `edit` messages it posts back.
 *
 * Run: `npm run test:fidelity` (builds the webview first).
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

/** A representative tricky TODO.md: nested marks, intra-word `_`, lone `~`,
 * tight list, thematic break, table, frontmatter — exactly the shapes that a
 * remark/ProseMirror round-trip corrupts. */
const TRICKY = [
  '---',
  'title: Corpus',
  '---',
  '',
  '# TODO',
  '',
  '- [~] ~~**Reste (a)** : le mapping `zfs_backup` prend effet sur homesrv2.~~ **CADUC**',
  '- [ ] vérifier `docker_proxy` et `APP_DATA` (~830 G, ~6 mois)',
  '- [x] voir [cli/modules/_shared/disk.sh](./cli/modules/_shared/disk.sh)',
  '',
  '---',
  '',
  '| Col | Valeur |',
  '| --- | --- |',
  '| a | b |',
  ''
].join('\n')

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

/** Load a fresh page with the mocked VS Code API and set the document. */
async function open(text) {
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
  await page.addInitScript(() => {
    window.__posted = []
    window.acquireVsCodeApi = () => ({
      postMessage: (m) => window.__posted.push(m),
      getState: () => undefined,
      setState: () => undefined
    })
  })
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
  await page.evaluate((t) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'setContent', text: t } })), text)
  await page.waitForTimeout(300)
  return page
}
const edits = (page) => page.evaluate(() => window.__posted.filter((m) => m.type === 'edit').map((m) => m.text))
const lastEdit = async (page) => (await edits(page)).at(-1)
function changedLines(a, b) {
  const x = a.split('\n')
  const y = (b ?? '').split('\n')
  const out = []
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push({ line: i + 1, before: x[i], after: y[i] })
  return out
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  // 1. Idempotence: opening a file posts no edit.
  {
    const page = await open(TRICKY)
    const n = (await edits(page)).length
    check('1. idempotence à vide (0 edit à l’ouverture)', n === 0, `${n} edit(s)`)
    await page.close()
  }

  // 2. Round-trip: cycling a checkbox 3 times returns to the original state, and
  //    the emitted text is byte-identical to the input (no transformation on
  //    load or edit).
  {
    const page = await open(TRICKY)
    await page.waitForSelector('.cm-task-checkbox')
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.querySelectorAll('.cm-task-checkbox')[0].click())
      await page.waitForTimeout(60)
    }
    const out = await lastEdit(page)
    check('2. round-trip byte-identique (cycle complet d’une case)', out === TRICKY, out === TRICKY ? '' : `${changedLines(TRICKY, out).length} ligne(s) divergente(s)`)
    await page.close()
  }

  // 3. Targeted edit + mark fidelity + zero escaping: toggling one checkbox
  //    changes exactly one line; nested marks and identifiers are untouched.
  {
    const page = await open(TRICKY)
    await page.waitForSelector('.cm-task-checkbox')
    await page.evaluate(() => document.querySelectorAll('.cm-task-checkbox')[0].click())
    await page.waitForTimeout(80)
    const out = await lastEdit(page)
    const diff = changedLines(TRICKY, out)

    check('5. édition ciblée (1 seule ligne de diff)', diff.length === 1, `${diff.length} ligne(s)`)
    const only = diff[0]
    check(
      '3. fidélité des marques (reste de la ligne intact, [~]→[x])',
      Boolean(only) && only.before?.replace('[~]', '[x]') === only.after,
      only ? `L${only.line}` : 'aucune ligne changée'
    )
    const newEsc = (out?.match(/\\[_~*]/g) || []).length - (TRICKY.match(/\\[_~*]/g) || []).length
    check('4. zéro échappement ajouté (\\_ \\~ \\*)', newEsc === 0, `${newEsc} ajouté(s)`)
    // Style/scope: bullets, thematic break and identifiers untouched.
    const has = (s) => (out || '').includes(s)
    check('3b. `zfs_backup` / `_shared` intacts (pas de \\_)', has('`zfs_backup`') && has('_shared/disk.sh') && !/\\_/.test(out || ''))
    check('3c. règle horizontale `---` conservée (pas `***`)', has('\n---\n') && !has('***'))
    await page.close()
  }
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
