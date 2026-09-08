/*
 * Line diff — the computation behind MDForge's quick-diff margin.
 *
 * Kept apart from `quickdiff.ts`, which is where VS Code and the Git extension
 * come in: this file imports nothing, so it can be exercised by
 * `scripts/quickdiff.test.mjs` outside an Extension Host.
 */

export type LineChangeType = 'added' | 'modified' | 'deleted'

/**
 * A run of changed lines, in the CURRENT document, as 0-based line indexes.
 * `from`/`to` is a half-open range; a `deleted` change is empty on this side
 * (`from === to`) and means "content was removed just before this line".
 */
export interface LineChange {
  readonly from: number
  readonly to: number
  readonly type: LineChangeType
}

/**
 * Cell budget for the exact LCS, which only ever runs on a region with no
 * anchor left (see below) — in practice one rewritten paragraph. Past it, the
 * region is reported as one modified block: a document churned beyond this has
 * no line-by-line story left to tell.
 */
const MAX_LCS_CELLS = 2_000_000

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

/**
 * Line diff of `base` → `current`, as changes positioned in `current`.
 *
 * Strategy is patience diff: trim the common prefix and suffix, anchor on the
 * lines that occur EXACTLY ONCE on each side (in a note, that is nearly every
 * line of prose), and recurse between consecutive anchors. Two edits far apart
 * in a long document therefore stay two small problems instead of one huge one
 * — the plain LCS below is quadratic, and on a 3000-line note it would have
 * given up and painted the whole file as modified.
 *
 * A run that both drops and inserts lines is reported as `modified` rather than
 * as a deletion followed by an addition: that is what an editor margin should
 * show for a rewritten paragraph.
 */
export function diffLines(base: string, current: string): LineChange[] {
  const a = splitLines(base)
  const b = splitLines(current)
  const changes: LineChange[] = []
  diffRange(a, 0, a.length, b, 0, b.length, changes)
  return changes
}

function diffRange(
  a: string[],
  aFrom: number,
  aTo: number,
  b: string[],
  bFrom: number,
  bTo: number,
  out: LineChange[]
): void {
  while (aFrom < aTo && bFrom < bTo && a[aFrom] === b[bFrom]) {
    aFrom++
    bFrom++
  }
  while (aTo > aFrom && bTo > bFrom && a[aTo - 1] === b[bTo - 1]) {
    aTo--
    bTo--
  }

  const n = aTo - aFrom
  const m = bTo - bFrom
  if (n === 0 && m === 0) return
  if (n === 0) {
    out.push({ from: bFrom, to: bTo, type: 'added' })
    return
  }
  if (m === 0) {
    out.push({ from: bFrom, to: bFrom, type: 'deleted' })
    return
  }

  const anchors = uniqueAnchors(a, aFrom, aTo, b, bFrom, bTo)
  if (anchors.length > 0) {
    let ai = aFrom
    let bi = bFrom
    // Each anchor consumes a line on both sides, so every recursive call gets a
    // strictly smaller region — the recursion cannot spin.
    for (const anchor of anchors) {
      diffRange(a, ai, anchor.a, b, bi, anchor.b, out)
      ai = anchor.a + 1
      bi = anchor.b + 1
    }
    diffRange(a, ai, aTo, b, bi, bTo, out)
    return
  }

  if (n * m > MAX_LCS_CELLS) {
    out.push({ from: bFrom, to: bTo, type: 'modified' })
    return
  }
  lcsDiff(a, aFrom, aTo, b, bFrom, bTo, out)
}

/**
 * The lines appearing exactly once in each region, paired up and kept in an
 * order that is increasing on both sides (longest increasing subsequence of the
 * `b` positions). Anything reordered is left for the LCS in the sub-regions.
 */
function uniqueAnchors(
  a: string[],
  aFrom: number,
  aTo: number,
  b: string[],
  bFrom: number,
  bTo: number
): Array<{ a: number; b: number }> {
  const inA = new Map<string, number>()
  for (let i = aFrom; i < aTo; i++) inA.set(a[i], inA.has(a[i]) ? -1 : i)
  const inB = new Map<string, number>()
  for (let j = bFrom; j < bTo; j++) inB.set(b[j], inB.has(b[j]) ? -1 : j)

  const pairs: Array<{ a: number; b: number }> = []
  for (const [line, i] of inA) {
    if (i < 0) continue
    const j = inB.get(line)
    if (j === undefined || j < 0) continue
    pairs.push({ a: i, b: j })
  }
  if (pairs.length === 0) return []
  pairs.sort((x, y) => x.a - y.a)

  // Patience sorting: longest strictly increasing run of `b` positions.
  const tails: number[] = []
  const previous = new Int32Array(pairs.length).fill(-1)
  const tailIndex: number[] = []
  for (let k = 0; k < pairs.length; k++) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (tails[mid] < pairs[k].b) low = mid + 1
      else high = mid
    }
    tails[low] = pairs[k].b
    tailIndex[low] = k
    previous[k] = low > 0 ? tailIndex[low - 1] : -1
  }

  const anchors: Array<{ a: number; b: number }> = []
  for (let k = tailIndex[tails.length - 1]; k >= 0; k = previous[k]) anchors.push(pairs[k])
  return anchors.reverse()
}

/** Exact diff of one small region, by longest common subsequence. */
function lcsDiff(
  a: string[],
  aFrom: number,
  aTo: number,
  b: string[],
  bFrom: number,
  bTo: number,
  out: LineChange[]
): void {
  const n = aTo - aFrom
  const m = bTo - bFrom
  const width = m + 1
  // lcs[i][j] = length of the longest common subsequence of a[i..], b[j..],
  // both relative to the region's start.
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[aFrom + i] === b[bFrom + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[aFrom + i] === b[bFrom + j]) {
      i++
      j++
      continue
    }
    const insertedFrom = j
    const droppedFrom = i
    while (i < n || j < m) {
      if (i < n && j < m && a[aFrom + i] === b[bFrom + j]) break
      if (j >= m) i++
      else if (i >= n) j++
      // Follow the LCS: whichever side can still reach the longer common tail
      // stays, the other one is consumed.
      else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) i++
      else j++
    }
    const dropped = i - droppedFrom
    const inserted = j - insertedFrom
    if (inserted > 0) {
      out.push({
        from: bFrom + insertedFrom,
        to: bFrom + j,
        type: dropped > 0 ? 'modified' : 'added'
      })
    } else if (dropped > 0) {
      out.push({ from: bFrom + insertedFrom, to: bFrom + insertedFrom, type: 'deleted' })
    }
  }
}
