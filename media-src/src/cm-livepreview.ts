/*
 * MDForge (CodeMirror experiment) — Obsidian-style "Live Preview".
 *
 * The CodeMirror document IS the Markdown text: no semantic model, no
 * re-serialization, so an edit only changes the characters typed. "Rendering"
 * is done with decorations — syntax markers are hidden and content styled, and
 * the raw syntax is revealed whenever the selection enters a node.
 *
 * Covers: headings, bold/italic/code/strike, links, images, three-state task
 * checkboxes (incl. the MDForge `[~]` in-progress state), fenced code blocks
 * (with syntax highlighting), Mermaid diagrams, GFM tables, GitHub alerts,
 * wikilinks, YAML frontmatter, footnotes and KaTeX math ($…$ / $$…$$).
 */
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Range } from '@codemirror/state'

/* ---------- host bridge (wikilink navigation) ---------- */
let onWikilink: (target: string) => void = () => {}
export function setWikilinkHandler(fn: (target: string) => void): void {
  onWikilink = fn
}
/** Called by the DOM handler wired in main.ts. */
export function openWikilink(target: string): void {
  onWikilink(target)
}

/* ---------- config: MDForge `[~]` in-progress checkbox state ---------- */
// GFM only knows `[ ]`/`[x]`; `[~]` is an MDForge convention. When the setting
// `mdforge.checkbox.enableInProgress` is off, the click cycle skips `~`.
let enableInProgress = true
export function setEnableInProgress(on: boolean): void {
  enableInProgress = on
}

/* ---------- assets (images) ---------- */
let assetsBase = ''
export function setAssetsBase(uri: string): void {
  assetsBase = uri.replace(/\/$/, '')
}
function resolveSrc(src: string): string {
  if (/^(https?:|data:|blob:|vscode-webview:|vscode-resource:)/i.test(src)) return src
  return assetsBase ? `${assetsBase}/${src.replace(/^\.\//, '')}` : src
}

/* ---------- mermaid (lazy-loaded so it can never block editor startup) ---------- */
/* Four of these are mermaid's own themes; the rest are ours, built on `base` —
 * the only built-in theme meant to be re-coloured through `themeVariables`
 * (colouring `default` fights values it has already derived). `themeCSS` is
 * appended after the theme's own rules inside the SVG's <style>, so a plain
 * `stroke-width` there wins on order alone — deliberately without `!important`,
 * which would also override a diagram's own `classDef` (mermaid writes those as
 * inline styles, and those must keep the last word). */
interface MermaidThemeDef {
  theme: 'default' | 'dark' | 'forest' | 'neutral' | 'base'
  themeVariables?: Record<string, string>
  themeCSS?: string
}

/** Thick outlines and bold labels — the point of the `contrast` themes. Labels
 * are `<text>` in some diagram kinds and a `foreignObject` span in others, hence
 * both families of selectors. */
const THICK_BOLD = `
  .node rect, .node circle, .node ellipse, .node polygon, .node path { stroke-width: 3px; }
  .cluster rect { stroke-width: 2.5px; }
  .edgePath .path, .flowchart-link, .messageLine0, .messageLine1, .relation,
  .relationshipLine, .transition { stroke-width: 2.5px; }
  .marker, .marker path { stroke-width: 1.5px; }
  text, tspan, .nodeLabel, .edgeLabel, .label, .cluster-label, .titleText,
  .actor, .messageText, .loopText, .noteText, .taskText, .sectionTitle,
  .classTitle, .stateLabel, .entityLabel, .relationshipLabel, .pieTitleText,
  .slice, .legend text { font-weight: 700; }
`

/** Pie slices are the one place a deliberately monochrome palette breaks down:
 * mermaid derives `pie1…` from primary/secondary/tertiary, so three near-white
 * fills came out indistinguishable. Give each theme an explicit ramp (and drop
 * the default 0.7 opacity, which washes it out again). */
const pieRamp = (colors: string[], text: string, stroke: string): Record<string, string> => ({
  pieOpacity: '1',
  pieStrokeColor: stroke,
  pieSectionTextColor: text,
  pieTitleTextColor: text,
  pieLegendTextColor: text,
  ...Object.fromEntries(colors.map((c, i) => [`pie${i + 1}`, c]))
})

const BLUE_PIE = ['#f0f5fc', '#dce8f7', '#c3d5e8', '#aac2dd', '#97b5d5', '#85a8cd', '#dce8f7', '#c3d5e8']
const BLUE_PIE_DARK = ['#1c3a5c', '#24486e', '#2d5680', '#366492', '#3f72a4', '#4880b6', '#24486e', '#2d5680']
const GREY_PIE = ['#ffffff', '#ececec', '#d9d9d9', '#c6c6c6', '#b3b3b3', '#a0a0a0', '#ececec', '#d9d9d9']
const GREY_PIE_DARK = ['#1c1c1c', '#2b2b2b', '#3a3a3a', '#494949', '#585858', '#676767', '#2b2b2b', '#3a3a3a']

const MERMAID_THEMES = {
  default: { theme: 'default' },
  dark: { theme: 'dark' },
  forest: { theme: 'forest' },
  neutral: { theme: 'neutral' },
  // The palette asked for: a light, cool blue — pale fills, a soft steel-blue
  // outline, deep navy text. Deliberately NOT the saturated blue tried first,
  // which read as too dark.
  blue: {
    theme: 'base',
    themeVariables: {
      background: 'transparent',
      primaryColor: '#dce8f7',
      primaryTextColor: '#12233d',
      primaryBorderColor: '#7fa3cc',
      secondaryColor: '#e8eef7',
      secondaryTextColor: '#12233d',
      secondaryBorderColor: '#7fa3cc',
      tertiaryColor: '#fafcfe',
      tertiaryTextColor: '#12233d',
      tertiaryBorderColor: '#c3d5e8',
      mainBkg: '#dce8f7',
      nodeBorder: '#7fa3cc',
      lineColor: '#5b7fa6',
      textColor: '#12233d',
      titleColor: '#12233d',
      clusterBkg: '#fafcfe',
      clusterBorder: '#c3d5e8',
      edgeLabelBackground: '#eaf1f9',
      ...pieRamp(BLUE_PIE, '#12233d', '#7fa3cc')
    }
  },
  // The same blue for a dark editor. It is not cosmetic: text that floats on the
  // page rather than on a filled shape (a gantt title, its dates, a section
  // label) is painted with `textColor` / `titleColor`, so the light palette left
  // those navy-on-near-black and unreadable.
  'blue-dark': {
    theme: 'base',
    themeVariables: {
      darkMode: 'true',
      background: 'transparent',
      primaryColor: '#1c3a5c',
      primaryTextColor: '#dce8f7',
      primaryBorderColor: '#7fa3cc',
      secondaryColor: '#24405e',
      secondaryTextColor: '#dce8f7',
      secondaryBorderColor: '#7fa3cc',
      tertiaryColor: '#16283c',
      tertiaryTextColor: '#dce8f7',
      tertiaryBorderColor: '#5b7fa6',
      mainBkg: '#1c3a5c',
      nodeBorder: '#7fa3cc',
      lineColor: '#8fb4d8',
      textColor: '#dce8f7',
      titleColor: '#b9d2ea',
      clusterBkg: '#16283c',
      clusterBorder: '#5b7fa6',
      edgeLabelBackground: '#1c3a5c',
      ...pieRamp(BLUE_PIE_DARK, '#eaf2fb', '#7fa3cc')
    }
  },
  // White (or barely grey) fills, BLACK thick outlines, near-black bold labels:
  // the one that survives a projector, a printout and a screenshot pasted into a
  // document.
  contrast: {
    theme: 'base',
    themeVariables: {
      background: 'transparent',
      primaryColor: '#ffffff',
      primaryTextColor: '#111111',
      primaryBorderColor: '#000000',
      secondaryColor: '#f2f3f5',
      secondaryTextColor: '#111111',
      secondaryBorderColor: '#000000',
      tertiaryColor: '#ffffff',
      tertiaryTextColor: '#111111',
      tertiaryBorderColor: '#000000',
      mainBkg: '#ffffff',
      nodeBorder: '#000000',
      lineColor: '#000000',
      textColor: '#111111',
      titleColor: '#000000',
      clusterBkg: '#f6f7f8',
      clusterBorder: '#000000',
      edgeLabelBackground: '#ffffff',
      ...pieRamp(GREY_PIE, '#111111', '#000000')
    },
    themeCSS: THICK_BOLD
  },
  // The same thick lines for a dark editor — `contrast` on dark is unreadable.
  'contrast-dark': {
    theme: 'base',
    themeVariables: {
      darkMode: 'true',
      background: 'transparent',
      primaryColor: '#1c1c1c',
      primaryTextColor: '#ffffff',
      primaryBorderColor: '#ffffff',
      secondaryColor: '#2a2a2a',
      secondaryTextColor: '#ffffff',
      secondaryBorderColor: '#ffffff',
      tertiaryColor: '#141414',
      tertiaryTextColor: '#ffffff',
      tertiaryBorderColor: '#ffffff',
      mainBkg: '#1c1c1c',
      nodeBorder: '#ffffff',
      lineColor: '#ffffff',
      textColor: '#ffffff',
      titleColor: '#ffffff',
      clusterBkg: '#141414',
      clusterBorder: '#ffffff',
      edgeLabelBackground: '#1c1c1c',
      ...pieRamp(GREY_PIE_DARK, '#ffffff', '#ffffff')
    },
    themeCSS: THICK_BOLD
  }
} satisfies Record<string, MermaidThemeDef>

type MermaidTheme = keyof typeof MERMAID_THEMES


let mermaidTheme: MermaidTheme = 'default'
/** Is the EDITOR dark? Not the same question as `prefers-color-scheme`, which in
 * a webview reports the OS: a light VS Code theme on a dark macOS answered "dark"
 * and `auto` drew dark diagrams on a white page. VS Code stamps its theme kind on
 * the document (`data-vscode-theme-kind`, plus a `vscode-*` body class); the
 * media query is only the fallback (the headless harness has neither). */
