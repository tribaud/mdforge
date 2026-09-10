/*
 * Reveal, in MDForge, the line a workspace-search click was aiming at.
 *
 * The whole difficulty is that VS Code does not pass it: clicking a result for
 * a file owned by a custom editor opens the webview with no range at all
 * (microsoft/vscode#289785). What is still reachable is the search view's own
 * result list, which the internal `search.action.getSearchResults` command
 * returns as text; `searchmatches.ts` parses it.
 *
 * Two consequences, both deliberate:
 *
 * - We learn every match in the file, never WHICH one was clicked. MDForge
 *   goes to the first and marks the others, and `F8` walks them.
 * - The command is internal. It can change or disappear without notice, so it
 *   is feature-detected once, called inside a try/catch, and any surprise means
 *   "no matches" — the note simply opens as it always did.
 *
 * Nothing says the note was opened FROM a search result, either. The command is
 * served by `getSearchView`, i.e. the search view has to be the active view of
 * its container — enough to rule out the Explorer, not enough to rule out a
 * `Ctrl+P` while the results are on screen (nor a search view docked in the
 * panel, which stays active next to the Explorer). So the opens MDForge itself
 * performs are suppressed explicitly (`suppressReveal`), the editor has to be
 * the active one, and `mdforge.revealSearchMatch` switches the whole thing off.
 * Landing on a line that matches the search you still have open is a small
 * surprise; landing at the top of the file was the reported bug.
 */
import * as vscode from 'vscode'
import * as os from 'os'
import { matchesForFile, otherMatches, deriveQuery } from './searchmatches'
import type { SearchMatch } from './searchmatches'

const RESULTS_COMMAND = 'search.action.getSearchResults'

/** Feature detection, once per session. */
let available: Promise<boolean> | undefined

/**
 * The last answer, reused for a moment. The command renders EVERY current
 * result to a string on the workbench side (`search.maxResults` defaults to
 * 20000) and ships it over RPC, so restoring a window with several notes open,
 * or walking results with the arrows, must not pay for it once per editor.
 */
let cache: { at: number; results: string } | undefined
const CACHE_MS = 500

/**
 * Notes MDForge is about to open itself — a wikilink, a rename, the toolbar's
 * own "open in MDForge". The search view may well be showing results for them,
 * but the user did not click one, so the reveal is skipped. Cleared when it is
 * consumed, and on a timer in case the editor never opens.
 */
const selfOpened = new Set<string>()

/**
 * What was last revealed for a note. A webview is created once
 * (`retainContextWhenHidden`), so a note that is ALREADY open answers no
 * `ready` when a search result points at it — the tab is merely brought
 * forward. The reveal therefore also runs when an editor becomes active, and
 * this is what keeps that from re-jumping on every tab switch: the same note,
 * for the same results, is revealed once.
 */
const revealed = new Map<string, string>()

/** A fresh editor reveals again, whatever was shown in the previous one. */
export function forgetReveal(uri: vscode.Uri): void {
  revealed.delete(uri.toString())
}

export function suppressReveal(uri: vscode.Uri): void {
  const key = uri.toString()
  selfOpened.add(key)
  setTimeout(() => selfOpened.delete(key), 5000)
}

async function commandExists(): Promise<boolean> {
  if (!available) {
    // `Promise.resolve`: the VS Code API answers with a Thenable, and a bare
    // `.then` on one is not a Promise the cache can be typed against.
    available = Promise.resolve(vscode.commands.getCommands(true)).then(
      (commands) => commands.includes(RESULTS_COMMAND),
      () => false
    )
  }
  return available
}

/** What the reveal needs: where to go, and what to highlight once there. */
export interface RevealTarget {
  matches: SearchMatch[]
  /** The search term, when it could be deduced (see `deriveQuery`). */
  query?: string
  /** True when the term is only found with the case the user typed. */
  caseSensitive?: boolean
}

/** The raw result text, for the debug command. */
export async function rawSearchResults(): Promise<string | undefined> {
  if (!(await commandExists())) return undefined
  try {
    const answer = await vscode.commands.executeCommand<unknown>(RESULTS_COMMAND)
    return typeof answer === 'string' ? answer : undefined
  } catch {
    return undefined
  }
}

/**
 * The current search matches for a note, in document order, with the term to
 * highlight when it can be deduced. Empty whenever anything is not as expected
 * — no search view, no results, another editor active, an internal command that
 * changed shape.
 */
export async function searchMatches(
  document: vscode.TextDocument,
  { force = false }: { force?: boolean } = {}
): Promise<RevealTarget> {
  const uri = document.uri
  const key = uri.toString()
  if (uri.scheme !== 'file') return { matches: [] }
  if (selfOpened.delete(uri.toString())) return { matches: [] }
  if (!(await commandExists())) return { matches: [] }
  try {
    const now = Date.now()
    let results = cache && now - cache.at < CACHE_MS ? cache.results : undefined
    if (results === undefined) {
      const answer = await vscode.commands.executeCommand<unknown>(RESULTS_COMMAND)
      if (typeof answer !== 'string') return { matches: [] }
      results = answer
      cache = { at: Date.now(), results }
    }
    if (results.trim() === '') return { matches: [] }
    const options = { home: os.homedir(), caseSensitive: process.platform === 'linux' }
    const matches = matchesForFile(results, uri.fsPath, options)
    if (matches.length === 0) return { matches: [] }

    // The term, deduced from where the matches are (searchmatches.ts). The
    // note's own lines are read from the document rather than from the search
    // view's preview text, which is trimmed on very long lines.
    const query = deriveQuery(matches, otherMatches(results, uri.fsPath, options), (line) =>
      line >= 1 && line <= document.lineCount ? document.lineAt(line - 1).text : undefined
    )
    if (query === undefined) return force ? { matches } : remember(key, { matches })

    // A case-sensitive search only shows up as a discrepancy in the counts: if
    // the note holds more occurrences ignoring case than the search reported,
    // the case the user typed is what selected them.
    const text = document.getText()
    const insensitive = countOccurrences(text.toLowerCase(), query.toLowerCase())
    const sensitive = countOccurrences(text, query)
    const caseSensitive = insensitive > matches.length && sensitive === matches.length
    const target = { matches, query, caseSensitive }
    return force ? target : remember(key, target)
  } catch {
    return { matches: [] }
  }
}

/** Whether this note was already revealed for what the search holds right now. */
export function alreadyRevealed(uri: vscode.Uri, target: RevealTarget): boolean {
  return revealed.get(uri.toString()) === JSON.stringify([target.query, target.matches])
}

/** Nothing to do when this note was already revealed for these very matches. */
function remember(key: string, target: RevealTarget): RevealTarget {
  const signature = JSON.stringify([target.query, target.matches])
  if (revealed.get(key) === signature) return { matches: [] }
  revealed.set(key, signature)
  return target
}

/** Occurrences of `needle` in `haystack`, overlapping ones included. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++
  return count
}
