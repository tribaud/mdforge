/*
 * MDForge (CodeMirror) — Tab / Maj+Tab dans une liste.
 *
 * La première version ajoutait ou retirait deux espaces, ligne par ligne. Deux
 * défauts en sortaient :
 *  - sous `1. a`, deux espaces ne font pas une sous-liste (il en faut trois :
 *    la largeur du marqueur du parent). `  2. b` restait un frère, et Tab
 *    semblait ne rien faire ;
 *  - un élément qui avait des enfants partait seul : ses enfants restaient sur
 *    place et changeaient de parent.
 *
 * Ici l'indentation vient du marqueur de l'élément au-dessus, la
 * sous-arborescence suit l'élément, et un élément numéroté prend le numéro de
 * sa nouvelle place (1 en tête d'une sous-liste, la suite du parent quand on
 * remonte).
 *
 * Pur : des lignes en entrée, des modifications en sortie, rien de CodeMirror.
 */

export const LIST_ITEM = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)/

export interface LineEdit {
  /** Index (0-based) de la ligne. */
  line: number
  /** Colonnes [from, to) remplacées par `insert`. */
  from: number
  to: number
  insert: string
}

const indentOf = (text: string): number => /^[ \t]*/.exec(text)![0].length
const isBlank = (text: string): boolean => text.trim() === ''

/** Largeur du marqueur et de l'espace qui le suit : la colonne du contenu. */
function markerWidth(m: RegExpExecArray): number {
  const spaces = m[5].length
  // Au-delà de quatre espaces, CommonMark compte le marqueur + un espace.
  return m[2].length + (spaces >= 1 && spaces <= 4 ? spaces : 1)
}

/** Fin (exclue) de la sous-arborescence de l'élément `i` : les lignes plus
 * indentées que lui, et les blancs entre elles. Un blanc final n'en fait pas
 * partie. */
function subtreeEnd(lines: string[], i: number): number {
  const w = indentOf(lines[i])
  let end = i + 1
  for (let k = i + 1; k < lines.length; k++) {
    if (isBlank(lines[k])) continue
    if (indentOf(lines[k]) <= w) break
    end = k + 1
  }
  return end
}

/** Décale la ligne `i` et sa sous-arborescence de `delta` colonnes. */
function shift(lines: string[], i: number, end: number, delta: number, out: LineEdit[]): void {
  for (let k = i; k < end; k++) {
    if (isBlank(lines[k])) continue
    if (delta > 0) out.push({ line: k, from: 0, to: 0, insert: ' '.repeat(delta) })
    else {
      const n = Math.min(-delta, indentOf(lines[k]))
      if (n) out.push({ line: k, from: 0, to: n, insert: '' })
    }
  }
}

function renumber(lines: string[], i: number, num: number, out: LineEdit[]): void {
  const m = LIST_ITEM.exec(lines[i])
  if (!m || m[3] === undefined || Number(m[3]) === num) return
  const at = m[1].length
  out.push({ line: i, from: at, to: at + m[3].length, insert: String(num) })
}

/** Le numéro qui suit le dernier élément numéroté d'indentation `w` entre
 * `from` et `to` (exclus), ou 1. */
function nextNumber(lines: string[], from: number, to: number, w: number): number {
  for (let k = to - 1; k > from; k--) {
    const m = LIST_ITEM.exec(lines[k])
    if (m && m[1].length === w && m[3] !== undefined) return Number(m[3]) + 1
  }
  return 1
}

/**
 * Tab sur les éléments de liste `targets` (index de lignes, croissants).
 * `null` quand aucune cible n'est un élément de liste (Tab garde alors son
 * comportement par défaut) ; une liste vide quand l'élément ne peut pas
 * descendre (le premier d'une liste n'a pas de parent où aller).
 */
export function indentItems(lines: string[], targets: number[]): LineEdit[] | null {
  const out: LineEdit[] = []
  let any = false
  let covered = -1
  for (const i of targets) {
    const m = LIST_ITEM.exec(lines[i])
    if (!m) continue
    any = true
    if (i < covered) continue
    const w = m[1].length
    const end = subtreeEnd(lines, i)
    covered = end
    // Le frère précédent : même indentation, sans remonter au-dessus du parent.
    let sib = -1
    for (let j = i - 1; j >= 0; j--) {
      if (isBlank(lines[j])) continue
      const jw = indentOf(lines[j])
      if (jw > w) continue
      if (jw < w) break
      if (LIST_ITEM.test(lines[j])) sib = j
      break
    }
    if (sib < 0) continue
    const target = w + markerWidth(LIST_ITEM.exec(lines[sib])!)
    shift(lines, i, end, target - w, out)
    renumber(lines, i, nextNumber(lines, sib, i, target), out)
  }
  return any ? out : null
}

