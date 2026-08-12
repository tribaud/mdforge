import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const watch = process.argv.includes('--watch')

/**
 * Ship only KaTeX's `woff2` fonts. Its CSS lists `woff2, woff, ttf` per glyph
 * family and VS Code's Chromium webview always picks `woff2` (listed first), so
 * the `woff`/`ttf` fallbacks (~40 files, ~0.9 MB) are dead weight. Strip those
 * fallbacks from the CSS before esbuild resolves the `url()`s, so they are never
 * emitted — and no dangling reference is left behind.
 */
const katexWoff2Only = {
  name: 'katex-woff2-only',
  setup(build) {
    build.onLoad({ filter: /katex\.min\.css$/ }, async (args) => {
      const css = (await readFile(args.path, 'utf8'))
        .replace(/,url\([^)]*\.woff\)\s*format\(["']woff["']\)/g, '')
        .replace(/,url\([^)]*\.ttf\)\s*format\(["']truetype["']\)/g, '')
      return { contents: css, loader: 'css', resolveDir: dirname(args.path) }
    })
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['media-src/src/main.ts'],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: 'media/dist',
  sourcemap: true,
  minify: !watch,
  target: ['es2020'],
  loader: {
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file'
  },
  assetNames: 'assets/[name]-[hash]',
  plugins: [katexWoff2Only],
  logLevel: 'info'
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[mdforge] esbuild watching webview...')
} else {
  await esbuild.build(options)
  console.log('[mdforge] webview bundle built.')
}
