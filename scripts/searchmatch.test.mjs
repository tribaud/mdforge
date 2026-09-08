/*
 * MDForge — parsing of the search view's result list.
 *
 * `matchesForFile` (src/searchmatches.ts) is what stands between a click on a
 * workspace-search result and the line MDForge reveals, because VS Code hands a
 * custom editor no range at all. Its input is the text `search.action.get
 * SearchResults` returns — an internal command with no contract — so these
 * cases pin down the format as VS Code writes it today (searchActionsCopy.ts,
 * `matchToString`): two spaces of indent, `<line>,<column>: ` for the first
 * line of a match, the line number alone for the rest of a multi-line one, and
 * an unindented, tildified, absolute path above each file's matches.
 *
 * Run: `npm run test:search` (compiles the extension first).
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = path.join(root, 'out', 'searchmatches.js')

if (!fs.existsSync(built)) {
  console.error('out/searchmatches.js missing — run `npm run compile:ext` first.')
  process.exit(1)
}

const { matchesForFile, parseSearchResults } = await import(pathToFileURL(built).href)

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}\n       expected ${b}\n       got      ${a}`)
  }
}

const HOME = '/Users/x'
const options = { home: HOME, caseSensitive: false }

/* The shape VS Code prints: a tildified path, matches indented by two. */
const simple = [
  '~/notes/Meeting.md',
  '  12,5:  the line that matched',
  '  48,1:  another one',
  '',
  '~/notes/Other.md',
  '  3,9:   elsewhere'
].join('\n')

check('matches of the wanted file only', matchesForFile(simple, `${HOME}/notes/Meeting.md`, options), [
  { line: 12, column: 5 },
  { line: 48, column: 1 }
])
check('a second file is read too', matchesForFile(simple, `${HOME}/notes/Other.md`, options), [
  { line: 3, column: 9 }
])
check('a file with no match', matchesForFile(simple, `${HOME}/notes/Absent.md`, options), [])
check('empty results', matchesForFile('', `${HOME}/notes/Meeting.md`, options), [])

/* A multi-line match: only its first line carries a column, and it is the only
 * one that is a position — the rest is the same match spilling over. */
const multiline = ['~/notes/Meeting.md', '  7,3:   opening of a match', '  8:     its second line', '  9:     its third'].join('\n')
check('a multi-line match counts once', matchesForFile(multiline, `${HOME}/notes/Meeting.md`, options), [
  { line: 7, column: 3 }
])

/* Matched TEXT that looks like the format must not be read as a position: the
 * prefix is what VS Code wrote, everything after `: ` is content. */
const decoy = ['~/notes/Meeting.md', '  4,1:   see also   12,5: not a match'].join('\n')
check('the match text is never parsed', matchesForFile(decoy, `${HOME}/notes/Meeting.md`, options), [
  { line: 4, column: 1 }
])

/* Two sections (text results, then AI results) can list the same file. */
const twice = [
  '~/notes/Meeting.md',
  '  12,5:  once',
  '',
  '',
  '~/notes/Meeting.md',
  '  12,5:  and again',
  '  4,2:   plus an earlier one'
].join('\n')
check('duplicates merge, in document order', matchesForFile(twice, `${HOME}/notes/Meeting.md`, options), [
  { line: 4, column: 2 },
  { line: 12, column: 5 }
])

/* Paths: `~` is the search view's, not ours; case follows the platform. */
check('an untildified path still matches', matchesForFile(['/tmp/a.md', '  1,1: x'].join('\n'), '/tmp/a.md', options), [
  { line: 1, column: 1 }
])
check(
  'case-insensitive off Linux',
  matchesForFile(['~/Notes/Meeting.md', '  1,1: x'].join('\n'), `${HOME}/notes/meeting.md`, options),
  [{ line: 1, column: 1 }]
)
check(
  'case-sensitive on Linux',
  matchesForFile(['~/Notes/Meeting.md', '  1,1: x'].join('\n'), `${HOME}/notes/meeting.md`, {
    home: HOME,
    caseSensitive: true
  }),
  []
)
check(
  'a relative label matches on its tail',
  matchesForFile(['notes/Meeting.md', '  6,1: x'].join('\n'), `${HOME}/notes/Meeting.md`, options),
  [{ line: 6, column: 1 }]
)
check(
  'a tail that is not a whole segment does not match',
  matchesForFile(['notes/Meeting.md', '  6,1: x'].join('\n'), `${HOME}/other-notes/Meeting.md`, options),
  []
)
check(
  'windows separators compare alike',
  matchesForFile(['C:\\notes\\Meeting.md', '  2,4: x'].join('\n'), 'C:\\notes\\Meeting.md', options),
  [{ line: 2, column: 4 }]
)

/* Garbage in, nothing out — the command is internal and may change shape. */
check('matches before any path are dropped', parseSearchResults('  1,1: orphan').length, 0)
check(
  'an unexpected format yields no position',
  matchesForFile('Searching...\n42 results in 7 files', `${HOME}/notes/Meeting.md`, options),
  []
)

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
