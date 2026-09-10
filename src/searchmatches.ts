/*
 * Where a workspace-search click was aiming — recovered from the text the
 * search view prints for its own "Copy All".
 *
 * VS Code never tells a custom editor which match was clicked: the range that
 * `Ctrl+Shift+F` carries is dropped when the target resolves to a webview
 * editor, and `resolveCustomTextEditor` receives the document and nothing else
 * (microsoft/vscode#289785, still open; #301887 and #211351 closed as not
 * planned). The only place the positions remain reachable is the search view
 * itself, through the internal `search.action.getSearchResults` command, which
 * returns every current result as the text a user would get from "Copy All":
 *
 *   ~/notes/Meeting.md
 *     12,5:  the matched line, with its own leading spaces kept
 *     13:    the rest of a match that spans several lines
 *     48,1:  another match
 *
 * The prefix of a match's FIRST line is `<line>,<column>`, 1-based, both of them
 * the START of the match; a continuation line carries the line number alone.
 * That is all we need to reveal the line — the match's length is nowhere in
 * that output, which is why MDForge highlights the LINE and not the word.
 *
 * This module parses that text and nothing else: it imports nothing, so
 * `npm run test:search` can exercise it outside an Extension Host. The glue
 * that calls the command lives in `searchreveal.ts`.
 */

/** One match, as the search view numbers them: 1-based line AND column. */
export interface SearchMatch {
  line: number
  column: number
  /** The line as the search view printed it — what the query is deduced from. */
  text?: string
}

/** Every match the search view currently holds for one file. */
export interface FileMatches {
  /** The path as printed — absolute, and tildified when under $HOME. */
  path: string
  matches: SearchMatch[]
}

export interface MatchOptions {
  /** Home directory, to expand the `~` the search view writes. */
  home?: string
  /** Only Linux compares paths case-sensitively. */
  caseSensitive?: boolean
}

/** `  12,5: text` — the first line of a match, with its start column. */
const MATCH_LINE = /^ {2}(\d+),(\d+):/
/** `  13: text` — a further line of a multi-line match; it starts nothing. */
const CONTINUATION_LINE = /^ {2}\d+:/

/**
 * Split the search view's output into one entry per file. A file's path is any
 * line that is not indented; everything else belongs to the file above it.
 * Results can list the same file twice (the text results, then the AI ones),
 * which `matchesForFile` merges.
 */
export function parseSearchResults(text: string): FileMatches[] {
  const files: FileMatches[] = []
  let current: FileMatches | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = MATCH_LINE.exec(line)
    if (match) {
      // A match before any path means the output is not what we think it is;
      // dropping it is the safe read.
      current?.matches.push({
        line: Number(match[1]),
        column: Number(match[2]),
        // `<indent><line>,<col>: ` — the alignment padding VS Code inserts after
        // the colon is only ever used on the FURTHER lines of a multi-line
        // match, never on this one (its own prefix is always the longest).
        text: line.slice(match[0].length + 1)
      })
      continue
    }
    if (CONTINUATION_LINE.test(line)) continue
    current = { path: line.trim(), matches: [] }
    files.push(current)
  }
  return files
}

/** `~/notes` → `/Users/x/notes`, and `\` → `/` so both sides compare alike. */
function normalize(path: string, options: MatchOptions): string {
  let value = path
  if (options.home && (value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) {
    value = options.home + value.slice(1)
  }
  value = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return options.caseSensitive ? value : value.toLowerCase()
}

/** A drive letter or a leading slash — a label we can compare in full. */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:\//i.test(path)
}

/**
 * The matches the current search holds for one file, in document order and
 * without duplicates. Empty when the search results say nothing about it —
 * which is the normal case, and never an error.
 *
 * A relative label (a multi-root workspace prints one) is matched on its tail,
 * an absolute one in full.
 */
export function matchesForFile(
  text: string,
  fsPath: string,
  options: MatchOptions = {}
): SearchMatch[] {
  const wanted = normalize(fsPath, options)
  const found: SearchMatch[] = []
  for (const file of parseSearchResults(text)) {
    const path = normalize(file.path, options)
    const same = isAbsolute(path) ? path === wanted : wanted.endsWith('/' + path)
    if (same) found.push(...file.matches)
  }
  found.sort((a, b) => a.line - b.line || a.column - b.column)
  return found.filter(
    (match, index) =>
      index === 0 || match.line !== found[index - 1].line || match.column !== found[index - 1].column
  )
}

/** Every match in the results EXCEPT those of one file — the corroborating samples. */
export function otherMatches(text: string, fsPath: string, options: MatchOptions = {}): SearchMatch[] {
  const wanted = normalize(fsPath, options)
  const others: SearchMatch[] = []
  for (const file of parseSearchResults(text)) {
    const path = normalize(file.path, options)
    const same = isAbsolute(path) ? path === wanted : wanted.endsWith('/' + path)
    if (!same) others.push(...file.matches)
  }
  return others
}

/** Longest common prefix, compared without case. The first slice gives the case. */
function commonPrefix(slices: string[]): string {
  let length = Math.min(...slices.map((slice) => slice.length))
  for (let index = 0; index < length; index++) {
    const reference = slices[0][index].toLowerCase()
    if (slices.some((slice) => slice[index].toLowerCase() !== reference)) {
      length = index
      break
    }
  }
  return slices[0].slice(0, length)
}

/** A search term long enough to be worth highlighting, and not a whole line. */
const MAX_QUERY = 120

/**
 * What the user typed in the search box — deduced, because the search view does
 * not hand it over any more than it hands over the clicked result.
 *
 * Every match starts, by definition, with the term. So take the text of each
 * matched line from its match column on, and keep what they all share: with two
 * matches in different contexts, that common prefix IS the term. It can only
 * ever come out too LONG (every match happening to be followed by the same
 * word), never too short, which is why one lone match is not enough to guess
 * from — `undefined` then, and the caller falls back to marking whole lines.
 *
 * The slices of the note being opened are taken from the note itself; the ones
 * from other files can only come from the search view's preview text, which is
 * trimmed for very long lines — a trimmed sample shortens the guess, it never
 * corrupts it.
 */
export function deriveQuery(ours: SearchMatch[], samples: SearchMatch[], lineText: (line: number) => string | undefined): string | undefined {
  const slices: string[] = []
  for (const match of ours) {
    const line = lineText(match.line)
    if (line !== undefined && match.column - 1 < line.length) slices.push(line.slice(match.column - 1))
  }
  for (const match of samples) {
    if (match.text !== undefined && match.column - 1 < match.text.length) {
      slices.push(match.text.slice(match.column - 1))
    }
  }
  if (slices.length < 2) return undefined
  // Trailing whitespace is dropped: when every match is followed by a space,
  // the common prefix runs one character past the term, and highlighting that
  // space would look like a bug.
  const query = commonPrefix(slices).slice(0, MAX_QUERY).replace(/\s+$/, '')
  return query.length > 0 ? query : undefined
}
