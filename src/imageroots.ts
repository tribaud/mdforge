import * as path from 'path'

/*
 * Dossiers qu'une note référence HORS de son propre dossier, pour les images.
 *
 * La webview ne charge un fichier local que s'il se trouve sous un de ses
 * `localResourceRoots`. Avec le seul dossier de la note, `../inputs/x.png` était
 * résolu en URL correcte puis refusé : l'image restait vide. On ajoute donc le
 * dossier de chaque image relative qui sort du dossier de la note.
 *
 * Les racines sont fixées à l'ouverture : les changer ensuite recharge la
 * webview. Une image hors racine ajoutée en cours de session s'affiche à la
 * réouverture de la note (ou si son dossier est déjà sous un dossier du
 * workspace, ajouté lui aussi par l'appelant).
 *
 * Borné : au plus `MAX_UP` niveaux au-dessus de la note, et jamais un dossier
 * à moins de `MIN_DEPTH` niveaux de la racine. Sans borne, une note clonée
 * contenant `![](../../../../../../x.png)` ouvrait à la webview tout le disque
 * (`/` comme racine). Les dossiers du workspace, eux, sont ajoutés à part.
 *
 * Ce module n'importe que `path` : il se teste hors Extension Host.
 */

const MAX_UP = 3
const MIN_DEPTH = 3

const MD_IMAGE = /!\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)/gm
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i

function cleanSrc(raw: string): string | undefined {
  let src = raw.trim()
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1)
  src = src.replace(/[?#].*$/, '')
  // Un schéma (http:, data:, file:…) ou un chemin absolu ne sont pas relatifs.
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return undefined
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

/** Dossiers (absolus, dédoublonnés) des images relatives sortant de `docDir`. */
export function imageRootsOutside(text: string, docDir: string): string[] {
  const sources: string[] = []
  for (const m of text.matchAll(MD_IMAGE)) sources.push(m[1])
  for (const m of text.matchAll(HTML_IMAGE)) sources.push(m[1] ?? m[2])
  for (const m of text.matchAll(REF_DEF)) if (IMAGE_EXT.test(cleanSrc(m[1]) ?? '')) sources.push(m[1])

  const base = path.resolve(docDir)
  const roots = new Set<string>()
  for (const raw of sources) {
    const src = cleanSrc(raw)
    if (!src) continue
    const file = path.resolve(base, src)
    const rel = path.relative(base, file)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) continue
    const up = rel.split(/[\\/]/).filter((seg) => seg === '..').length
    const dir = path.dirname(file)
    const depth = dir.split(/[\\/]/).filter(Boolean).length - (/^[a-z]:/i.test(dir) ? 1 : 0)
    if (path.isAbsolute(rel) || up > MAX_UP || depth < MIN_DEPTH) continue
    roots.add(dir)
  }
  return [...roots]
}
