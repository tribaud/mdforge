/*
 * MDForge (CodeMirror experiment) — linter diagnostics overlay.
 *
 * The host forwards VS Code diagnostics for the document (markdownlint, spell
 * checkers, …) and this paints them as wavy underlines with the message on
 * hover — the same feedback the native text editor gives, which a custom-editor
 * webview otherwise never shows.
 */
import { StateField, StateEffect } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'

/** One diagnostic, resolved to absolute document offsets. */
export interface LintItem {
  from: number
  to: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
}

export const setDiagnostics = StateEffect.define<LintItem[]>()

export const lintField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setDiagnostics)) continue
      const ranges = effect.value
        .filter((d) => d.to > d.from)
        .sort((a, b) => a.from - b.from || a.to - b.to)
        .map((d) =>
          Decoration.mark({
            class: `cm-lint cm-lint-${d.severity}`,
            attributes: { title: d.message }
          }).range(d.from, d.to)
        )
      deco = Decoration.set(ranges, true)
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f)
})