/** Maj+Tab : l'élément remonte au niveau de son parent, avec ses enfants. */
export function outdentItems(lines: string[], targets: number[]): LineEdit[] | null {
  const out: LineEdit[] = []
  let any = false
  let covered = -1
  for (const i of targets) {
    const m = LIST_ITEM.exec(lines[i])
    if (!m) continue
    any = true
    if (i < covered) continue
    const w = m[1].length
    const end = subtreeEnd(lines, i)
    covered = end
    if (w === 0) continue
    let parent = -1
    for (let j = i - 1; j >= 0; j--) {
      if (isBlank(lines[j])) continue
      if (indentOf(lines[j]) < w) {
        if (LIST_ITEM.test(lines[j])) parent = j
        break
      }
    }
    const pm = parent >= 0 ? LIST_ITEM.exec(lines[parent]) : null
    // Indenté AU-DELÀ de la colonne du contenu du parent, l'élément n'est pas
    // une sous-liste : 4 espaces de trop et `- x` se lit comme la suite du
    // paragraphe du parent (« mes tirets sont du texte » sous une tâche). Il
    // revient d'abord à cette colonne, et devient un vrai enfant.
    const childCol = pm ? pm[1].length + markerWidth(pm) : 0
    if (pm && w > childCol) {
      shift(lines, i, end, childCol - w, out)
      continue
    }
    const target = parent >= 0 ? indentOf(lines[parent]) : 0
    shift(lines, i, end, target - w, out)
    if (pm && pm[3] !== undefined) renumber(lines, i, Number(pm[3]) + 1, out)
  }
  return any ? out : null
}

/* ---------- conversion puces ⇄ numéros ⇄ tâches, renumérotation ---------- */

export type ListKind = 'bullet' | 'ordered' | 'task'

const TASK_BOX = /^\[[ xX~]\](?:[ \t]|$)/

interface Item {
  indent: number
  /** Fin du marqueur et de ses espaces (colonne). */
  markEnd: number
  bullet?: string
  num?: number
  delim?: string
  spaces: string
  /** La case `[ ] ` (avec son espace), ou ''. */
  box: string
  width: number
}

function item(text: string): Item | null {
  const m = LIST_ITEM.exec(text)
  if (!m) return null
  const markEnd = m[0].length
  const box = TASK_BOX.exec(text.slice(markEnd))?.[0] ?? ''
  return {
    indent: m[1].length,
    markEnd,
    bullet: m[3] === undefined ? m[2] : undefined,
    num: m[3] === undefined ? undefined : Number(m[3]),
    delim: m[4],
    spaces: m[5],
    box,
    width: markerWidth(m)
  }
}

export function kindOf(text: string): ListKind | null {
  const it = item(text)
  if (!it) return null
  return it.box ? 'task' : it.num !== undefined ? 'ordered' : 'bullet'
}

/** Deux éléments de la même liste : CommonMark coupe la liste dès que le
 * caractère de puce ou le délimiteur du numéro change. */
const sameList = (a: Item, b: Item): boolean =>
  a.num !== undefined ? b.num !== undefined && a.delim === b.delim : a.bullet === b.bullet

/** Les éléments de la liste de `i` au même niveau, dans l'ordre. */
export function siblingGroup(lines: string[], i: number): number[] {
  const me = item(lines[i])
  if (!me) return []
  const w = me.indent
  const walk = (step: number): number[] => {
    const out: number[] = []
    for (let j = i + step; j >= 0 && j < lines.length; j += step) {
      if (isBlank(lines[j])) continue
      const jw = indentOf(lines[j])
      if (jw > w) continue
      if (jw < w) break
      const it = item(lines[j])
      if (!it || !sameList(me, it)) break
      out.push(j)
    }
    return out
  }
  return [...walk(-1).reverse(), i, ...walk(1)]
}

/** Accumule les modifications : un décalage par ligne (les enfants d'un
 * élément dont le marqueur change de largeur) et un remplacement de marqueur.
 * Deux décalages sur une même ligne s'additionnent au lieu de se chevaucher. */
class Edits {
  private shifts = new Map<number, number>()
  private marks: LineEdit[] = []
  constructor(private lines: string[]) {}
  shiftChildren(i: number, delta: number): void {
    if (!delta) return
    const end = subtreeEnd(this.lines, i)
    for (let k = i + 1; k < end; k++) {
      if (!isBlank(this.lines[k])) this.shifts.set(k, (this.shifts.get(k) ?? 0) + delta)
    }
  }
  mark(e: LineEdit): void {
    this.marks.push(e)
  }
  done(): LineEdit[] {
    const out = [...this.marks]
    for (const [k, d] of this.shifts) {
      if (d > 0) out.push({ line: k, from: 0, to: 0, insert: ' '.repeat(d) })
      else {
        const n = Math.min(-d, indentOf(this.lines[k]))
        if (n) out.push({ line: k, from: 0, to: n, insert: '' })
      }
    }
    return out
  }
}

