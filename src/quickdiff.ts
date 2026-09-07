/*
 * Quick diff — the added / modified / deleted markers MDForge paints in its own
 * left margin.
 *
 * A custom editor never gets VS Code's own gutter decorations (they belong to
 * the text editor), and it cannot render inside the diff editor either: the
 * `customEditorDiffs` API that hands one webview BOTH sides of a diff is still
 * proposed, so it is stripped for Marketplace extensions (see CLAUDE.md §9).
 * What IS reachable with the stable API is the single-file case, which is the
 * one that matters while writing: read the committed text through the built-in
 * Git extension, diff it against the editor's LIVE text (unsaved changes
 * included — the host TextDocument is always in sync), and post line ranges the
 * webview paints itself.
 *
 * The diff itself is in `linediff.ts`, which imports nothing and is tested.
 */
import * as vscode from 'vscode'
import { diffLines } from './linediff'
import type { LineChange } from './linediff'

/*
 * A structural subset of `vscode.git`'s exported API — only what is used here.
 * Declaring it locally keeps MDForge dependency-free: the Git extension ships
 * its `git.d.ts` inside VS Code, not as a package we could depend on.
 */
interface GitRepository {
  readonly rootUri: vscode.Uri
  readonly state: { readonly onDidChange: vscode.Event<void> }
  show(ref: string, path: string): Promise<string>
}

interface GitApi {
  readonly onDidOpenRepository: vscode.Event<GitRepository>
  getRepository(uri: vscode.Uri): GitRepository | null
}

interface GitExtension {
  readonly enabled: boolean
  getAPI(version: 1): GitApi
}

let apiPromise: Promise<GitApi | undefined> | undefined

/** The Git extension's API, activated on first use. Cached, failure included. */
async function gitApi(): Promise<GitApi | undefined> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const extension = vscode.extensions.getExtension<GitExtension>('vscode.git')
      if (!extension) return undefined
      try {
        const exports = extension.isActive ? extension.exports : await extension.activate()
        return exports.enabled ? exports.getAPI(1) : undefined
      } catch {
        return undefined
      }
    })()
  }
  return apiPromise
}

/**
 * The committed text to compare against: the staged version when the file has
 * one, else `HEAD` — the same base as VS Code's own quick diff, which reads
 * `git show :file`. `undefined` when the file is untracked or unreadable, which
 * is not an error: a new note simply has nothing to compare to.
 */
async function baseText(repository: GitRepository, fsPath: string): Promise<string | undefined> {
  for (const ref of ['', 'HEAD']) {
    try {
      return await repository.show(ref, fsPath)
    } catch {
      // Not staged / not in HEAD / not tracked — try the next ref, then give up.
    }
  }
  return undefined
}

/**
 * Watches one document and posts its quick-diff markers whenever they can have
 * changed: an edit (debounced — this fires on every keystroke the webview sends
 * back), a repository state change (commit, stage, branch switch), or the
 * setting being toggled. Disposed with the editor panel.
 */
export class QuickDiff {
  private readonly subscriptions: vscode.Disposable[] = []
  private repositorySubscription: vscode.Disposable | undefined
  private repository: GitRepository | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Guards against an older `show()` resolving after a newer one. */
  private generation = 0
  private lastPosted: string | undefined
  private disposed = false

  public constructor(
    private readonly document: vscode.TextDocument,
    private readonly post: (changes: LineChange[]) => void
  ) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() === this.document.uri.toString()) this.schedule(300)
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mdforge.quickDiff', this.document.uri)) this.schedule(0)
      })
    )
    void this.attach()
  }

  /** Recompute now — used on `ready`, once the webview can receive markers. */
  public refresh(): void {
    this.schedule(0)
  }

  public dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.repositorySubscription?.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('mdforge', this.document.uri)
      .get<boolean>('quickDiff', true)
  }

  /** Find the repository holding this note, and follow its state. */
  private async attach(): Promise<void> {
    const api = await gitApi()
    if (!api || this.disposed) return
    const bind = (repository: GitRepository | null | undefined): boolean => {
      if (!repository || this.repository) return false
      this.repository = repository
      this.repositorySubscription = repository.state.onDidChange(() => this.schedule(0))
      return true
    }
    if (!bind(api.getRepository(this.document.uri))) {
      // The repository may still be opening (a fresh window scans in the
      // background); take it as soon as it covers this file.
      this.subscriptions.push(
        api.onDidOpenRepository(() => {
          if (bind(api.getRepository(this.document.uri))) this.schedule(0)
        })
      )
    }
    this.schedule(0)
  }

  private schedule(delay: number): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.compute()
    }, delay)
  }

  private async compute(): Promise<void> {
    const generation = ++this.generation
    if (!this.enabled() || !this.repository) {
      this.send(generation, [])
      return
    }
    const base = await baseText(this.repository, this.document.uri.fsPath)
    if (base === undefined) {
      this.send(generation, [])
      return
    }
    this.send(generation, diffLines(base, this.document.getText()))
  }

  private send(generation: number, changes: LineChange[]): void {
    if (this.disposed || generation !== this.generation) return
    // The document changes far more often than the markers do — a paragraph
    // being typed stays one modified line — so skip identical posts.
    const key = JSON.stringify(changes)
    if (key === this.lastPosted) return
    this.lastPosted = key
    this.post(changes)
  }
}
