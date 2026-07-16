import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

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
