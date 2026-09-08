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
 * The gate against revealing at the wrong moment comes for free: the command is
 * served by `getSearchView`, which reads the ACTIVE view of the sidebar. Open a
 * note from the Explorer and the Explorer is active, so there is nothing to
 * return and nothing is revealed; the results only speak while the user is
 * actually looking at them.
 */
import * as vscode from 'vscode'
import * as os from 'os'
import { matchesForFile } from './searchmatches'
import type { SearchMatch } from './searchmatches'

const RESULTS_COMMAND = 'search.action.getSearchResults'

/** Feature detection, once per session. */
let available: Promise<boolean> | undefined

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
  if (!(await commandExists())) return []
  try {
    const results = await vscode.commands.executeCommand<unknown>(RESULTS_COMMAND)
    if (typeof results !== 'string' || results.trim() === '') return []
    return matchesForFile(results, uri.fsPath, {
      home: os.homedir(),
      caseSensitive: process.platform === 'linux'
    })
  } catch {
    return []
  }
}