function editorIsDark(): boolean {
  const kind = `${document.documentElement.dataset.vscodeThemeKind ?? ''} ${document.body.className}`
  if (/light/.test(kind)) return false // vscode-light, vscode-high-contrast-light
  if (/dark|high-contrast/.test(kind)) return true
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
}
/** The full mermaid config for the theme in force (re-read on every render). */
function mermaidConfig(): object {
  return { startOnLoad: false, securityLevel: 'loose', ...MERMAID_THEMES[mermaidTheme] }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidMod: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mermaidLoading: Promise<any> | null = null
async function getMermaid(): Promise<unknown> {
  if (mermaidMod) return mermaidMod
  if (!mermaidLoading) {
    mermaidLoading = import('mermaid').then((m) => {
      mermaidMod = m.default ?? m
      mermaidMod.initialize(mermaidConfig())
      return mermaidMod
    })
  }
  return mermaidLoading
}
/** Resolve the setting to a theme in the table. A **named** theme is taken
 * literally — `blue` is that light blue whatever the editor looks like. An
 * earlier version auto-swapped it for its dark twin, which surprised: the
 * dropdown said `blue` and the diagram came out navy. The dark palettes are
 * offered under their own names (`blue-dark`, `contrast-dark`); only `auto` (and
 * any unknown value) follows the editor. */
export function setMermaidTheme(theme: string): boolean {
  const prev = mermaidTheme
  mermaidTheme =
    Object.hasOwn(MERMAID_THEMES, theme) ? (theme as MermaidTheme) : editorIsDark() ? 'dark' : 'default'
  if (mermaidMod) mermaidMod.initialize(mermaidConfig())
  return mermaidTheme !== prev
}

// Bumped whenever every diagram must be re-rendered (a theme change). It is
// baked into MermaidWidget.eq(), so a bump makes CodeMirror rebuild the diagram
// DOM — mermaid only reads the theme at render time, and existing widgets would
// otherwise be reused with their stale SVG.
let mermaidGen = 0
const redrawMermaidEffect = StateEffect.define<void>()
/** Re-render every Mermaid diagram in the document (after a theme change). */
export function redrawMermaid(view: EditorView): void {
  mermaidGen++
  view.dispatch({ effects: redrawMermaidEffect.of(undefined) })
}

let mermaidCounter = 0
/**
 * On a parse error, Mermaid injects a temporary/error element into
 * `document.body` and does not remove it. Because the preview re-renders on
 * every keystroke, these orphans pile up outside the editor (off-scroll,
 * covering the screen). Remove any Mermaid element not mounted in one of our
 * widgets after each render.
 */
function sweepMermaidOrphans(): void {
  document.querySelectorAll('[id^="mdforge-mermaid-"], [id^="dmdforge-mermaid-"]').forEach((n) => {
    if (!n.closest('.cm-mermaid')) n.remove()
  })
}
// Mermaid keeps global/DOM state for the duration of a render(): two renders in
// flight at once clobber each other's temporary node — and our orphan-sweep can
// yank an in-flight one — surfacing as "Cannot read properties of null (reading
// 'firstChild')". Serialize every render through a single promise chain so a doc
// with several diagrams (or a manual refresh) renders them one at a time. This is
// why entering/leaving the source — an isolated single re-render — used to fix it.
/* ---------- fitting a diagram to the text column ----------
 * Mermaid gives the <svg> an inline `max-width: <natural>px`; fitting means
 * raising that ceiling to the column width. It has to be done here, in px,
 * rather than with a CSS height cap: capping the HEIGHT letterboxes a tall
 * diagram — the box keeps the column width and the drawing shrinks inside it,
 * ending up SMALLER than its natural size (a 200×1500 diagram in an 800px column
 * measured 96×720). So the ceiling is the width at which the diagram would be
 * `FIT_MAX_HEIGHT` of the frame tall, and never below the natural width.
 *
 * The ceiling is written in px, clamped to the column measured here — NOT as
 * `min(…, 100%)`: with the fit off the target is shrink-to-fit, a percentage has
 * no definite width to resolve against, and the <svg> fell back to the 300px
 * default of a replaced element (a 543px-wide diagram rendered at 300). */
const FIT_MAX_HEIGHT = 0.8

/** Returns true when it actually changed the element (so callers can avoid a
 * pointless re-measure, and a geometry-driven refit cannot loop). */
function fitMermaidSvg(target: Element): boolean {
  const svg = target.firstElementChild
  if (!(svg instanceof SVGSVGElement)) return false
  const box = svg.viewBox.baseVal
  const natural = box.width || svg.getBoundingClientRect().width
  if (!natural) return false
  const fit = document.body.classList.contains('mdforge-mermaid-fit')
  const ratio = box.height ? box.width / box.height : 0
  const capped = ratio ? Math.max(natural, window.innerHeight * FIT_MAX_HEIGHT * ratio) : Infinity
  const ceiling = fit ? capped : natural
  // Available width of the block, padding excluded (0 before the first layout).
  const block = target.parentElement
  const cs = block ? getComputedStyle(block) : null
  const avail = block
    ? block.clientWidth - parseFloat(cs?.paddingLeft || '0') - parseFloat(cs?.paddingRight || '0')
    : 0
  const width = avail > 0 ? Math.min(ceiling, avail) : ceiling
  if (!Number.isFinite(width)) return false
  // An explicit px WIDTH, not just a ceiling: mermaid emits `width="100%"` with
  // no height, and a percentage against a shrink-to-fit parent is indefinite —
  // the <svg> then falls back to the 300px default of a replaced element. That
  // is why a diagram wider than 300px came out at 300px with the fit off.
  const px = `${Math.round(width)}px`
  if (svg.style.width === px) return false
  svg.style.width = px
  svg.style.maxWidth = px
  return true
}

/** Re-fit every diagram on screen — the fit depends on the frame height, so a
 * resize (or turning the setting off) invalidates it without re-rendering. */
export function refitMermaid(view: EditorView): void {
  let changed = false
  document.querySelectorAll('.cm-mermaid-target').forEach((t) => {
    if (fitMermaidSvg(t)) changed = true
  })
  if (changed) view.requestMeasure()
}

let mermaidQueue: Promise<void> = Promise.resolve()
function renderMermaid(view: EditorView, el: HTMLElement, code: string): void {
  mermaidQueue = mermaidQueue.then(() => renderMermaidOnce(view, el, code)).catch(() => {})
}
async function renderMermaidOnce(view: EditorView, el: HTMLElement, code: string, attempt = 0): Promise<void> {
  const id = `mdforge-mermaid-${mermaidCounter++}`
  try {
    const m = (await getMermaid()) as { render: (id: string, code: string) => Promise<{ svg: string }> }
    const { svg } = await m.render(id, code)
    el.classList.remove('cm-mermaid-error')
    el.innerHTML = svg
    fitMermaidSvg(el)
  } catch (error: unknown) {
    // A first render can still fail transiently (fonts/layout not ready); a
    // single retry usually succeeds, so try once more before showing the error.
    if (attempt < 1) {
      sweepMermaidOrphans()
      await renderMermaidOnce(view, el, code, attempt + 1)
      return
    }
    el.classList.add('cm-mermaid-error')
    el.textContent = `Mermaid error: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    // The SVG changes the widget height after CodeMirror measured the layout;
    // re-measure so vertical click/caret mapping below stays accurate.
    sweepMermaidOrphans()
    view.requestMeasure()
  }
}

/* ---------- KaTeX (lazy-loaded, same reasoning as Mermaid) ---------- */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let katexMod: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let katexLoading: Promise<any> | null = null
async function getKatex(): Promise<unknown> {
  if (katexMod) return katexMod
  if (!katexLoading) {
    katexLoading = import('katex').then((m) => {
      katexMod = m.default ?? m
      return katexMod
    })
  }
  return katexLoading
}
function renderMath(view: EditorView, el: HTMLElement, code: string, display: boolean): void {
  getKatex()
    .then((k) => {
      ;(k as { render: (expr: string, el: HTMLElement, opts: object) => void }).render(code, el, {
        displayMode: display,
        throwOnError: false,
        output: 'html'
      })
      view.requestMeasure()
    })
    .catch((error: unknown) => {
      el.classList.add('cm-math-error')
      el.textContent = code
      view.requestMeasure()
      void error
    })
}

/** True when a selection range touches [from, to] — then we reveal raw syntax. */
function editing(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true
  }
  return false
}

/* ---------- widgets ---------- */
type BlockMode = 'render' | 'preview'

/** Drop the caret into a block's source at `pos`, which — via the reveal-on-edit
 * rule — shows the editable source with a live preview underneath. */
function enterEdit(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
  view.focus()
}

/**
 * Add an "✎ Éditer" affordance to a rendered block widget. Only the button
 * enters edit mode — clicking the rendered body leaves the caret alone (so the
 * diagram/table stays a stable, non-disruptive preview until you ask to edit).
 */
function addEditButton(host: HTMLElement, view: EditorView, pos: number, tip = 'Éditer la source'): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-edit'
  btn.textContent = '✎ Éditer'
  btn.title = tip
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    enterEdit(view, pos)
  })
  host.appendChild(btn)
}

/**
 * Add a "↻" affordance to a rendered block that re-runs its render. Mermaid can
 * occasionally fail transiently (a race on first load, a font not yet ready) and
 * leave an error where re-rendering the same source succeeds — this gives that a
 * one-click retry without having to enter and leave the source.
 */
function addRefreshButton(host: HTMLElement, rerender: () => void): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-refresh'
  btn.textContent = '↻'
  btn.title = 'Redessiner le diagramme'
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    rerender()
  })
  host.appendChild(btn)
}

const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'

/** Add a "⤢" affordance that opens the diagram full-screen (zoom + pan). Reads
 * the currently rendered SVG at click time (the render is async). */
function addZoomButton(host: HTMLElement, getSvg: () => string): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-zoom'
  btn.innerHTML = EXPAND_ICON
  btn.title = 'Agrandir'
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const svg = getSvg()
    if (svg.trim()) openMermaidZoom(svg)
  })
  host.appendChild(btn)
}

/** A centered popup showing a diagram larger, with wheel/±-button zoom and
 * drag-to-pan. The diagram is an SVG scaled by CSS transform (kept off a
 * compositor layer so it stays vector-crisp, not a pixelated raster). Esc, ✕ or
 * a click on the dimmed backdrop closes it; dragging happens inside the panel so
 * it never closes mid-pan. Self-contained DOM on `document.body`. */
function openMermaidZoom(svg: string): void {
  const overlay = document.createElement('div')
  overlay.className = 'cm-mermaid-zoom'

  const panel = document.createElement('div')
  panel.className = 'cm-mermaid-zoom-panel'
  overlay.appendChild(panel)

  const stage = document.createElement('div')
  stage.className = 'cm-mermaid-zoom-stage'
  stage.innerHTML = svg
  panel.appendChild(stage)

  let scale = 1
  let tx = 0
  let ty = 0
  const apply = (): void => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  }
  const zoom = (factor: number): void => {
    scale = Math.min(8, Math.max(0.2, scale * factor))
    apply()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
    else if (e.key === '+' || e.key === '=') zoom(1.2)
    else if (e.key === '-') zoom(1 / 1.2)
  }
  function close(): void {
    window.removeEventListener('keydown', onKey)
    overlay.remove()
  }

  const bar = document.createElement('div')
  bar.className = 'cm-mermaid-zoom-bar'
  const mk = (label: string, title: string, fn: () => void): void => {
    const b = document.createElement('button')
    b.textContent = label
    b.title = title
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      fn()
    })
    bar.appendChild(b)
  }
  mk('−', 'Zoom arrière', () => zoom(1 / 1.2))
  mk('⟳', 'Taille réelle', () => {
    scale = 1
    tx = 0
    ty = 0
    apply()
  })
  mk('+', 'Zoom avant', () => zoom(1.2))
  mk('✕', 'Fermer', close)
  panel.appendChild(bar)

  panel.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
    },
    { passive: false }
  )
  // Drag to pan. Start on the stage (which fills the panel), track on the panel
  // so a drag never reaches the backdrop's close handler.
  let dragging = false
  let sx = 0
  let sy = 0
  stage.addEventListener('mousedown', (e) => {
    dragging = true
    sx = e.clientX - tx
    sy = e.clientY - ty
    e.preventDefault()
  })
  panel.addEventListener('mousemove', (e) => {
    if (!dragging) return
    tx = e.clientX - sx
    ty = e.clientY - sy
    apply()
  })
  const endDrag = (): void => {
    dragging = false
  }
  panel.addEventListener('mouseup', endDrag)
  panel.addEventListener('mouseleave', endDrag)
  // Only a click on the dimmed backdrop (never the panel) closes.
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })
  window.addEventListener('keydown', onKey)

  document.body.appendChild(overlay)
  apply()
}

/**
 * Add a "✓ Terminer" button to a block's edit-time preview panel that moves the
 * caret out of the block (to the line after it) — so the source collapses back
 * to the rendered view. Big blocks (mermaid/math) are otherwise hard to exit.
 */
function addCloseButton(host: HTMLElement, view: EditorView): void {
  const btn = document.createElement('button')
  btn.className = 'cm-block-close'
  btn.textContent = '✓ Terminer'
  btn.title = "Fermer l'éditeur (sortir du bloc)"
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const doc = view.state.doc
    const pos = Math.max(0, Math.min(view.posAtDOM(btn), doc.length))
    const after = Math.min(doc.length, doc.lineAt(pos).to + 1)
    view.dispatch({ selection: { anchor: after }, scrollIntoView: true })
    view.focus()
  })
  host.appendChild(btn)
}

type TaskState = ' ' | '~' | 'x'
const NEXT_STATE: Record<TaskState, TaskState> = { ' ': '~', '~': 'x', x: ' ' }
/** Next checkbox state on click. With the in-progress state disabled, cycle
 * unchecked ⇄ checked directly (a `~` already in the file still resolves to
 * checked, so the marker is never orphaned). */
function nextTaskState(s: TaskState): TaskState {
  if (enableInProgress) return NEXT_STATE[s]
  return s === 'x' ? ' ' : 'x'
}

class TaskWidget extends WidgetType {
  constructor(readonly state: TaskState) {
    super()
  }
  eq(other: TaskWidget): boolean {
    return other.state === this.state
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-task-checkbox'
    box.checked = this.state === 'x'
    box.indeterminate = this.state === '~'
    if (this.state === '~') box.classList.add('cm-task-inprogress')
    box.addEventListener('mousedown', (e) => e.preventDefault())
    box.addEventListener('click', (e) => {
      e.preventDefault()
      const line = view.state.doc.lineAt(view.posAtDOM(box))
      const m = /\[([ xX~])\]/.exec(line.text)
      if (!m) return
      const from = line.from + m.index
      const current = (m[1].toLowerCase() === 'x' ? 'x' : m[1]) as TaskState
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: nextTaskState(current) } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly pos: number,
    readonly mode: BlockMode
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.mode === this.mode
  }
  get estimatedHeight(): number {
    return 180
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = this.mode === 'preview' ? 'cm-image-wrap cm-block-preview' : 'cm-image-wrap'
    const img = document.createElement('img')
    img.src = resolveSrc(this.src)
    img.alt = this.alt
    // Hover shows the raw address (web vs local) without editing.
    img.title = this.alt ? `${this.alt} — ${this.src}` : this.src
    img.className = 'cm-inline-image'
    // Image loads async and changes height → re-measure so caret mapping holds.
    img.addEventListener('load', () => view.requestMeasure())
    wrap.appendChild(img)
    // Same affordance as mermaid/table: ✎ to edit the source (URL + caption),
    // ✓ Terminer to leave — the image stays visible the whole time.
    if (this.mode === 'render') addEditButton(wrap, view, this.pos)
    else addCloseButton(wrap, view)
    return wrap
  }
}

/** Compact horizontal rule — a block widget so the `---` source line collapses
 * to just the rule (no lingering empty-looking line) when the caret is away. */
class HrWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-hr-widget'
    el.appendChild(document.createElement('hr'))
    return el
  }
}

class MermaidWidget extends WidgetType {
  // Snapshot of the redraw counter at build time — a theme change bumps it so
  // eq() reports inequality and CodeMirror rebuilds the diagram with the theme.
  readonly gen = mermaidGen
  constructor(
    readonly code: string,
    readonly pos: number,
    readonly mode: BlockMode
  ) {
    super()
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.mode === this.mode && other.gen === this.gen
  }
  get estimatedHeight(): number {
    return 200
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = this.mode === 'preview' ? 'cm-mermaid cm-block-preview' : 'cm-mermaid'
    const target = document.createElement('div')
    target.className = 'cm-mermaid-target'
    el.appendChild(target)
    renderMermaid(view, target, this.code)
    if (this.mode === 'render') {
      addZoomButton(el, () => target.innerHTML)
      addRefreshButton(el, () => renderMermaid(view, target, this.code))
      addEditButton(el, view, this.pos)
    } else addCloseButton(el, view)
    return el
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly display: boolean,
    readonly pos = -1,
    readonly mode: BlockMode = 'render'
  ) {
    super()
  }
  eq(other: MathWidget): boolean {
    return other.code === this.code && other.display === this.display && other.mode === this.mode
  }
  get estimatedHeight(): number {
    return this.display ? 44 : -1
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className =
      (this.display ? 'cm-math cm-math-block' : 'cm-math cm-math-inline') +
      (this.mode === 'preview' ? ' cm-block-preview' : '')
    if (this.display) {
      const target = document.createElement('div')
      el.appendChild(target)
      renderMath(view, target, this.code, true)
      if (this.mode === 'render' && this.pos >= 0) addEditButton(el, view, this.pos)
      else if (this.mode === 'preview') addCloseButton(el, view)
    } else {
      renderMath(view, el, this.code, false)
    }
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

/* ---------- rich inline rendering (used by table cells) ---------- */

/** Raw-HTML tags kept when a cell carries HTML. Anything else is dropped but its
 * content is still rendered, so an unknown wrapper never eats the text. */
const HTML_TAGS = new Set([
  'a', 'abbr', 'b', 'br', 'cite', 'code', 'del', 'em', 'i', 'img', 'ins', 'kbd', 'mark', 'q',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'var', 'wbr'
])
/** Tags whose *content* is dropped too (never rendered, never executed). */
const HTML_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta'])
const HTML_ATTRS = new Set(['href', 'src', 'alt', 'title', 'width', 'height', 'style', 'align', 'lang', 'dir'])
/** A cell needs the HTML path as soon as it carries something tag-shaped. */
const HAS_TAG = /<[a-zA-Z!/][^>]*>/

/** Refuse the script-bearing URL schemes; everything else (relative paths,
 * http(s), mailto, vscode-webview…) is left to `resolveSrc`/the host. */
function safeUrl(url: string): string {
  return /^\s*(javascript|vbscript|data:text\/html)/i.test(url) ? '' : url.trim()
}

/** Keep only declarations that cannot fetch or execute anything. */
function safeStyle(style: string): string {
  return style
    .split(';')
    .filter((d) => d.trim() && !/url\s*\(|expression\s*\(|javascript:/i.test(d))
    .join(';')
}

/** `![alt](src)` / `<img>` inside a cell → an <img> that re-measures the layout
 * once loaded (a widget whose height changes after CM measured drifts the caret). */
function appendImage(view: EditorView, container: HTMLElement, src: string, alt: string, title: string): void {
  const img = document.createElement('img')
  img.src = resolveSrc(src)
  img.alt = alt
  img.title = title || alt || src
  img.className = 'cm-inline-image cm-cell-image'
  img.addEventListener('load', () => view.requestMeasure())
  container.appendChild(img)
}

// Inline Markdown tokens, in priority order: code and math first (their content
// is literal), then the bracket forms (wikilink embed / wikilink / image / link /
// footnote), then emphasis, then bare URLs.
const INLINE_RE =
  /(`[^`]+`)|(\$[^$\n]+?\$)|(!\[\[[^\]\n]+?\]\])|(\[\[[^\]\n]+?\]\])|(!\[[^\]]*\]\([^)]*\))|(\[\^[^\]\s]+\])|(\[[^\]]*\]\([^)]*\))|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>()]+)/g