/** Remplace le marqueur (et la case) de l'élément `i` par `prefix` ; ses
 * enfants suivent la nouvelle colonne du contenu. */
function setPrefix(lines: string[], i: number, prefix: string, ed: Edits): void {
  const it = item(lines[i])!
  const old = lines[i].slice(it.indent, it.markEnd + it.box.length)
  if (old === prefix) return
  ed.mark({ line: i, from: it.indent, to: it.markEnd + it.box.length, insert: prefix })
  const nm = LIST_ITEM.exec(' '.repeat(it.indent) + prefix)
  if (nm) ed.shiftChildren(i, markerWidth(nm) - it.width)
}

function renumberInto(lines: string[], i: number, ed: Edits, start?: number): void {
  const group = siblingGroup(lines, i)
  const items = group.map((k) => item(lines[k])!)
  if (!items.length || items[0].num === undefined) return
  // `1. 1. 1.` : un style à part entière (le rendu numérote seul), on le garde.
  const lazy = start === undefined && items.length > 1 && items.every((it) => it.num === items[0].num)
  const first = start ?? items[0].num!
  group.forEach((k, n) => {
    const it = items[n]
    const num = lazy ? first : first + n
    if (num !== it.num) setPrefix(lines, k, `${num}${it.delim}${it.spaces}${it.box}`, ed)
  })
}

/** Renumérote la liste de chaque ligne donnée (une fois par liste). */
export function renumberLists(lines: string[], at: number[], start?: number): LineEdit[] {
  const ed = new Edits(lines)
  const seen = new Set<number>()
  for (const i of at) {
    if (i < 0 || i >= lines.length || !item(lines[i])) continue
    const group = siblingGroup(lines, i)
    if (seen.has(group[0])) continue
    seen.add(group[0])
    renumberInto(lines, i, ed, start)
  }
  return ed.done()
}

/** Les listes que Tab / Maj+Tab sur `targets` ont pu déranger : l'élément
 * déplacé, et ses anciens voisins au-dessus et en dessous. */
export function touchedLists(lines: string[], targets: number[]): number[] {
  const out: number[] = []
  for (const i of targets) {
    out.push(i)
    for (let j = i - 1; j >= 0; j--) {
      if (!isBlank(lines[j])) {
        out.push(j)
        break
      }
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (!isBlank(lines[j]) && item(lines[j])) {
        out.push(j)
        break
      }
    }
  }
  return out
}

/**
 * Convertit en `kind`. Un curseur seul sur un élément : toute sa liste à ce
 * niveau. Une sélection : exactement ses lignes (un paragraphe devient un
 * élément). Si tout est déjà de ce type, la liste est retirée : ce sont des
 * bascules, comme les boutons de la barre.
 */
export function convertList(lines: string[], targets: number[], kind: ListKind, caretOnly: boolean): LineEdit[] {
  let rows = targets
  if (caretOnly && targets.length === 1 && item(lines[targets[0]])) rows = siblingGroup(lines, targets[0])
  rows = rows.filter((k) => !isBlank(lines[k]))
  if (!rows.length) return []
  const inRows = new Set(rows)
  const ed = new Edits(lines)

  if (rows.every((k) => kindOf(lines[k]) === kind)) {
    for (const k of rows) {
      const it = item(lines[k])!
      ed.mark({ line: k, from: it.indent, to: it.markEnd + it.box.length, insert: '' })
      ed.shiftChildren(k, -it.width)
    }
    return ed.done()
  }

  // Numérotation : la suite de la liste numérotée juste au-dessus quand la
  // sélection la prolonge, sinon 1. Comptée par niveau d'indentation.
  const next = new Map<number, number>()
  const numberFor = (k: number, w: number): number => {
    if (!next.has(w)) {
      let start = 1
      for (let j = k - 1; j >= 0; j--) {
        if (isBlank(lines[j]) || indentOf(lines[j]) > w) continue
        const it = indentOf(lines[j]) === w ? item(lines[j]) : null
        if (it?.num !== undefined && !inRows.has(j)) start = it.num + 1
        break
      }
      next.set(w, start)
    }
    const n = next.get(w)!
    next.set(w, n + 1)
    return n
  }

  for (const k of rows) {
    const it = item(lines[k])
    const w = it ? it.indent : indentOf(lines[k])
    const box = it?.box || '[ ] '
    const prefix =
      kind === 'ordered'
        ? `${numberFor(k, w)}${it?.delim ?? '.'} `
        : kind === 'bullet'
          ? `${it?.bullet ?? '-'} `
          : `${it?.num !== undefined ? `${it.num}${it.delim}` : (it?.bullet ?? '-')} ${box}`
    if (it) setPrefix(lines, k, prefix, ed)
    else ed.mark({ line: k, from: w, to: w, insert: prefix })
  }
  return ed.done()
}
