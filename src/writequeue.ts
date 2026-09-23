/*
 * One write at a time into a document, and only the latest text.
 *
 * The webview posts an `edit` per keystroke, and the host's message handler is
 * async: without a queue, a second write computed its full-document range while
 * the first was still in flight, against a document that had not changed yet.
 * Under key repeat (a held Backspace) the writes overlapped, the file ended up
 * holding something the webview never sent, the echo guard stopped matching,
 * and the host sent that text back as `setContent` — a whole-document replace
 * under the user's fingers, caret put back by content, characters eaten
 * elsewhere. The symptom was "the cursor jumps and deletes at random".
 *
 * Intermediate keystrokes are COALESCED: the webview holds the truth, so only
 * its latest text has to reach the document. Dropping the ones in between costs
 * nothing and keeps a fast typist off the critical path of `applyEdit`.
 *
 * This module imports nothing, so `npm run test:writes` exercises the ordering
 * outside an Extension Host — which is where the bug lived, not in the VS Code
 * API it calls.
 */

export interface WriterHooks {
  /** The document's text RIGHT NOW — read again after every write. */
  read: () => string
  /** Apply one whole-document replace; resolves when the document holds it. */
  apply: (text: string) => Promise<void>
  /** Called when `apply` rejects; the queue carries on with what is pending. */
  onError?: (error: unknown) => void
}

export interface Writer {
  /** Ask for `text` to become the document's content. */
  write: (text: string) => Promise<void>
  /** Whether a write is in flight — for tests and diagnostics. */
  busy: () => boolean
}

export function createWriter({ read, apply, onError }: WriterHooks): Writer {
  let pending: string | undefined
  let running: Promise<void> | undefined

  const drain = async (): Promise<void> => {
    try {
      for (;;) {
        const next = pending
        if (next === undefined) return
        pending = undefined
        // Nothing to do, and skipping it keeps an empty edit out of the undo
        // stack — a keystroke the user already sees does not need writing.
        if (next === read()) continue
        try {
          await apply(next)
        } catch (error) {
          // A failed write must not wedge the queue: whatever arrived while it
          // was in flight is still worth writing.
          onError?.(error)
        }
      }
    } finally {
      running = undefined
    }
  }

  return {
    write(text: string): Promise<void> {
      pending = text
      if (!running) {
        /*
         * The hop matters. `drain()` can finish WITHOUT ever awaiting — a text
         * the document already holds is skipped, and the loop then ends
         * synchronously. Its `finally` would clear `running` before the
         * assignment below ever ran, leaving a settled promise in place for
         * good: `busy()` stuck at true and every later write dropped in
         * silence. Starting one microtask later means the assignment always
         * lands first.
         */
        running = Promise.resolve().then(drain)
      }
      return running
    },
    busy: () => running !== undefined
  }
}