/** Render one inline token. Emphasis/link labels recurse, so `**[a](b)**` and
 * `*`code`*` render like they do in the body text. */
function appendToken(view: EditorView, container: HTMLElement, tok: string): void {
  if (tok.startsWith('`')) {
    const c = document.createElement('code')
    c.className = 'cm-md-code'
    c.textContent = tok.slice(1, -1)
    container.appendChild(c)
    return
  }
  if (tok.startsWith('$')) {
    const s = document.createElement('span')
    renderMath(view, s, tok.slice(1, -1), false)
    container.appendChild(s)
    return
  }
  if (tok.startsWith('![[')) {
    // Obsidian embed of an image asset.
    const target = tok.slice(3, -2).split('|')[0].trim()
    appendImage(view, container, target, '', target)
    return
  }
  if (tok.startsWith('[[')) {
    const raw = tok.slice(2, -2)
    const pipe = raw.indexOf('|')
    const target = (pipe === -1 ? raw : raw.slice(0, pipe)).trim()
    const label = (pipe === -1 ? raw : raw.slice(pipe + 1)).trim()
    const a = document.createElement('span')
    a.className = 'cm-md-wikilink'
    a.setAttribute('data-wikilink', target)
    a.textContent = label
    container.appendChild(a)
    return
  }
  if (tok.startsWith('![')) {
    const m = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)$/.exec(tok)
    if (m) appendImage(view, container, m[2], m[1], m[3] ?? '')
    else container.appendChild(document.createTextNode(tok))
    return
  }
  if (tok.startsWith('[^')) {
    const s = document.createElement('span')
    s.className = 'cm-md-footnote-ref'
    s.setAttribute('data-footnote', tok.slice(2, -1))
    s.textContent = tok
    container.appendChild(s)
    return
  }
  if (tok.startsWith('[')) {
    const m = /^\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"([^"]*)")?\s*\)$/.exec(tok)
    const a = document.createElement('a')
    a.className = 'cm-md-link'
    if (m) {
      const url = safeUrl(m[2])
      if (url) {
        a.setAttribute('data-href', url)
        a.title = m[3] || `${url}  (Ctrl/⌘+clic pour ouvrir)`
      }
      renderMarkdown(view, a, m[1])
    } else a.textContent = tok
    container.appendChild(a)
    return
  }
  if (tok.startsWith('**') || tok.startsWith('__')) {
    const b = document.createElement('strong')
    renderMarkdown(view, b, tok.slice(2, -2))
    container.appendChild(b)
    return
  }
  if (tok.startsWith('~~')) {
    const s = document.createElement('span')
    s.className = 'cm-md-strike'
    renderMarkdown(view, s, tok.slice(2, -2))
    container.appendChild(s)
    return
  }
  if (tok.startsWith('*') || tok.startsWith('_')) {
    const i = document.createElement('em')
    renderMarkdown(view, i, tok.slice(1, -1))
    container.appendChild(i)
    return
  }
  const url = safeUrl(tok)
  const a = document.createElement('a')
  a.className = 'cm-md-link'
  a.textContent = tok
  if (url) {
    a.setAttribute('data-href', url)
    a.title = `${url}  (Ctrl/⌘+clic pour ouvrir)`
  }
  container.appendChild(a)
}

/** Render inline Markdown (no HTML) into `container`. */
function renderMarkdown(view: EditorView, container: HTMLElement, text: string): void {
  const re = new RegExp(INLINE_RE.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)))
    appendToken(view, container, m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)))
}

/** Placeholder for a code span pulled out before the HTML parser sees it. A
 * private-use character, NOT NUL: the HTML tokenizer replaces NUL with U+FFFD,
 * so the marker never survived the round-trip and the index leaked as text. */
const CODE_MARK = /\ue000(\d+)\ue000/g

/**
 * Render a raw-HTML fragment: parsed with DOMParser (inert — nothing runs),
 * rebuilt tag by tag through an allow-list, and every text node still goes
 * through the Markdown renderer, so `<span>**gras**</span>` renders bold.
 * Attributes are filtered (no `on*`, no script URL, no `url()` in a style).
 *
 * Inline code is pulled out FIRST: a cell showing `` `<br>` `` means the text
 * `<br>`, and handing it to the HTML parser turned it into a real line break
 * (and `` `<div>` `` into nothing at all).
 */
