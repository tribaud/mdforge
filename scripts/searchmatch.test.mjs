/*
 * MDForge — parsing of the search view's result list, and the term deduced from it.
 *
 * `matchesForFile` and `deriveQuery` (src/searchmatches.ts) are what stand
 * between a click on a workspace-search result and the line MDForge reveals,
 * because VS Code hands a custom editor neither the range nor the query. Their
 * input is the text `search.action.getSearchResults` returns — an internal
 * command with no contract — so these cases pin down the format as VS Code
 * writes it today (searchActionsCopy.ts, `matchToString`): two spaces of
 * indent, `<line>,<column>: ` for the first line of a match, the line number
 * alone for the rest of a multi-line one, and an unindented, tildified,
 * absolute path above each file's matches.
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

const { matchesForFile, parseSearchResults, otherMatches, deriveQuery } = await import(
  pathToFileURL(built).href
)

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
/** A match carries the printed line text too; most cases only care where it is. */
const positions = (matches) => matches.map(({ line, column }) => ({ line, column }))
const at = (text, fsPath) => positions(matchesForFile(text, fsPath, options))

/* The shape VS Code prints: a tildified path, matches indented by two. */
const simple = [
  '~/notes/Meeting.md',
  '  12,5: the line that matched',
  '  48,1: another one',
  '',
  '~/notes/Other.md',
  '  3,9: elsewhere'
].join('\n')

check('matches of the wanted file only', at(simple, `${HOME}/notes/Meeting.md`), [
  { line: 12, column: 5 },
  { line: 48, column: 1 }
])
check('a second file is read too', at(simple, `${HOME}/notes/Other.md`), [{ line: 3, column: 9 }])
check('a file with no match', at(simple, `${HOME}/notes/Absent.md`), [])
check('empty results', at('', `${HOME}/notes/Meeting.md`), [])

/* The line's text is kept — it is what the search term is deduced from. */
check(
  'the matched line text is kept',
  matchesForFile(simple, `${HOME}/notes/Meeting.md`, options)[0].text,
  'the line that matched'
)

/* A multi-line match: only its first line carries a column, and it is the only
 * one that is a position — the rest is the same match spilling over. */
const multiline = [
  '~/notes/Meeting.md',
  '  7,3: opening of a match',
  '  8:    its second line',
  '  9:    its third'
].join('\n')
check('a multi-line match counts once', at(multiline, `${HOME}/notes/Meeting.md`), [
  { line: 7, column: 3 }
])

/* Matched TEXT that looks like the format must not be read as a position: the
 * prefix is what VS Code wrote, everything after `: ` is content. */
const decoy = ['~/notes/Meeting.md', '  4,1: see also   12,5: not a match'].join('\n')
check('the match text is never parsed', at(decoy, `${HOME}/notes/Meeting.md`), [
  { line: 4, column: 1 }
])

/* Two sections (text results, then AI results) can list the same file. */
const twice = [
  '~/notes/Meeting.md',
  '  12,5: once',
  '',
  '',
  '~/notes/Meeting.md',
  '  12,5: and again',
  '  4,2: plus an earlier one'
].join('\n')
check('duplicates merge, in document order', at(twice, `${HOME}/notes/Meeting.md`), [
  { line: 4, column: 2 },
  { line: 12, column: 5 }
])

/* Paths: `~` is the search view's, not ours; case follows the platform. */
check('an untildified path still matches', at(['/tmp/a.md', '  1,1: x'].join('\n'), '/tmp/a.md'), [
  { line: 1, column: 1 }
])
check(
  'case-insensitive off Linux',
  at(['~/Notes/Meeting.md', '  1,1: x'].join('\n'), `${HOME}/notes/meeting.md`),
  [{ line: 1, column: 1 }]
)
check(
  'case-sensitive on Linux',
  positions(
    matchesForFile(['~/Notes/Meeting.md', '  1,1: x'].join('\n'), `${HOME}/notes/meeting.md`, {
      home: HOME,
      caseSensitive: true
    })
  ),
  []
)
check(
  'a relative label matches on its tail',
  at(['notes/Meeting.md', '  6,1: x'].join('\n'), `${HOME}/notes/Meeting.md`),
  [{ line: 6, column: 1 }]
)
check(
  'a tail that is not a whole segment does not match',
  at(['notes/Meeting.md', '  6,1: x'].join('\n'), `${HOME}/other-notes/Meeting.md`),
  []
)
check(
  'windows separators compare alike',
  at(['C:\\notes\\Meeting.md', '  2,4: x'].join('\n'), 'C:\\notes\\Meeting.md'),
  [{ line: 2, column: 4 }]
)

/* Garbage in, nothing out — the command is internal and may change shape. */
check('matches before any path are dropped', parseSearchResults('  1,1: orphan').length, 0)
check('an unexpected format yields no position', at('Searching...\n42 results in 7 files', `${HOME}/notes/Meeting.md`), [])

/* ---- the search term, deduced from where the matches are ---- */

const results = [
  '~/notes/Meeting.md',
  '  3,13: et voici le mot cherché dans la note',
  '  9,4: un mot cherché ailleurs',
  '',
  '~/notes/Other.md',
  '  1,1: mot cherché encore'
].join('\n')
const note = ['', '', 'et voici le mot cherché dans la note', '', '', '', '', '', 'un mot cherché ailleurs']
const lineText = (n) => note[n - 1]

check(
  'the term is what every match starts with',
  deriveQuery(
    matchesForFile(results, `${HOME}/notes/Meeting.md`, options),
    otherMatches(results, `${HOME}/notes/Meeting.md`, options),
    lineText
  ),
  'mot cherché'
)
check(
  'other files are the corroborating samples',
  positions(otherMatches(results, `${HOME}/notes/Meeting.md`, options)),
  [{ line: 1, column: 1 }]
)
check(
  'one lone sample is not enough to guess from',
  deriveQuery(
    matchesForFile(['~/a.md', '  1,1: seul'].join('\n'), '/a.md', options),
    [],
    () => 'seul'
  ),
  undefined
)
check(
  'a term at the very end of its line',
  deriveQuery(
    [
      { line: 1, column: 5, text: 'les carottes' },
      { line: 2, column: 1, text: 'carottes' }
    ],
    [],
    (n) => (n === 1 ? 'les carottes' : 'carottes')
  ),
  'carottes'
)
check(
  'nothing in common yields no term (a regex search, say)',
  deriveQuery(
    [
      { line: 1, column: 1, text: 'alpha' },
      { line: 2, column: 1, text: 'beta' }
    ],
    [],
    (n) => (n === 1 ? 'alpha' : 'beta')
  ),
  undefined
)
check(
  'the note itself is read for its own lines, not the preview',
  deriveQuery(
    [{ line: 1, column: 1, text: 'trimmed…' }],
    [{ line: 1, column: 1, text: 'motif ailleurs' }],
    () => 'motif ici'
  ),
  'motif'
)

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
