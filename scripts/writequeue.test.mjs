/*
 * MDForge — the document write queue.
 *
 * `createWriter` (src/writequeue.ts) is what stands between a held Backspace and
 * a mangled file. The bug it fixes was an ordering one: two whole-document
 * replaces in flight at once, the second computed against a document the first
 * had not changed yet. So these cases are about ORDER and OVERLAP, not about
 * VS Code.
 *
 * Run: `npm run test:writes` (compiles the extension first).
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = path.join(root, 'out', 'writequeue.js')
if (!fs.existsSync(built)) {
  console.error('out/writequeue.js missing — run `npm run compile:ext` first.')
  process.exit(1)
}
const { createWriter } = await import(pathToFileURL(built).href)

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}\n       expected ${b}\n       got      ${a}`)
  }
}

/** A document whose writes take `delay` ticks to land, and that records overlap. */
const fakeDoc = (initial, delay = 3) => {
  const state = { text: initial, applied: [], inFlight: 0, maxInFlight: 0, rangesSeen: [] }
  const writer = createWriter({
    read: () => state.text,
    apply: async (text) => {
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      // What a whole-document replace measures at the moment it is built.
      state.rangesSeen.push(state.text.length)
      for (let i = 0; i < delay; i++) await Promise.resolve()
      state.text = text
      state.applied.push(text)
      state.inFlight--
    },
    onError: (e) => state.applied.push(`ERROR:${e.message}`)
  })
  return { state, writer }
}

// A burst of keystrokes: the document ends on the last one, and the writes
// never overlap — the whole point.
{
  const { state, writer } = fakeDoc('')
  writer.write('a')
  writer.write('ab')
  writer.write('abc')
  await writer.write('abcd')
  check('a burst ends on the last text', state.text, 'abcd')
  check('never two writes at once', state.maxInFlight, 1)
  check('intermediate keystrokes are coalesced', state.applied, ['a', 'abcd'])
}

// Each write measures the document AFTER the previous one landed. With the old
// code both saw length 0, which is exactly how the text got mangled.
{
  const { state, writer } = fakeDoc('')
  await writer.write('hello')
  await writer.write('hello world')
  check('each write sees the previous result', state.rangesSeen, [0, 'hello'.length])
}

// Typing that continues while a write is in flight still lands.
{
  const { state, writer } = fakeDoc('')
  const first = writer.write('x')
  writer.write('xy')
  await first
  check('a write queued mid-flight is applied', state.text, 'xy')
}

// Writing what the document already holds is not an edit.
{
  const { state, writer } = fakeDoc('same')
  await writer.write('same')
  check('no edit when the text is unchanged', state.applied, [])
}

// A rejected write must not wedge the queue.
{
  const state = { text: '', applied: [] }
  let fail = true
  const writer = createWriter({
    read: () => state.text,
    apply: async (text) => {
      if (fail) {
        fail = false
        throw new Error('busy')
      }
      state.text = text
      state.applied.push(text)
    },
    onError: (e) => state.applied.push(`caught:${e.message}`)
  })
  await writer.write('one')
  await writer.write('two')
  check('a failed write is reported, the next one lands', state.applied, ['caught:busy', 'two'])
  check('the queue is idle afterwards', writer.busy(), false)
}

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