function renderHtml(view: EditorView, container: HTMLElement, html: string): void {
  const code: string[] = []
  const masked = html.replace(/`[^`]*`/g, (m) => {
    code.push(m.slice(1, -1))
    return `\ue000${code.length - 1}\ue000`
  })
  /** Emit a text node, restoring the code spans it holds. */
  const emit = (dest: HTMLElement, text: string): void => {
    let last = 0
    let m: RegExpExecArray | null
    const re = new RegExp(CODE_MARK.source, 'g')
    while ((m = re.exec(text))) {
      if (m.index > last) renderMarkdown(view, dest, text.slice(last, m.index))
      const el = document.createElement('code')
      el.className = 'cm-md-code'
      el.textContent = code[Number(m[1])] ?? ''
      dest.appendChild(el)
      last = m.index + m[0].length
    }
    if (last < text.length) renderMarkdown(view, dest, text.slice(last))
  }
  const parsed = new DOMParser().parseFromString(`<body>${masked}</body>`, 'text/html')
  const walk = (src: Node, dest: HTMLElement): void => {
    src.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        emit(dest, node.nodeValue ?? '')
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (HTML_DROP.has(tag)) return
      if (!HTML_TAGS.has(tag)) {
        walk(el, dest) // unknown wrapper: drop the tag, keep the content
        return
      }
      if (tag === 'img') {
        appendImage(view, dest, el.getAttribute('src') ?? '', el.getAttribute('alt') ?? '', el.getAttribute('title') ?? '')
        return
      }
      const out = document.createElement(tag === 'a' ? 'a' : tag)
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        if (!HTML_ATTRS.has(name)) continue
        if (name === 'style') {
          const style = safeStyle(attr.value)
          if (style) out.setAttribute('style', style)
          continue
        }
        if (name === 'href') {
          const url = safeUrl(attr.value)
          if (url) {
            out.setAttribute('data-href', url)
            out.setAttribute('title', `${url}  (Ctrl/⌘+clic pour ouvrir)`)
          }
          continue
        }
        out.setAttribute(name, attr.value)
      }
      if (tag === 'a') out.classList.add('cm-md-link')
      walk(el, out)
      dest.appendChild(out)
    })
  }
  walk(parsed.body, container)
}

/** Render a table cell: raw HTML when it carries tags, inline Markdown
 * otherwise — images, code, math, links, wikilinks and emphasis included.
 * A tag inside inline code does NOT count: `` `<br>` `` is text. */
function renderCell(view: EditorView, container: HTMLElement, text: string): void {
  const outsideCode = text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
  if (HAS_TAG.test(outsideCode)) renderHtml(view, container, text)
  else renderMarkdown(view, container, text)
}

/* ---------- tables ---------- */

/** One table cell: its trimmed text and the absolute document offsets of that
 * text (so a single cell can be rewritten without touching the rest), plus the
 * offsets of the whole segment between the two pipes — an EMPTY cell has no text
 * to replace, so it is filled through the padded range instead. */
interface Cell {
  text: string
  from: number
  to: number
  padFrom: number
  padTo: number
}

/** GFM escapes a literal pipe inside a cell as `\|`. */
const unescapePipes = (s: string): string => s.replace(/\\\|/g, '|')
const escapePipes = (s: string): string => s.replace(/\\\|/g, '|').replace(/\|/g, '\\|')

/** Split one table line into positioned cells. `\|` is an escaped pipe, not a
 * cell boundary; the leading and trailing border pipes are not cells. */
function splitCells(line: string, lineStart: number): Cell[] {
  const cells: Cell[] = []
  let start = 0
  while (start < line.length && /\s/.test(line[start])) start++
  if (line[start] === '|') start++
  let seg = start
  const push = (end: number): void => {
    let a = seg
    let b = end
    while (a < b && /\s/.test(line[a])) a++
    while (b > a && /\s/.test(line[b - 1])) b--
    cells.push({
      text: line.slice(a, b),
      from: lineStart + a,
      to: lineStart + b,
      padFrom: lineStart + seg,
      padTo: lineStart + end
    })
  }
  for (let i = start; i < line.length; i++) {
    if (line[i] === '\\') {
      i++
      continue
    }
    if (line[i] === '|') {
      push(i)
      seg = i + 1
    }
  }
  if (line.slice(seg).trim() !== '') push(line.length) // no trailing border pipe
  return cells
}

/** A table source → rows of positioned cells: [0] header, [1] delimiter,
 * [2…] body. `base` is the table's document offset. */
function parseTableCells(source: string, base: number): Cell[][] {
  const rows: Cell[][] = []
  let off = 0
  for (const line of source.split('\n')) {
    if (line.trim()) rows.push(splitCells(line, base + off))
    off += line.length + 1
  }
  return rows
}

/* ---------- column widths ---------- */
/**
 * GFM has nowhere to put a column width, so MDForge keeps them in an HTML
 * comment on the line just above the table — `<!--[10,60,15,15]-->`, one integer
 * percentage of the text width per column. Every other Markdown renderer ignores
 * a comment, and writing it is a plain text edit like everything else here.
 *
 * The percentages are of the TEXT WIDTH, not of each other: their SUM is the
 * table's own width. `[10,60,15,15]` fills the column; `[10,20,15]` makes a
 * table 45% wide. That is what makes the last column's right border draggable —
 * it moves the table's total width — and it is why a first drag never resizes
 * anything on its own: the widths written down are the ones already on screen.
 */
export const COLUMN_WIDTHS_RE = /^\s*<!--\s*\[\s*(\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*)\s*\]\s*-->\s*$/

export interface ColWidths {
  widths: number[]
  from: number
  to: number
}

/** The widths comment sitting on the line above the table that starts at `tableFrom`. */
export function columnWidthsAbove(state: EditorState, tableFrom: number): ColWidths | null {
  const line = state.doc.lineAt(tableFrom)
  if (line.number === 1) return null
  const prev = state.doc.line(line.number - 1)
  const m = COLUMN_WIDTHS_RE.exec(prev.text)
  if (!m) return null
  const widths = m[1].split(',').map((n) => parseFloat(n))
  if (widths.some((n) => !isFinite(n) || n <= 0)) return null
  return { widths, from: prev.from, to: prev.to }
}

/**
 * Percentages as readable integers: each at least 1, the total never past 100
 * (nothing can be wider than the text column). A total within 2 points of full
 * width snaps to exactly 100 — pulling a table "to the edge" should write the
 * clean `[10,60,15,15]`, not `[10,59,15,15]`.
 */
export function roundWidths(pcts: number[]): number[] {
  const n = pcts.length
  if (n === 0) return []
  const ints = pcts.map((p) => Math.max(1, Math.round(p)))
  const total = (): number => ints.reduce((a, b) => a + b, 0)
  /** The column that can best give or take a point: the widest, or the narrowest. */
  const pick = (giving: boolean): number => {
    let idx = 0
    for (let i = 1; i < n; i++) if (giving ? ints[i] > ints[idx] : ints[i] < ints[idx]) idx = i
    return idx
  }
  while (total() > 100) {
    const idx = pick(true)
    if (ints[idx] <= 1) break
    ints[idx]--
  }
  if (total() >= 98) while (total() < 100) ints[pick(false)]++
  return ints
}

/** Rescale a list to a given total — used when a column is added or removed, so
 * the table keeps the width it had. */
export function scaleWidths(widths: number[], target: number): number[] {
  const sum = widths.reduce((a, b) => a + b, 0)
  if (sum <= 0) return roundWidths(widths.map(() => target / (widths.length || 1)))
  return roundWidths(widths.map((w) => (w / sum) * target))
}

/**
 * Adapt a stored list to the table's real column count — a column may have been
 * added or removed since it was written. Extras go, missing ones take the
 * average, and the result is rescaled to the TOTAL the comment declared: dropping
 * an entry must not shrink the table (a 4-entry comment on a 3-column table used
 * to render it at 75% width). The next resize rewrites the comment properly.
 */
export function fitWidths(widths: number[], cols: number): number[] {
  if (widths.length === cols) return widths
  const total = widths.reduce((a, b) => a + b, 0)
  const avg = total / (widths.length || 1) || 1
  const out = widths.slice(0, cols)
  while (out.length < cols) out.push(avg)
  const sum = out.reduce((a, b) => a + b, 0) || 1
  return out.map((w) => (w / sum) * (total || sum))
}

/**
 * Persist the widths a drag just produced: rewrite the comment above the table,
 * or insert one. `firstLine` is the table's first source line as the widget saw
 * it — if the document moved under us (an outside edit, an undo), write nothing
 * rather than over whatever now sits there.
 */
function writeWidths(view: EditorView, tableFrom: number, firstLine: string, pcts: number[]): void {
  const state = view.state
  if (state.doc.sliceString(tableFrom, tableFrom + firstLine.length) !== firstLine) return
  const insert = `<!--[${roundWidths(pcts).join(',')}]-->`
  const cur = columnWidthsAbove(state, tableFrom)
  if (cur) {
    safeDispatch(view, { changes: { from: cur.from, to: cur.to, insert } })
    return
  }
  // A new comment takes the table's own indentation: written at column 0 above a
  // table nested in a list item, it would close the list and pull the table out
  // of it.
  const line = state.doc.lineAt(tableFrom)
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? ''
  safeDispatch(view, { changes: { from: line.from, insert: `${indent}${insert}\n` } })
}

/* ---------- single-cell editing ---------- */
/**
 * Edit ONE cell without unfolding the whole table: the table stays rendered, the
 * cell is highlighted, and its raw Markdown opens in a field above the table —
 * the same place the full source appears when you edit the table itself. The
 * field is plain DOM (not part of the CM document), so committing it is a text
 * edit on that cell's range alone.
 */
interface CellEdit {
  table: number
  row: number
  col: number
}
let cellEdit: CellEdit | null = null
/** Set when the rebuilt field must take the focus back (Tab between cells). */
let cellEditFocus = false
/** Commit hook of the open field, so clicking another cell's ✎ doesn't lose it. */
let flushCellEdit: (() => void) | null = null
const cellEditEffect = StateEffect.define<CellEdit | null>()

function sameWidths(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return a === b
  return a.length === b.length && a.every((n, i) => n === b[i])
}

function sameCellEdit(a: CellEdit | null, b: CellEdit | null): boolean {
  if (!a || !b) return a === b
  return a.table === b.table && a.row === b.row && a.col === b.col
}

/**
 * Dispatch that survives being called from inside a CodeMirror DOM update.
 * CM re-syncs the focus while updating its DOM, which fires `blur` on a field
 * living in a widget — and dispatching there throws "Calls to EditorView.update
 * are not allowed while an update is in progress", which used to blank the whole
 * editor. Retry once, out of the update.
 */
function safeDispatch(view: EditorView, spec: Parameters<EditorView['dispatch']>[0]): void {
  try {
    view.dispatch(spec)
  } catch {
    window.setTimeout(() => {
      try {
        view.dispatch(spec)
      } catch {
        // give up rather than break the editor
      }
    }, 0)
  }
}

/** Open (or close, with `null`) the cell field. A state effect — the live-preview
 * field must rebuild for the widget to pick the change up. */
function setCellEdit(view: EditorView, edit: CellEdit | null): void {
  cellEdit = edit
  cellEditFocus = edit !== null
  safeDispatch(view, { effects: cellEditEffect.of(edit) })
}

/** Row 1 is the delimiter — never editable, so it is skipped when tabbing. */
function stepCell(rows: Cell[][], edit: CellEdit, dir: number): CellEdit {
  let { row, col } = edit
  for (let guard = 0; guard < 1000; guard++) {
    col += dir
    if (col < 0) {
      row -= 1
      if (row === 1) row = 0
      if (row < 0) return { ...edit }
      col = (rows[row]?.length ?? 1) - 1
    } else if (col >= (rows[row]?.length ?? 0)) {
      row += 1
      if (row === 1) row = 2
      if (row >= rows.length) return { ...edit }
      col = 0
    }
    if (rows[row]?.[col]) return { table: edit.table, row, col }
  }
  return { ...edit }
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly pos: number,
    readonly mode: BlockMode,
    readonly base: number,
    readonly edit: CellEdit | null,
    readonly widths: number[] | null
  ) {
    super()
  }
  eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.mode === this.mode &&
      other.base === this.base &&
      sameCellEdit(other.edit, this.edit) &&
      sameWidths(other.widths, this.widths)
    )
  }
  get estimatedHeight(): number {
    return this.source.split('\n').filter((l) => l.trim()).length * 34 + (this.edit ? 40 : 0)
  }

  /** The field above the table: label, the cell's raw Markdown, ✓ / ✕. */
  private cellEditor(view: EditorView, rows: Cell[][]): HTMLElement {
    const edit = this.edit as CellEdit
    const cell = rows[edit.row]?.[edit.col]
    const original = cell ? cell.text : ''
    const bar = document.createElement('div')
    bar.className = 'cm-td-editor'

    const label = document.createElement('span')
    label.className = 'cm-td-editor-label'
    label.textContent = `${edit.row === 0 ? 'En-tête' : `Ligne ${edit.row - 1}`} · Colonne ${edit.col + 1}`
    bar.appendChild(label)

    const input = document.createElement('input')
    input.className = 'cm-td-editor-input'
    input.spellcheck = true
    input.value = unescapePipes(original)
    input.placeholder = 'Contenu de la cellule (Markdown, HTML, image…)'
    bar.appendChild(input)

    let done = false
    /** True once CodeMirror threw this field's DOM away (widget re-created). */
    let torn = false
    ;(bar as HTMLElement & { _torn?: () => void })._torn = () => {
      torn = true
    }
    /** `undefined` keeps the field open on the same cell, `null` closes it. */
    const commit = (next: CellEdit | null | undefined): void => {
      if (done) return
      done = true
      flushCellEdit = null
      const target = next === undefined ? cellEdit : next
      cellEdit = target
      cellEditFocus = target !== null
      const value = escapePipes(input.value.replace(/[\r\n]+/g, ' ')).trim()
      // Bail out on stale offsets (the document moved under us) rather than
      // writing over whatever now sits at that range.
      const stale = !cell || view.state.doc.sliceString(cell.padFrom, cell.padTo).trim() !== original
      if (!stale && value !== original) {
        // An empty cell has a zero-width text range: fill it through the padded
        // range so the result reads `| value |`, not `|  value|`.
        const range = original === '' ? { from: cell.padFrom, to: cell.padTo } : { from: cell.from, to: cell.to }
        safeDispatch(view, {
          changes: { ...range, insert: original === '' ? ` ${value} ` : value },
          effects: cellEditEffect.of(target)
        })
      } else {
        safeDispatch(view, { effects: cellEditEffect.of(target) })
      }
    }
    flushCellEdit = () => commit(undefined)

    const btn = (text: string, tip: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'cm-td-editor-btn'
      b.textContent = text
      b.title = tip
      // Keep the focus in the field: no blur, so the click below is the only
      // path that runs (a blur-then-click would commit twice).
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        run()
      })
      return b
    }
    bar.appendChild(btn('✓', 'Valider (Entrée)', () => commit(null)))
    bar.appendChild(
      btn('✕', 'Annuler (Échap)', () => {
        done = true
        flushCellEdit = null
        setCellEdit(view, null)
      })
    )

    input.addEventListener('mousedown', (e) => e.stopPropagation())
    // A blur here is not always the user leaving the field: CodeMirror re-syncs
    // the focus while updating its DOM (a click elsewhere, a viewport
    // re-render…), so this can fire from INSIDE an update. Never dispatch
    // synchronously from it — and when the field was merely re-created under us
    // with nothing typed, put the focus back instead of closing it.
    input.addEventListener('blur', () => {
      const typed = escapePipes(input.value.replace(/[\r\n]+/g, ' ')).trim() !== original
      window.setTimeout(() => {
        if (torn && !typed) {
          const fresh = document.querySelector('.cm-td-editor-input') as HTMLInputElement | null
          if (fresh && fresh !== input) fresh.focus()
          return
        }
        commit(null)
      }, 0)
    })
    input.addEventListener('keydown', (e) => {
      e.stopPropagation() // the editor's own keymap must not see this typing
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        done = true
        flushCellEdit = null
        setCellEdit(view, null)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        commit(stepCell(rows, edit, e.shiftKey ? -1 : 1))
      }
    })
    // The widget was just rebuilt (opened, or tabbed to the next cell) — take
    // the focus back after the DOM lands.
    if (cellEditFocus) {
      cellEditFocus = false
      requestAnimationFrame(() => {
        input.focus()
        input.setSelectionRange(input.value.length, input.value.length)
      })
    }
    return bar
  }

  /**
   * A grip on every column border of the header row. An INNER border moves that
   * one border: the pair keeps its combined width, so no other column shifts and
   * the table's total width is unchanged. The LAST border is the table's own
   * right edge: it scales every column at once, so the table gets narrower or
   * wider without touching the shares — which is why a table need not fill the
   * text width.
   *
   * Releasing the button writes the percentages into the comment above the
   * table; during the drag nothing is dispatched, since a document change would
   * rebuild this widget and drop the drag with it.
   */
  private addGrips(
    view: EditorView,
    table: HTMLTableElement,
    htr: HTMLTableRowElement,
    colEls: HTMLTableColElement[],
    applyWidths: (pcts: number[]) => void
  ): void {
    const firstLine = this.source.split('\n', 1)[0]
    const tableFrom = this.base
    const ths = Array.from(htr.children) as HTMLElement[]
    if (ths.length === 0) return
    const MIN = 32 // px: a column must stay wide enough to grab again

    const start = (e: MouseEvent, i: number): void => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      // Percentages are of the TEXT width, so that is what everything is
      // measured against — measuring against the table's own width would make a
      // half-width table read as 100% and jump to the full width on first drag.
      const box = (table.parentElement as HTMLElement | null)?.clientWidth || table.getBoundingClientRect().width
      if (box <= 0) return
      const x0 = e.clientX
      const lastBorder = i === ths.length - 1
      const grip = e.currentTarget as HTMLElement
      // Nothing happens until the pointer actually travels: a plain click on a
      // grip must not write a widths comment into a table that had none.
      let w0: number[] | null = null
      let total0 = 0
      let pcts: number[] | null = null

      /** Freeze what is on screen, then measure it — the drag deltas apply to the
       * borders the user sees. The cell widths are scaled onto the TABLE's width
       * rather than just summed: with collapsed borders their total falls a couple
       * of pixels short, and the table would shrink on the first pixel. */
      const begin = (): void => {
        const cells = ths.map((th) => th.getBoundingClientRect().width)
        const spread = table.getBoundingClientRect().width / (cells.reduce((a, b) => a + b, 0) || 1)
        applyWidths(cells.map((w) => ((w * spread) / box) * 100))
        w0 = ths.map((th) => th.getBoundingClientRect().width)
        total0 = w0.reduce((a, b) => a + b, 0)
        grip.classList.add('cm-col-grip-active')
        document.body.classList.add('cm-col-resizing')
      }

      const onMove = (ev: MouseEvent): void => {
        // The button was released outside the window: the mouseup never came.
        if (ev.buttons === 0) {
          onUp()
          return
        }
        if (!w0) {
          if (Math.abs(ev.clientX - x0) < 2) return
          begin()
        }
        const frozen = w0 as number[]
        let w = frozen.slice()
        if (lastBorder) {
          // The table's own edge: every column scales, so the table changes width
          // while the shares it was given stay exactly as they are. Stops when the
          // narrowest column reaches MIN, or when the table fills the text width.
          const fMin = Math.min(1, MIN / Math.min(...frozen))
          const fMax = Math.max(1, box / total0)
          const f = Math.min(Math.max((total0 + (ev.clientX - x0)) / total0, fMin), fMax)
          w = frozen.map((x) => x * f)
        } else {
          // Both bounds are clamped against 0 so a column already under MIN (a
          // hand-written comment, a narrower window) can only be recovered, never
          // made worse: the move is allowed in the direction that helps, and
          // refused in the other.
          const lo = Math.min(0, MIN - frozen[i])
          const hi = Math.max(0, frozen[i + 1] - MIN)
          const d = Math.min(Math.max(ev.clientX - x0, lo), hi)
          w[i] += d
          w[i + 1] -= d
        }
        pcts = w.map((x) => (x / box) * 100)
        applyWidths(pcts)
      }
      function onUp(): void {
        document.removeEventListener('mousemove', onMove, true)
        document.removeEventListener('mouseup', onUp, true)
        window.removeEventListener('blur', onUp)
        document.body.classList.remove('cm-col-resizing')
        grip.classList.remove('cm-col-grip-active')
        if (pcts) writeWidths(view, tableFrom, firstLine, pcts)
      }
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onUp, true)
      // A lost mouseup (released outside the window, an alert stealing the focus)
      // would otherwise leave `user-select: none` on the body and a live listener.
      window.addEventListener('blur', onUp)
    }

    ths.forEach((th, i) => {
      if (!colEls[i]) return
      const grip = document.createElement('div')
      grip.className = i === ths.length - 1 ? 'cm-col-grip cm-col-grip-last' : 'cm-col-grip'
      grip.title = i === ths.length - 1 ? 'Largeur du tableau (glisser)' : 'Redimensionner la colonne (glisser)'
      grip.addEventListener('mousedown', (ev) => start(ev, i))
      // A double-click here would open the cell editor behind the grip.
      grip.addEventListener('dblclick', (ev) => ev.stopPropagation())
      th.appendChild(grip)
    })
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = this.mode === 'preview' ? 'cm-md-table-wrap cm-block-preview' : 'cm-md-table-wrap'
    if (this.mode === 'render') addEditButton(wrap, view, this.pos, 'Éditer la source du tableau')
    else addCloseButton(wrap, view)
    const rows = parseTableCells(this.source, this.base)
    if (rows.length < 2) {
      wrap.textContent = this.source
      return wrap
    }
    if (this.edit) wrap.appendChild(this.cellEditor(view, rows))
    const aligns = rows[1].map((c) => {
      const l = c.text.startsWith(':')
      const r = c.text.endsWith(':')
      return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
    })
    const table = document.createElement('table')
    table.className = 'cm-md-table'

    // Column widths ride in a `colgroup` (percentages + `table-layout: fixed`),
    // so a resize is one style write per column and never touches the cells.
    const colgroup = document.createElement('colgroup')
    const colEls = rows[0].map(() => {
      const col = document.createElement('col')
      colgroup.appendChild(col)
      return col
    })
    table.appendChild(colgroup)
    const applyWidths = (pcts: number[]): void => {
      const sum = pcts.reduce((a, b) => a + b, 0)
      if (sum <= 0) return
      table.classList.add('cm-md-table-fixed')
      // The sum is the table's share of the text width; each column's `col` gets
      // its share OF THE TABLE. A sum past 100 (a stale comment, a column added)
      // is clamped here rather than rewritten behind the user's back.
      table.style.width = `${Math.min(100, Math.max(4, sum))}%`
      pcts.forEach((p, i) => {
        if (colEls[i]) colEls[i].style.width = `${(p / sum) * 100}%`
      })
    }
    if (this.widths) applyWidths(fitWidths(this.widths, colEls.length))

    /** Build one cell: rendered content, alignment, and — in render mode — the
     * per-cell ✎ that opens the field above the table. */
    const fill = (el: HTMLTableCellElement, cell: Cell, row: number, col: number): void => {
      renderCell(view, el, unescapePipes(cell.text))
      if (aligns[col]) el.style.textAlign = aligns[col]
      if (!cell.text) el.classList.add('cm-td-empty')
      if (this.mode !== 'render') return
      if (this.edit && this.edit.row === row && this.edit.col === col) el.classList.add('cm-td-editing')
      const open = (): void => {
        flushCellEdit?.()
        setCellEdit(view, { table: this.base, row, col })
      }
      const pen = document.createElement('button')
      pen.className = 'cm-td-edit'
      pen.textContent = '✎'
      pen.title = 'Éditer cette cellule (double-clic)'
      pen.addEventListener('mousedown', (e) => e.preventDefault())
      pen.addEventListener('click', (e) => {
        e.stopPropagation()
        open()
      })
      el.appendChild(pen)
      el.addEventListener('dblclick', (e) => {
        e.preventDefault()
        e.stopPropagation()
        open()
      })
    }

    const thead = document.createElement('thead')
    const htr = document.createElement('tr')
    rows[0].forEach((cell, i) => {
      const th = document.createElement('th')
      fill(th, cell, 0, i)
      htr.appendChild(th)
    })
    thead.appendChild(htr)
    table.appendChild(thead)
    if (this.mode === 'render') this.addGrips(view, table, htr, colEls, applyWidths)
    const tbody = document.createElement('tbody')
    for (let i = 2; i < rows.length; i++) {
      const tr = document.createElement('tr')
      rows[i].forEach((cell, j) => {
        const td = document.createElement('td')
        fill(td, cell, i, j)
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    return wrap
  }
  destroy(dom: HTMLElement): void {
    flushCellEdit = null
    // Tell the open field its DOM is gone, so the blur that follows is read as a
    // teardown and not as the user leaving the field.
    const bar = dom.querySelector?.('.cm-td-editor') as (HTMLElement & { _torn?: () => void }) | null
    bar?._torn?.()
  }
  ignoreEvent(): boolean {
    return true
  }
}

const ALERT_LABELS: Record<string, string> = {
  note: 'ⓘ Note',
  tip: '💡 Tip',
  important: '❗ Important',
  warning: '⚠ Warning',
  caution: '🛑 Caution'
}
const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const

/**
 * Dropdown shown at the start of a blockquote's first line (Milkdown-style): it
 * reflects the current alert type and lets you change it, promote a plain quote,
 * or downgrade back to a plain quote — all as plain text edits.
 */
class AlertSelectWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly lineFrom: number
  ) {
    super()
  }
  eq(other: AlertSelectWidget): boolean {
    return other.kind === this.kind && other.lineFrom === this.lineFrom
  }
  toDOM(view: EditorView): HTMLElement {
    const sel = document.createElement('select')
    sel.className = 'cm-alert-select ' + (this.kind ? `cm-alert-select-${this.kind}` : 'cm-alert-select-none')
    const mk = (value: string, text: string): void => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      sel.appendChild(o)
    }
    mk('', '— Citation (aucune alerte)')
    for (const t of ALERT_TYPES) mk(t, ALERT_LABELS[t])
    sel.value = this.kind
    sel.addEventListener('mousedown', (e) => e.stopPropagation())
    sel.addEventListener('change', () => this.apply(view, sel.value))
    return sel
  }
  private apply(view: EditorView, type: string): void {
    const doc = view.state.doc
    const line = doc.lineAt(this.lineFrom)
    const text = line.text
    const isAlert = /^\s*>\s*\\?\[!(note|tip|important|warning|caution)\]\s*$/i.test(text)
    const prefixM = /^(\s*>\s?)/.exec(text)
    const prefix = prefixM ? prefixM[1] : '> '
    if (type) {
      if (isAlert) {
        const markerStart = line.from + /^(\s*>\s*)/.exec(text)![1].length
        view.dispatch({ changes: { from: markerStart, to: line.to, insert: `[!${type.toUpperCase()}]` } })
      } else {
        const at = line.from + prefix.length
        view.dispatch({ changes: { from: at, insert: `[!${type.toUpperCase()}]\n${prefix}` } })
      }
    } else if (isAlert) {
      // Downgrade to a plain quote: drop the marker-only first line entirely.
      view.dispatch({ changes: { from: line.from, to: Math.min(line.to + 1, doc.length) } })
    }
    view.focus()
  }
}

/**
 * YAML frontmatter rendered as a discreet card (Milkdown-style): the `title:`
 * field shows as an H1, the other keys as small chips. `✎` reveals the raw YAML
 * (with a live editable block + `✓ Terminer` to leave). Replaces the whole
 * fenced block so the `---` fences don't sit as visible noise when not editing.
 */
/* ---------- frontmatter ---------- */

/**
 * One `key: value` entry of the frontmatter, with the document range to rewrite
 * when it is edited. Only the shapes people actually write are modelled — a
 * scalar, a flow list `[a, b]`, a comma list `a, b` and an indented `- item`
 * block. Anything else (nested map, `|`/`>` block scalar) is marked `complex`
 * and is not editable field by field: clicking it opens the raw YAML instead,
 * which is honest rather than half-parsing someone's file.
 */
type FmStyle = 'scalar' | 'flow' | 'comma' | 'block' | 'complex'
interface FmEntry {
  key: string
  style: FmStyle
  list: boolean
  /** Values of a list entry (empty for a scalar). */
  items: string[]
  /** Text of a scalar entry. */
  scalar: string
  /** Range of the VALUE (from just after the colon to the end of the entry). */
  from: number
  to: number
}

/** Keys whose value is a set of words, even written as `a, b` on one line. */
const MULTI_KEYS = new Set(['tags', 'keywords', 'categories', 'aliases'])
/** Keys the known-tags list is offered for. */
const TAG_KEYS = new Set(['tags', 'keywords'])

const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '').trim()

function parseFrontmatter(raw: string, base: number): FmEntry[] {
  const lines = raw.split('\n')
  const offsets: number[] = []
  let off = 0
  for (const line of lines) {
    offsets.push(off)
    off += line.length + 1
  }
  const out: FmEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_.-]+)(\s*):(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    const rest = m[3]
    // The range starts right after the colon and INCLUDES the space that follows:
    // `serializeEntry` writes its own, and skipping it made them pile up. The
    // colon is located, not assumed: `tags : a` is legal YAML, and taking
    // `key.length + 1` deleted the colon itself.
    const from = base + offsets[i] + m[1].length + m[2].length + 1
    let to = base + offsets[i] + lines[i].length
    const inline = rest.trim()
    const multi = MULTI_KEYS.has(key.toLowerCase())

    if (inline) {
      if (/^[|>]/.test(inline)) {
        out.push({ key, style: 'complex', list: false, items: [], scalar: inline, from, to })
        continue
      }
      const flow = /^\[(.*)\]$/.exec(inline)
      if (flow) {
        const items = flow[1].split(',').map(unquote).filter(Boolean)
        out.push({ key, style: 'flow', list: true, items, scalar: inline, from, to })
      } else if (multi) {
        const items = inline.split(',').map(unquote).filter(Boolean)
        out.push({ key, style: 'comma', list: true, items, scalar: inline, from, to })
      } else {
        out.push({ key, style: 'scalar', list: false, items: [], scalar: unquote(inline), from, to })
      }
      continue
    }

    // Nothing after the colon: an indented `- item` block, a nested map, or empty.
    const items: string[] = []
    let n = i + 1
    for (; n < lines.length; n++) {
      const item = /^\s+-\s*(.*)$/.exec(lines[n])
      if (!item) break
      items.push(unquote(item[1]))
      to = base + offsets[n] + lines[n].length
    }
    if (items.length) {
      out.push({ key, style: 'block', list: true, items: items.filter(Boolean), scalar: '', from, to })
      i = n - 1
      continue
    }
    const nested = n < lines.length && /^\s+\S/.test(lines[n])
    out.push({
      key,
      style: nested ? 'complex' : multi ? 'flow' : 'scalar',
      list: !nested && multi,
      items: [],
      scalar: '',
      from,
      to
    })
  }
  return out
}

/** What a chip shows: the value as one readable line. */
function entryText(entry: FmEntry): string {
  return entry.list ? entry.items.join(', ') : entry.scalar
}

/** The replacement text for an entry's value range, in its own style. */
function serializeEntry(entry: FmEntry, items: string[], scalar: string): string {
  if (!entry.list) return scalar.trim() ? ` ${scalar.trim()}` : ''
  const clean = items.map((t) => t.trim()).filter(Boolean)
  if (entry.style === 'block') return clean.length ? clean.map((t) => `\n  - ${t}`).join('') : ' []'
  if (entry.style === 'comma') return clean.length ? ` ${clean.join(', ')}` : ''
  return ` [${clean.join(', ')}]`
}

/* ---------- known tags & keys (from the host's workspace sweep) ---------- */
/**
 * Frontmatter properties worth one click, from the PKM / Obsidian conventions.
 * `@today` becomes the local ISO date at insertion time; `[]` opens the value as
 * a list (so the tag-style chip editor takes over).
 */
interface KnownKey {
  key: string
  hint: string
  value: string
}
const KNOWN_KEYS: KnownKey[] = [
  { key: 'created', hint: 'Date de création (ISO)', value: '@today' },
  { key: 'updated', hint: 'Date de dernière révision (ISO)', value: '@today' },
  { key: 'due', hint: 'Échéance (ISO)', value: '@today' },
  { key: 'title', hint: 'Titre affiché en tête de la carte', value: '' },
  { key: 'description', hint: 'Résumé en une ligne', value: '' },
  { key: 'tags', hint: 'Mots-clés — complétés sur le dossier', value: '[]' },
  { key: 'aliases', hint: 'Autres noms de la note (Obsidian)', value: '[]' },
  { key: 'type', hint: 'Nature de la note : projet, réunion, personne…', value: '' },
  { key: 'status', hint: 'État : brouillon, en cours, terminé', value: '' },
  { key: 'project', hint: 'Projet rattaché', value: '' },
  { key: 'up', hint: 'Note parente — carte de contenu (MOC)', value: '' },
  { key: 'related', hint: 'Notes liées', value: '[]' },
  { key: 'source', hint: 'Provenance : URL ou référence', value: '' },
  { key: 'author', hint: 'Auteur', value: '' },
  { key: 'cssclasses', hint: 'Classes CSS de la note (Obsidian)', value: '[]' },
  { key: 'publish', hint: 'Publier la note (Obsidian Publish)', value: 'false' },
  { key: 'permalink', hint: 'URL stable pour la publication', value: '' }
]

let knownTags: string[] = []
/** Frontmatter keys already used in the workspace (same sweep as the tags). */
let knownKeys: string[] = []
/** Bumped when the list changes: it is part of the card's widget identity, so
 * `eq()` lets CodeMirror rebuild the DOM instead of keeping a stale one. */
let tagsGen = 0
let tagsScannedAt = 0
let tagsFiles = 0
let tagsTruncated = false
let requestTags: (refresh: boolean) => void = () => {}

/** Wired by main.ts: asks the host for the workspace's tags (once, or fresh). */
export function setTagsRequester(fn: (refresh: boolean) => void): void {
  requestTags = fn
}
/** The host answered with the workspace's known tags. */
export function setTagIndex(index: {
  tags: string[]
  keys: string[]
  scannedAt: number
  files: number
  truncated: boolean
}): void {
  knownTags = index.tags
  knownKeys = index.keys
  tagsScannedAt = index.scannedAt
  tagsFiles = index.files
  tagsTruncated = index.truncated
  tagsGen++
}
/** Close every in-place editor (frontmatter property, table cell) — called when
 * the host swaps the whole document, since they all point into the old text. */
export function resetInlineEditors(): void {
  fmEdit = null
  fmAdding = false
  cellEdit = null
  cellEditFocus = false
  flushCellEdit = null
  document.querySelectorAll('.cm-suggest-menu').forEach((n) => n.remove())
}

/** Repaint the open frontmatter editor once the list arrives. */
export function refreshTags(view: EditorView): void {
  if (fmEdit || fmAdding) view.dispatch({ effects: fmEditEffect.of(fmEdit) })
}

/* ---------- one-entry frontmatter editing ---------- */
/**
 * Editing ONE property without unfolding the whole block: the card stays, the
 * chip is highlighted, and the value opens in a field just below it — a plain
 * text input for a scalar, a chip editor with tag completion for a list. Same
 * shape (and the same reasons) as the single table cell editor above.
 */
let fmEdit: string | null = null
let fmEditFocus = false
/** True while the "+ propriété" combobox is open in the card. */
let fmAdding = false
const fmEditEffect = StateEffect.define<string | null>()

function setFmEdit(view: EditorView, key: string | null): void {
  fmEdit = key
  fmEditFocus = key !== null
  fmAdding = false
  safeDispatch(view, { effects: fmEditEffect.of(key) })
}

function setFmAdding(view: EditorView, on: boolean): void {
  fmAdding = on
  if (on) {
    fmEdit = null
    // The list is only swept on demand — this is one of the two demands.
    if (!tagsScannedAt) requestTags(false)
  }
  safeDispatch(view, { effects: fmEditEffect.of(fmEdit) })
}

/** One row of a suggestion dropdown: the value, plus what it is for. */
interface SuggestItem {
  value: string
  hint?: string
}
/** An input whose dropdown (on document.body) is removed with it. */
type InputWithMenu = HTMLInputElement & { _menu?: HTMLElement }

/** Open a dropdown on `input` and tie its lifetime to that input. */
function suggest(input: HTMLInputElement, items: () => SuggestItem[], pick: (value: string) => void): void {
  ;(input as InputWithMenu)._menu = attachSuggestions(input, items, pick)
}

/** A filtered dropdown under `input`, same idea as the code-language picker. */
function attachSuggestions(
  input: HTMLInputElement,
  items: () => SuggestItem[],
  pick: (value: string) => void
): HTMLElement {
  // The menu lives on document.body (it must escape the card's overflow), so it
  // outlives the widget that opened it. Only one is ever useful at a time, and a
  // leftover one answers with a stale list — clear them on the way in, and again
  // when the card is destroyed.
  document.querySelectorAll('.cm-suggest-menu').forEach((n) => n.remove())
  const menu = document.createElement('div')
  menu.className = 'cm-suggest-menu'
  menu.style.display = 'none'
  document.body.appendChild(menu)
  let filtered: SuggestItem[] = []
  let active = 0
  /** True once the user moved into the list: only then does Enter pick from it —
   * otherwise Enter belongs to the text that was typed (both handlers sit on the
   * same input, and two tags used to be added at once). */
  let navigated = false

  const hide = (): void => {
    menu.style.display = 'none'
  }
  const render = (): void => {
    const q = input.value.trim().toLowerCase()
    filtered = items()
      .filter((n) => n.value.toLowerCase().includes(q) || (n.hint ?? '').toLowerCase().includes(q))
      .slice(0, 200)
    if (active >= filtered.length) active = 0
    if (!filtered.length) {
      hide()
      return
    }
    menu.replaceChildren()
    filtered.forEach((n, i) => {
      const row = document.createElement('div')
      row.className = 'cm-suggest-item' + (i === active ? ' cm-active' : '')
      const value = document.createElement('span')
      value.className = 'cm-suggest-value'
      value.textContent = n.value
      row.appendChild(value)
      if (n.hint) {
        const hint = document.createElement('span')
        hint.className = 'cm-suggest-hint'
        hint.textContent = n.hint
        row.appendChild(hint)
      }
      row.addEventListener('mousedown', (e) => {
        e.preventDefault() // keep the focus in the input
        pick(n.value)
      })
      menu.appendChild(row)
    })
    const r = input.getBoundingClientRect()
    menu.style.top = `${r.bottom + window.scrollY + 2}px`
    menu.style.left = `${r.left + window.scrollX}px`
    menu.style.minWidth = `${Math.max(r.width, 140)}px`
    menu.style.display = 'block'
    ;(menu.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('focus', () => {
    active = 0
    navigated = false
    render()
  })
  input.addEventListener('input', () => {
    active = 0
    navigated = false
    render()
  })
  input.addEventListener('blur', () => window.setTimeout(hide, 150))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && filtered.length) {
      e.preventDefault()
      navigated = true
      active = (active + 1) % filtered.length
      render()
    } else if (e.key === 'ArrowUp' && filtered.length) {
      e.preventDefault()
      navigated = true
      active = (active - 1 + filtered.length) % filtered.length
      render()
    } else if (e.key === 'Enter' && navigated && menu.style.display !== 'none' && filtered[active]) {
      e.preventDefault()
      e.stopImmediatePropagation() // the typed text must not be added as well
      pick(filtered[active].value)
    } else if (e.key === 'Escape' && menu.style.display !== 'none') {
      e.stopPropagation() // close the menu, not the editor
      e.preventDefault()
      hide()
    }
  })
  return menu
}

class FrontmatterWidget extends WidgetType {
  /** Snapshot of the known-tags generation at build time (see `tagsGen`). */
  readonly gen = tagsGen
  /** Snapshot of the "+ propriété" state (same reason as `gen`). */
  readonly adding = fmAdding
  constructor(
    readonly raw: string,
    readonly pos: number,
    readonly edit: string | null
  ) {
    super()
  }
  eq(other: FrontmatterWidget): boolean {
    return (
      other.raw === this.raw &&
      other.edit === this.edit &&
      other.gen === this.gen &&
      other.adding === this.adding
    )
  }
  get estimatedHeight(): number {
    return this.edit ? 120 : 70
  }

  /** The field below the chips: a text input, or the tag chip editor. */
  private editor(view: EditorView, entry: FmEntry): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-fm-editor'
    const label = document.createElement('span')
    label.className = 'cm-fm-editor-key'
    label.textContent = entry.key
    box.appendChild(label)

    const write = (items: string[], scalar: string, close: boolean): void => {
      const insert = serializeEntry(entry, items, scalar)
      const current = view.state.doc.sliceString(entry.from, entry.to)
      const target = close ? null : fmEdit
      fmEdit = target
      fmEditFocus = !close
      if (insert !== current) {
        safeDispatch(view, {
          changes: { from: entry.from, to: entry.to, insert },
          effects: fmEditEffect.of(target)
        })
      } else {
        safeDispatch(view, { effects: fmEditEffect.of(target) })
      }
    }

    const btn = (text: string, tip: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'cm-fm-editor-btn'
      b.textContent = text
      b.setAttribute('data-tip', tip)
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        run()
      })
      return b
    }

    if (!entry.list) {
      // Scalar: type the value, Enter validates, Escape leaves it alone.
      const input = document.createElement('input')
      input.className = 'cm-fm-editor-input'
      input.value = entry.scalar
      input.placeholder = `Valeur de « ${entry.key} »`
      let done = false
      const commit = (): void => {
        if (done) return
        done = true
        write([], input.value, true)
      }
      input.addEventListener('mousedown', (e) => e.stopPropagation())
      input.addEventListener('blur', () =>
        window.setTimeout(() => {
          // A rebuilt card (the tag list arriving, an edit elsewhere) blurs this
          // input by throwing its DOM away — that is not the user leaving.
          if (!input.isConnected && input.value === entry.scalar) return
          commit()
        }, 0)
      )
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done = true
          setFmEdit(view, null)
        }
      })
      box.appendChild(input)
      box.appendChild(btn('✓', 'Valider (Entrée)', commit))
      box.appendChild(
        btn('✕', 'Annuler (Échap)', () => {
          done = true
          setFmEdit(view, null)
        })
      )
      if (fmEditFocus) {
        fmEditFocus = false
        requestAnimationFrame(() => {
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
        })
      }
      return box
    }

    // List: one chip per value with a `×`, plus an input that completes on the
    // tags already used in the workspace.
    const tags = document.createElement('div')
    tags.className = 'cm-fm-tags'
    entry.items.forEach((item, i) => {
      const chip = document.createElement('span')
      chip.className = 'cm-fm-tag'
      chip.textContent = item
      const del = document.createElement('button')
      del.className = 'cm-fm-tag-del'
      del.textContent = '×'
      del.setAttribute('data-tip', `Retirer « ${item} »`)
      del.addEventListener('mousedown', (e) => e.preventDefault())
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        write(
          entry.items.filter((_, j) => j !== i),
          '',
          false
        )
      })
      chip.appendChild(del)
      tags.appendChild(chip)
    })
    const input = document.createElement('input')
    input.className = 'cm-fm-editor-input cm-fm-tag-input'
    input.placeholder = entry.items.length ? '+ ajouter' : 'premier tag…'
    const add = (value: string): void => {
      const clean = value.trim().replace(/,+$/, '').trim()
      if (!clean || entry.items.includes(clean)) {
        input.value = ''
        return
      }
      write([...entry.items, clean], '', false)
    }
    const offered = TAG_KEYS.has(entry.key.toLowerCase())
    if (offered) {
      suggest(input, () => knownTags.filter((t) => !entry.items.includes(t)).map((value) => ({ value })), add)
    }
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault()
        add(input.value)
      } else if (e.key === 'Backspace' && !input.value && entry.items.length) {
        e.preventDefault()
        write(entry.items.slice(0, -1), '', false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setFmEdit(view, null)
      }
    })
    tags.appendChild(input)
    box.appendChild(tags)
    box.appendChild(btn('✓', 'Terminer', () => setFmEdit(view, null)))

    if (offered) {
      // Where the completions come from, and how to refresh them. The sweep is
      // one-shot on purpose: no watcher, no permanent indexing.
      const info = document.createElement('div')
      info.className = 'cm-fm-info'
      const text = document.createElement('span')
      text.textContent = tagsScannedAt
        ? `${knownTags.length} tags connus · ${tagsFiles} fichiers · ${new Date(tagsScannedAt).toLocaleString()}${tagsTruncated ? ' · liste tronquée' : ''}`
        : 'Analyse des tags du dossier…'
      info.appendChild(text)
      const again = document.createElement('button')
      again.className = 'cm-fm-editor-btn'
      again.textContent = '↻'
      again.setAttribute('data-tip', 'Réanalyser les tags du dossier ouvert')
      again.addEventListener('mousedown', (e) => e.preventDefault())
      again.addEventListener('click', (e) => {
        e.stopPropagation()
        requestTags(true)
      })
      info.appendChild(again)
      box.appendChild(info)
      // Ask once (the host sweeps on the first request, then answers from cache).
      if (!tagsScannedAt) requestTags(false)
    }

    if (fmEditFocus) {
      fmEditFocus = false
      requestAnimationFrame(() => input.focus())
    }
    return box
  }

  /**
   * Add a property: the curated PKM list first, then the keys this workspace
   * already uses, and any name can simply be typed. The new line goes at the end
   * of the YAML and its editor opens straight away, so the value can be typed
   * without a second click.
   */
  private addProperty(view: EditorView, used: Set<string>): HTMLElement {
    const input = document.createElement('input')
    input.className = 'cm-fm-editor-input cm-fm-add-input'
    input.placeholder = 'nom de la propriété…'
    const today = new Date()
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const insert = (key: string): void => {
      const name = key.trim().replace(/[:\s]+$/, '')
      if (!name || used.has(name.toLowerCase())) {
        setFmAdding(view, false)
        return
      }
      const known = KNOWN_KEYS.find((k) => k.key === name)
      const value = (known?.value ?? '').replace('@today', iso)
      const line = `${name}:${value ? ` ${value}` : ''}`
      // Empty frontmatter: `pos` is the closing `---`, so the line goes before it.
      const at = this.pos + this.raw.length
      const text = this.raw.length ? `\n${line}` : `${line}\n`
      fmAdding = false
      fmEdit = name
      fmEditFocus = true
      safeDispatch(view, {
        changes: { from: at, insert: text },
        effects: fmEditEffect.of(name)
      })
    }

    suggest(
      input,
      () => {
        const curated = KNOWN_KEYS.filter((k) => !used.has(k.key.toLowerCase())).map((k) => ({
          value: k.key,
          hint: k.hint
        }))
        const seen = new Set(curated.map((c) => c.value.toLowerCase()))
        const vault = knownKeys
          .filter((k) => !used.has(k.toLowerCase()) && !seen.has(k.toLowerCase()))
          .map((value) => ({ value, hint: 'déjà utilisée dans le dossier' }))
        return [...curated, ...vault]
      },
      insert
    )
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        insert(input.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setFmAdding(view, false)
      }
    })
    input.addEventListener('blur', () => {
      // Leave on a click elsewhere — but a blur can also come from the card being
      // rebuilt under us (the key list arriving), and that must not close it.
      window.setTimeout(() => {
        if (fmAdding && input.isConnected) setFmAdding(view, false)
      }, 180)
    })
    requestAnimationFrame(() => input.focus())
    return input
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-frontmatter-card'
    const entries = parseFrontmatter(this.raw, this.pos)
    const title = entries.find((e) => e.key.toLowerCase() === 'title')
    if (title && entryText(title)) {
      const h = document.createElement('div')
      h.className = 'cm-fm-title'
      h.textContent = entryText(title)
      wrap.appendChild(h)
    }
    const bar = document.createElement('div')
    bar.className = 'cm-fm-props'
    const gear = document.createElement('span')
    gear.className = 'cm-fm-gear'
    gear.textContent = '⚙'
    bar.appendChild(gear)
    const rest = entries.filter((e) => e.key.toLowerCase() !== 'title')
    if (rest.length) {
      for (const entry of rest) {
        const value = entryText(entry)
        const chip = document.createElement('span')
        chip.className = 'cm-fm-chip'
        if (entry.style === 'complex') chip.classList.add('cm-fm-chip-raw')
        if (this.edit === entry.key) chip.classList.add('cm-fm-chip-editing')
        chip.textContent = value ? `${entry.key}: ${value}` : entry.key
        chip.setAttribute(
          'data-tip',
          entry.style === 'complex'
            ? `« ${entry.key} » est une valeur YAML structurée : cliquer ouvre la source`
            : entry.list
              ? `Modifier les valeurs de « ${entry.key} »`
              : `Modifier « ${entry.key} »`
        )
        chip.addEventListener('mousedown', (e) => e.preventDefault())
        chip.addEventListener('click', (e) => {
          e.stopPropagation()
          // A shape we do not model: hand the whole YAML over rather than guess.
          if (entry.style === 'complex') enterEdit(view, entry.from)
          else setFmEdit(view, this.edit === entry.key ? null : entry.key)
        })
        bar.appendChild(chip)
      }
    } else {
      const empty = document.createElement('span')
      empty.className = 'cm-fm-empty'
      empty.textContent = title ? 'Propriétés' : 'Frontmatter'
      bar.appendChild(empty)
    }
    // `+` at the end of the row: the properties already there are excluded from
    // the list, so it never offers a duplicate key.
    const used = new Set(entries.map((e) => e.key.toLowerCase()))
    if (this.adding) {
      bar.appendChild(this.addProperty(view, used))
    } else {
      const add = document.createElement('span')
      add.className = 'cm-fm-chip cm-fm-add'
      add.textContent = '+'
      add.setAttribute('data-tip', 'Ajouter une propriété\n(date de création, tags, aliases, statut…)')
      add.addEventListener('mousedown', (e) => e.preventDefault())
      add.addEventListener('click', (e) => {
        e.stopPropagation()
        setFmAdding(view, true)
      })
      bar.appendChild(add)
    }
    wrap.appendChild(bar)
    const editing = this.edit ? entries.find((e) => e.key === this.edit) : null
    if (editing) wrap.appendChild(this.editor(view, editing))
    addEditButton(wrap, view, this.pos, 'Éditer tout le frontmatter (YAML brut)')
    return wrap
  }
  destroy(dom: HTMLElement): void {
    // Each input's dropdown lives on document.body: remove the ones this card
    // opened, and only those — CodeMirror builds the new DOM BEFORE destroying
    // the old widget, so a blanket purge here killed the fresh menu.
    dom.querySelectorAll('input').forEach((i) => (i as InputWithMenu)._menu?.remove())
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** A standalone "✓ Terminer" bar (block widget) — used to leave a source region
 * that has no rendered preview of its own (e.g. the raw frontmatter editor). */
class BlockCloseWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'cm-block-close-bar'
    addCloseButton(bar, view)
    return bar
  }
}

/* ---------- code-block language picker ---------- */
let langNamesCache: string[] | null = null
/** Known language identifiers for the picker: each language's canonical name AND
 * its aliases (from @codemirror/language-data), so common info strings like
 * `bash`, `zsh`, `sh` (aliases of "Shell") are offered — highlighting resolves by
 * name or alias. Deduped case-insensitively (drop `python` next to `Python`, keep
 * alias-only ones like `bash`). `mermaid` first — not a CM language, but a valid
 * info string that renders as a diagram. */
function languageNames(): string[] {
  if (!langNamesCache) {
    const seen = new Set<string>()
    const out: string[] = []
    const add = (s: string): void => {
      const k = s.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        out.push(s)
      }
    }
    for (const l of languages) {
      add(l.name)
      for (const a of l.alias) add(a)
    }
    out.sort((a, b) => a.localeCompare(b))
    langNamesCache = ['mermaid', ...out]
  }
  return langNamesCache
}

/** Language field floated at the top-right of a fenced code block. A custom
 * combobox (not a native `<datalist>`, whose dropdown arrow steals focus and
 * can't be sized): a text input that filters a compact, scrollable menu —
 * wheel/click to pick, ↑/↓ + Enter to keyboard-pick, Esc closes. Committing
 * rewrites the info string on the opening fence line (a plain text edit). */
class LangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }
  eq(other: LangWidget): boolean {
    return other.lang === this.lang
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input')
    input.className = 'cm-code-lang'
    input.value = this.lang
    input.placeholder = 'langage'
    input.spellcheck = false
    input.title = 'Langage du bloc de code'
    input.addEventListener('mousedown', (e) => e.stopPropagation())

    const menu = document.createElement('div')
    menu.className = 'cm-code-lang-menu'
    menu.style.display = 'none'
    document.body.appendChild(menu)
    ;(input as unknown as { _menu: HTMLElement })._menu = menu

    let filtered: string[] = []
    let active = 0

    const commit = (value: string): void => {
      const line = view.state.doc.lineAt(view.posAtDOM(input))
      const m = /^(\s*)(`{3,}|~{3,})/.exec(line.text)
      if (!m) return
      const infoFrom = line.from + m[0].length
      view.dispatch({ changes: { from: infoFrom, to: line.to, insert: value.trim() } })
      hide()
      view.focus()
    }
    const hide = (): void => {
      menu.style.display = 'none'
    }
    const render = (): void => {
      const q = input.value.trim().toLowerCase()
      filtered = languageNames().filter((n) => n.toLowerCase().includes(q))
      if (active >= filtered.length) active = 0
      if (!filtered.length) {
        hide()
        return
      }
      menu.replaceChildren()
      filtered.forEach((n, i) => {
        const row = document.createElement('div')
        row.className = 'cm-code-lang-item' + (i === active ? ' cm-active' : '')
        row.textContent = n
        row.addEventListener('mousedown', (e) => {
          e.preventDefault() // keep focus in the input
          commit(n)
        })
        menu.appendChild(row)
      })
      const r = input.getBoundingClientRect()
      menu.style.top = `${r.bottom + window.scrollY + 2}px`
      menu.style.left = `${r.left + window.scrollX}px`
      menu.style.minWidth = `${r.width}px`
      menu.style.display = 'block'
      ;(menu.children[active] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
    }

    input.addEventListener('focus', () => {
      active = 0
      render()
    })
    input.addEventListener('input', () => {
      active = 0
      render()
    })
    input.addEventListener('blur', () => {
      // Delay so a click on a menu row still commits before the menu hides.
      window.setTimeout(hide, 150)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (filtered.length) {
          active = (active + 1) % filtered.length
          render()
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filtered.length) {
          active = (active - 1 + filtered.length) % filtered.length
          render()
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        commit(filtered[active] ?? input.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        hide()
      }
    })
    return input
  }
  destroy(dom: HTMLElement): void {
    // The menu lives on document.body — remove it when the widget is torn down.
    ;(dom as unknown as { _menu?: HTMLElement })._menu?.remove()
  }
  ignoreEvent(): boolean {
    return true
  }
}

