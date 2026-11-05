/*
 * MDForge — dossiers d'images hors du dossier de la note (src/imageroots.ts).
 *
 * La webview refuse tout fichier hors de ses `localResourceRoots` : une image
 * `../inputs/x.png` restait vide. Ces cas fixent quels dossiers sont ajoutés.
 *
 * Run: `npm run test:images` (compiles the extension first).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { imageRootsOutside } = require('../out/imageroots.js')

const doc = '/home/u/w/proj/docs'
const cases = [
  ['parent folder', '![a](../inputs/img/a.png)', ['/home/u/w/proj/inputs/img']],
  ['same folder ignored', '![a](diagrams/a.svg) ![b](./b.png)', []],
  ['two levels up', '![a](../../shared/a.png)', ['/home/u/w/shared']],
  ['angle brackets + spaces', '![a](<../my imgs/a.png>)', ['/home/u/w/proj/my imgs']],
  ['percent-encoded', '![a](../my%20imgs/a.png)', ['/home/u/w/proj/my imgs']],
  ['title and query', '![a](../i/a.png?v=2 "t")', ['/home/u/w/proj/i']],
  ['html img', '<img width="3" src="../h/a.png">', ['/home/u/w/proj/h']],
  ['reference definition', '![a][r]\n\n[r]: ../ref/a.png', ['/home/u/w/proj/ref']],
  ['non-image reference ignored', '[l]: ../other/page.md', []],
  ['urls and absolute ignored', '![a](https://x/a.png) ![b](/abs/b.png) ![c](data:image/png;base64,AA)', []],
  ['dedupe', '![a](../i/a.png) ![b](../i/b.png)', ['/home/u/w/proj/i']],
  ['escape then re-enter stays inside', '![a](../docs/x/a.png)', []],
  ['at most 3 levels up', '![a](../../../../x/a.png)', []],
  ['never the filesystem root', '![a](../../../../../../../../a.png)', []],
  ['never too close to the root', '![a](../../../b.png)', []],
  ['3 levels up, deep enough', '![a](../../../w2/a.png)', ['/home/u/w2']]
]
let failed = 0
for (const [name, text, want] of cases) {
  try {
    assert.deepEqual(imageRootsOutside(text, doc), want)
    console.log('ok  ', name)
  } catch (e) {
    failed++
    console.log('FAIL', name, '→', JSON.stringify(imageRootsOutside(text, doc)))
  }
}
if (failed) process.exit(1)
