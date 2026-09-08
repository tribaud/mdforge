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
import { matchesForFile } from './searchmatches'
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

/**
 * The current search matches for a note, in document order. Empty whenever
 * anything is not as expected — no search view, no results, another editor
 * active, an internal command that changed shape.
 */
export async function searchMatches(uri: vscode.Uri): Promise<SearchMatch[]> {
  if (uri.scheme !== 'file') return []
  if (selfOpened.delete(uri.toString())) return []
  if (!(await commandExists())) return []
  try {
    const now = Date.now()
    let results = cache && now - cache.at < CACHE_MS ? cache.results : undefined
    if (results === undefined) {
      const answer = await vscode.commands.executeCommand<unknown>(RESULTS_COMMAND)
      if (typeof answer !== 'string') return []
      results = answer
      cache = { at: Date.now(), results }
    }
    if (results.trim() === '') return []
    return matchesForFile(results, uri.fsPath, {
      home: os.homedir(),
      caseSensitive: process.platform === 'linux'
    })
  } catch {
    return []
  }
}