/* ---------- helpers for the regex post-pass ---------- */
type Span = [number, number]
function inAny(spans: Span[], from: number, to: number): boolean {
  for (const [a, b] of spans) {
    if (from < b && to > a) return true
  }
  return false
}

/* ---------- decoration builder ---------- */
function buildDecorations(state: EditorState): DecorationSet {
  const deco: Array<Range<Decoration>> = []
  const doc = state.doc
  const text = doc.toString()
  const tree = syntaxTree(state)
  const taskRanges: Span[] = []
  const codeRanges: Span[] = []
  // Ranges (character offsets) already claimed by a wikilink `[[…]]` so the
  // Lezer Link handler doesn't also try to hide brackets in the same spot.
  const wikilinkRanges: Span[] = []
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    wikilinkRanges.push([m.index, m.index + m[0].length])
  }

  // YAML frontmatter: a `---` fenced block at the very top of the document.
  // Its lines are styled and, crucially, exempt from Markdown inline rendering
  // (so `tags: [a, b]` isn't mistaken for a link).
  let frontmatterEnd = 0
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 3)
    if (end !== -1) {
      const closeLine = doc.lineAt(end + 1)
      frontmatterEnd = closeLine.to
      if (!editing(state, 0, frontmatterEnd)) {
        // Collapsed: a discreet card (title → H1, other keys → chips).
        const rawFrom = doc.line(2).from
        const rawTo = closeLine.number > 2 ? doc.line(closeLine.number - 1).to : rawFrom
        const raw = doc.sliceString(rawFrom, rawTo)
        deco.push(
          Decoration.replace({ widget: new FrontmatterWidget(raw, rawFrom, fmEdit), block: true }).range(
            0,
            frontmatterEnd
          )
        )
      } else {
        // The caret is in the raw YAML: that IS the full edit, so a half-open
        // property field would just fight with it.
        fmEdit = null
        fmAdding = false
        // Editing: styled raw YAML + a "✓ Terminer" bar to leave the block.
        for (let n = 1; n <= closeLine.number; n++) {
          deco.push(Decoration.line({ class: 'cm-md-frontmatter' }).range(doc.line(n).from))
        }
        deco.push(Decoration.widget({ widget: new BlockCloseWidget(), block: true, side: 1 }).range(frontmatterEnd))
      }
    }
  }
  const inFrontmatter = (from: number): boolean => from < frontmatterEnd

  tree.iterate({
    enter: (node) => {
      const name = node.name
      const from = node.from
      const to = node.to

      // Fenced code: Mermaid diagram, or a styled/highlighted code block.
      if (name === 'FencedCode') {
        codeRanges.push([from, to])
        const info = node.node.getChild('CodeInfo')
        const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : ''
        if (lang === 'mermaid') {
          const textNode = node.node.getChild('CodeText')
          const code = textNode ? doc.sliceString(textNode.from, textNode.to) : ''
          const contentPos = textNode ? textNode.from : from
          if (!editing(state, from, to)) {
            deco.push(
              Decoration.replace({ widget: new MermaidWidget(code, contentPos, 'render'), block: true }).range(from, to)
            )
            return false
          }
          // Editing: keep the source (styled) and show a live preview below it.
          const mf = doc.lineAt(from).number
          const ml = doc.lineAt(to).number
          for (let n = mf; n <= ml; n++) {
            deco.push(Decoration.line({ class: 'cm-md-codeblock' }).range(doc.line(n).from))
          }
          deco.push(
            Decoration.widget({ widget: new MermaidWidget(code, contentPos, 'preview'), block: true, side: 1 }).range(to)
          )
          return false
        }
        const first = doc.lineAt(from).number
        const last = doc.lineAt(to).number
        for (let n = first; n <= last; n++) {
          deco.push(Decoration.line({ class: 'cm-md-codeblock' }).range(doc.line(n).from))
        }
        // Language picker floated at the block's top-right (free text + known-lang
        // autocompletion). Placed on the opening fence line.
        deco.push(Decoration.widget({ widget: new LangWidget(lang), side: 1 }).range(doc.line(first).from))
        // Return true: descend so the nested language tree (from codeLanguages)
        // is still highlighted by syntaxHighlighting().
        return true
      }

      if (name === 'InlineCode') codeRanges.push([from, to])

      // GFM table → rendered HTML table; raw source + live preview while editing.
      if (name === 'Table') {
        const src = doc.sliceString(from, to)
        // Column widths, kept in an HTML comment on the line above. It is hidden
        // (and its line compacted) unless the caret lands on it — it is
        // bookkeeping, not content, but it stays reachable and deletable.
        const cw = columnWidthsAbove(state, from)
        if (cw && !editing(state, cw.from, cw.to)) {
          deco.push(Decoration.replace({}).range(cw.from, cw.to))
          deco.push(Decoration.line({ class: 'cm-md-colw' }).range(cw.from))
        }
        if (!editing(state, from, to)) {
          // Edit button lands the caret inside the first header cell (from + 2),
          // not on the table boundary, so the table toolbar resolves the node.
          // A per-cell edit (the field above the table) keeps the table rendered.
          const edit = cellEdit && cellEdit.table === from ? cellEdit : null
          deco.push(
            Decoration.replace({
              widget: new TableWidget(src, from + 2, 'render', from, edit, cw?.widths ?? null),
              block: true
            }).range(from, to)
          )
        } else {
          // The caret is in the table source: that IS the full edit, so a
          // half-open cell field would just fight with it.
          if (cellEdit && cellEdit.table === from) cellEdit = null
          deco.push(
            Decoration.widget({
              widget: new TableWidget(src, from, 'preview', from, null, cw?.widths ?? null),
              block: true,
              side: 1
            }).range(to)
          )
        }
        return false
      }

      // Blockquote: plain quote, or a GitHub alert when the first line is
      // `[!TYPE]` (an optional leading backslash from an over-escaping serializer
      // is tolerated). Every blockquote gets a type dropdown on its first line.
      if (name === 'Blockquote') {
        const firstLine = doc.lineAt(from)
        const am = /^\s*>\s*\\?\[!(note|tip|important|warning|caution)\]\s*$/i.exec(firstLine.text)
        const kind = am ? am[1].toLowerCase() : ''
        const first = firstLine.number
        const last = doc.lineAt(to).number
        // The dropdown + marker-hiding are ALWAYS applied (not gated on editing):
        // otherwise the caret landing on the first line would make the control
        // vanish and reveal the raw `[!TYPE]` marker — reported as flickering.
        for (let n = first; n <= last; n++) {
          const line = doc.line(n)
          const pos = (n === first ? ' cm-alert-first' : '') + (n === last ? ' cm-alert-last' : '')
          deco.push(
            Decoration.line({ class: kind ? `cm-alert cm-alert-${kind}${pos}` : 'cm-md-quote' }).range(line.from)
          )
          if (n === first) {
            deco.push(Decoration.widget({ widget: new AlertSelectWidget(kind, line.from), side: -1 }).range(line.from))
            if (kind) {
              // Hide the whole `> [!TYPE]` marker line (the dropdown shows it).
              deco.push(Decoration.replace({}).range(line.from, line.to))
            } else {
              const qm = /^\s*>\s?/.exec(line.text)
              if (qm && qm[0].length) deco.push(Decoration.replace({}).range(line.from, line.from + qm[0].length))
            }
            continue
          }
          // Hide the leading `> ` quote marker on body lines.
          const qm = /^\s*>\s?/.exec(line.text)
          if (qm && qm[0].length) deco.push(Decoration.replace({}).range(line.from, line.from + qm[0].length))
        }
        return
      }

      // Task list items (incl. the MDForge `[~]` state): three-state checkbox.
      // Both bullet (`-`/`*`/`+`) and ordered (`1.`/`1)`) markers are supported.
      if (name === 'ListItem') {
        const line = doc.lineAt(from)
        const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX~])\]/.exec(line.text)
        if (m) {
          const markFrom = line.from + m[1].length
          const st = (m[2].toLowerCase() === 'x' ? 'x' : m[2]) as TaskState
          deco.push(Decoration.replace({ widget: new TaskWidget(st) }).range(markFrom, markFrom + 3))
          taskRanges.push([markFrom, markFrom + 3])
        }
        return
      }

      // Thematic break (`---` / `***` / `___`) → a compact rendered rule; raw
      // `---` is shown (editable) only when the caret is on the line.
      if (name === 'HorizontalRule') {
        // The frontmatter fence `---` parses as a HorizontalRule; leave it to the
        // frontmatter card. Emitting an HR here would overlap the card's block
        // replace and, on a rebuild, win it — the card would vanish.
        if (inFrontmatter(from)) return false
        const line = doc.lineAt(from)
        if (!editing(state, line.from, line.to) && line.to > line.from) {
          deco.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(line.from, line.to))
        } else {
          deco.push(Decoration.line({ class: 'cm-md-hr-editing' }).range(line.from))
        }
        return false
      }

      // Headings: enlarge the line, hide the leading "### ".
      const headingMatch = /^ATXHeading([1-6])$/.exec(name)
      if (headingMatch) {
        const line = doc.lineAt(from)
        deco.push(Decoration.line({ class: `cm-md-h cm-md-h${headingMatch[1]}` }).range(line.from))
        if (!editing(state, line.from, line.to)) {
          const mark = node.node.getChild('HeaderMark')
          if (mark) deco.push(Decoration.replace({}).range(mark.from, Math.min(mark.to + 1, line.to)))
        }
        return
      }

      if (name === 'StrongEmphasis' || name === 'Emphasis' || name === 'InlineCode' || name === 'Strikethrough') {
        if (inFrontmatter(from)) return
        const cls =
          name === 'StrongEmphasis'
            ? 'cm-md-strong'
            : name === 'Emphasis'
              ? 'cm-md-em'
              : name === 'InlineCode'
                ? 'cm-md-code'
                : 'cm-md-strike'
        deco.push(Decoration.mark({ class: cls }).range(from, to))
        if (!editing(state, from, to)) {
          const markName =
            name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark'
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name === markName) deco.push(Decoration.replace({}).range(c.from, c.to))
          }
        }
        return
      }

      // Links: hide `[`, `](url)` and style the text. Skip the `[~]` task marker
      // and wikilinks `[[…]]` (both of which the parser also sees as Links).
      if (name === 'Link') {
        if (inFrontmatter(from)) return
        if (taskRanges.some(([a, b]) => from >= a && to <= b)) return
        if (inAny(wikilinkRanges, from, to)) return
        if (editing(state, from, to)) return
        const open = node.node.firstChild
        let close: { from: number; to: number } | null = null
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (c.name === 'LinkMark' && doc.sliceString(c.from, c.to) === ']') {
            close = { from: c.from, to: c.to }
            break
          }
        }
        let url = ''
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (c.name === 'URL') {
            url = doc.sliceString(c.from, c.to)
            break
          }
        }
        if (open && open.name === 'LinkMark') deco.push(Decoration.replace({}).range(open.from, open.to))
        if (close) {
          const textFrom = open ? open.to : from
          if (close.from > textFrom) {
            // Tag the visible text with the URL so Ctrl/⌘-click can open it.
            deco.push(
              Decoration.mark({
                class: 'cm-md-link',
                attributes: { 'data-href': url, title: `${url}  (Ctrl/⌘+clic pour ouvrir)` }
              }).range(textFrom, close.from)
            )
          }
          deco.push(Decoration.replace({}).range(close.from, to))
        }
        return
      }

      // Images: `![alt](src)` → rendered <img>. While editing, keep the image as
      // a preview below the raw source (same pattern as mermaid/table/math).
      if (name === 'Image' && !inFrontmatter(from)) {
        const t = doc.sliceString(from, to)
        const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)/.exec(t)
        if (!m) return
        if (!editing(state, from, to)) {
          deco.push(Decoration.replace({ widget: new ImageWidget(m[2], m[1], from, 'render') }).range(from, to))
        } else {
          const line = doc.lineAt(to)
          deco.push(
            Decoration.widget({ widget: new ImageWidget(m[2], m[1], from, 'preview'), side: 1, block: true }).range(
              line.to
            )
          )
        }
        return
      }
    }
  })

  /* ---------- regex post-pass: math, wikilinks, footnotes ---------- */
  const mathRanges: Span[] = []

  // Block math $$…$$ (may span lines) → centered widget.
  for (const m of text.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to)) continue
    mathRanges.push([from, to])
    if (!editing(state, from, to)) {
      deco.push(
        Decoration.replace({ widget: new MathWidget(m[1].trim(), true, from, 'render'), block: true }).range(from, to)
      )
    } else {
      deco.push(
        Decoration.widget({ widget: new MathWidget(m[1].trim(), true, -1, 'preview'), block: true, side: 1 }).range(to)
      )
    }
  }

  // Inline math $…$ → inline widget (skip block-math and code spans).
  for (const m of text.matchAll(/\$([^\s$][^$\n]*?)\$/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to) || inAny(mathRanges, from, to)) continue
    if (!editing(state, from, to)) {
      deco.push(Decoration.replace({ widget: new MathWidget(m[1].trim(), false) }).range(from, to))
    }
  }

  // Wikilinks [[target]] / [[target|alias]] → clickable, brackets hidden.
  for (const m of text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to)) continue
    const raw = m[1]
    const pipe = raw.indexOf('|')
    const target = (pipe === -1 ? raw : raw.slice(0, pipe)).trim()
    const label = (pipe === -1 ? raw : raw.slice(pipe + 1)).trim()
    if (editing(state, from, to)) {
      deco.push(Decoration.mark({ class: 'cm-md-wikilink-raw' }).range(from, to))
      continue
    }
    // Hide `[[`, hide any `|alias` part, hide `]]`; style + tag the visible label.
    deco.push(Decoration.replace({}).range(from, from + 2))
    if (pipe === -1) {
      deco.push(
        Decoration.mark({ class: 'cm-md-wikilink', attributes: { 'data-wikilink': target } }).range(from + 2, to - 2)
      )
    } else {
      const labelFrom = from + 2 + pipe + 1
      deco.push(Decoration.replace({}).range(from + 2, labelFrom))
      deco.push(
        Decoration.mark({ class: 'cm-md-wikilink', attributes: { 'data-wikilink': target } }).range(labelFrom, to - 2)
      )
    }
    deco.push(Decoration.replace({}).range(to - 2, to))
    void label
  }

  // Footnotes: references `[^id]` (clickable) and definitions `[^id]:` (styled).
  for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    const from = m.index
    const to = from + m[0].length
    if (inFrontmatter(from) || inAny(codeRanges, from, to)) continue
    const isDef = text[to] === ':'
    deco.push(
      Decoration.mark({
        class: isDef ? 'cm-md-footnote-def' : 'cm-md-footnote-ref',
        attributes: { 'data-footnote': m[1] }
      }).range(from, to)
    )
  }

  // Compact the vertical rhythm: markdownlint wants blank lines around headings
  // and between paragraphs, so the source is full of them — but rendering each
  // at full line-height wastes space. Shrink every blank line to a STABLE small
  // height (never revealed on caret): a reveal would change the line height as
  // the caret enters/leaves, reflowing everything below and making arrow-key
  // navigation jump. Left untouched inside code/block-math (blanks matter there).
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    if (line.length !== 0) continue
    if (inFrontmatter(line.from)) continue
    if (inAny(codeRanges, line.from, line.to) || inAny(mathRanges, line.from, line.to)) continue
    deco.push(Decoration.line({ class: 'cm-md-blank' }).range(line.from))
  }

  return Decoration.set(deco, true)
}

// A StateField (not a ViewPlugin) so it can provide *block* decorations
// (Mermaid diagrams, tables, block math). Rebuilds on doc/selection change.
export const livePreview = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (deco, tr) => {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(redrawMermaidEffect) || e.is(cellEditEffect) || e.is(fmEditEffect))
    )
      return buildDecorations(tr.state)
    return deco.map(tr.changes)
  },
  provide: (field) => EditorView.decorations.from(field)
})
