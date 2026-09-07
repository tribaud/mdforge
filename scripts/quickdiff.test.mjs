/*
 * MDForge — quick-diff line-diff tests.
 *
 * `diffLines` (src/linediff.ts) decides what the margin shows: which lines are
 * added, which are modified, and where a deletion left a seam. It is pure, so it
 * is the one part of the quick diff a test can actually pin down — the rendering
 * has to be looked at (F5 or the headless harness).
 *
 * The cases below are the ones that were wrong at some point while writing it:
 * a run that both drops and inserts must read as ONE modified block (not a
 * deletion followed by an addition), a deletion carries no line of its own, and
 * a document emptied or filled from scratch must not fall off either end.
 *
 * Run: `npm run test:quickdiff` (compiles the extension first).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = path.join(root, 'out', 'linediff.js')

if (!fs.existsSync(built)) {
  console.error('out/linediff.js missing — run `npm run compile:ext` first.')
  process.exit(1)
}

const { diffLines } = await import(pathToFileURL(built).href)

let failures = 0
const lines = (...l) => l.join('\n')

function check(name, base, current, expected) {
  const got = JSON.stringify(diffLines(base, current))
  const want = JSON.stringify(expected)
  if (got === want) {
    console.log(`  ok   ${name}`)
    return
  }
  failures++
  console.log(`  FAIL ${name}\n         got  ${got}\n         want ${want}`)
}

console.log('quick diff — line changes')

check('identical documents', lines('a', 'b', 'c'), lines('a', 'b', 'c'), [])
check('one line rewritten', lines('a', 'b', 'c'), lines('a', 'B', 'c'), [
  { from: 1, to: 2, type: 'modified' }
])
check('one line inserted', lines('a', 'c'), lines('a', 'b', 'c'), [
  { from: 1, to: 2, type: 'added' }
])
check('one line removed', lines('a', 'b', 'c'), lines('a', 'c'), [
  { from: 1, to: 1, type: 'deleted' }
])
check('appended at the end', lines('a'), lines('a', 'b', 'c'), [
  { from: 1, to: 3, type: 'added' }
])
check('truncated at the end', lines('a', 'b', 'c'), lines('a'), [
  { from: 1, to: 1, type: 'deleted' }
])
check('prepended at the start', lines('b'), lines('a', 'b'), [{ from: 0, to: 1, type: 'added' }])
check('two independent edits', lines('a', 'b', 'c', 'd', 'e'), lines('a', 'B', 'c', 'd', 'E'), [
  { from: 1, to: 2, type: 'modified' },
  { from: 4, to: 5, type: 'modified' }
])
check('paragraph collapsed (3 lines → 1)', lines('x', 'a', 'b', 'c', 'y'), lines('x', 'Z', 'y'), [
  { from: 1, to: 2, type: 'modified' }
])
check('paragraph grown (1 line → 3)', lines('x', 'a', 'y'), lines('x', 'A', 'B', 'C', 'y'), [
  { from: 1, to: 4, type: 'modified' }
])
check('insertion and deletion in one pass', lines('a', 'b', 'c', 'd'), lines('a', 'N', 'b', 'd'), [
  { from: 1, to: 2, type: 'added' },
  { from: 3, to: 3, type: 'deleted' }
])
check('CRLF is not a change', 'a\r\nb', 'a\nb', [])
// An empty document is one empty line, not zero lines: emptying a file leaves
// that line behind, so it reads as modified rather than as a bare seam.
check('empty file filled', '', lines('a', 'b'), [{ from: 0, to: 2, type: 'modified' }])
check('file emptied', lines('a', 'b'), '', [{ from: 0, to: 1, type: 'modified' }])

// The common case in a real note: a long document, one line touched. The
// prefix/suffix trim must reduce this to a single change.
const long = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n')
const touched = long
  .split('\n')
  .map((l, i) => (i === 400 ? 'line 400, edited' : l))
  .join('\n')
check('800 lines, one edited', long, touched, [{ from: 400, to: 401, type: 'modified' }])

// Two edits far apart: the prefix/suffix trim buys nothing here, so this is the
// case that used to fall off the quadratic budget and paint the WHOLE document
// as one modified block. The unique-line anchors are what keep it exact.
const far = Array.from({ length: 3000 }, (_, i) => `paragraph number ${i}`).join('\n')
const farEdited = far
  .split('\n')
  .map((l, i) => (i === 5 || i === 2990 ? `${l}, edited` : l))
  .join('\n')
check('3000 lines, first and last edited', far, farEdited, [
  { from: 5, to: 6, type: 'modified' },
  { from: 2990, to: 2991, type: 'modified' }
])

// And a document churned enough that the trim buys nothing — this must stay
// fast and must not report the whole file as one block.
const churnBase = Array.from({ length: 4000 }, (_, i) => `paragraph ${i}`).join('\n')
const churnCurrent = churnBase
  .split('\n')
  .filter((_, i) => i % 7 !== 0)
  .join('\n')
const started = Date.now()
const churn = diffLines(churnBase, churnCurrent)
const elapsed = Date.now() - started
const expectedDeletions = Math.ceil(4000 / 7)
if (churn.length === expectedDeletions && churn.every((c) => c.type === 'deleted')) {
  console.log(`  ok   4000 lines, one in seven removed (${churn.length} seams, ${elapsed}ms)`)
} else {
  failures++
  console.log(
    `  FAIL 4000 lines, one in seven removed\n         got ${churn.length} changes, ` +
      `types ${[...new Set(churn.map((c) => c.type))].join('/')}, want ${expectedDeletions} deleted`
  )
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed')
process.exit(failures ? 1 : 0)
