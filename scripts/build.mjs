import { build } from 'esbuild'
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { ensureThinkingOrbsPatch } from './patch-thinking-orbs.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
await ensureThinkingOrbsPatch()
await rm('lib', { recursive: true, force: true })
await mkdir('lib', { recursive: true })
const shared = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@deepseek-ai/dsh-client-ui-primitives']
const result = await build({
  entryPoints: ['src/client/index.tsx'], bundle: true, write: false, platform: 'browser', format: 'cjs',
  target: 'es2022', minify: true, external: shared, define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'inline-css',
    setup(builder) {
      builder.onResolve({ filter: /\.css\?inline$/ }, async (args) => {
        const name = args.path.replace(/\?inline$/, '')
        const resolved = await builder.resolve(name, { resolveDir: args.resolveDir, kind: 'import-statement' })
        return { path: resolved.path, namespace: 'inline-css' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'inline-css' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
    },
  }, {
    name: 'raw-svg',
    setup(builder) {
      builder.onResolve({ filter: /\.svg\?raw$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
        namespace: 'raw-svg',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
    },
  }],
})
const body = result.outputFiles[0].text
await writeFile('lib/client.js', `globalThis.__ModuleLoader__.load({id:"dsh-canvas",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${body}\nreturn module.exports;}});\n`)
await build({
  entryPoints: ['src/host/index.ts'], outfile: 'lib/index.js', bundle: true, platform: 'node', format: 'esm',
  target: 'node22', packages: 'external', external: ['./vendor/volcengine-signer.cjs'], sourcemap: true,
})
// Bundling places Database's import.meta.url in lib/index.js.
await copyFile('src/host/persistence/worker.mjs', 'lib/worker.mjs')
await copyFile('src/host/persistence/schema.sql', 'lib/schema.sql')
await copyFile('src/host/review/review-worker.mjs', 'lib/review-worker.mjs')
await copyFile('src/host/review/review-schema.sql', 'lib/review-schema.sql')
await copyFile('src/host/review/vendor/LICENSE', 'lib/volcengine-signer-LICENSE')
await copyFile('src/host/review/vendor/source.json', 'lib/volcengine-signer-source.json')
await mkdir('lib/vendor', { recursive: true })
await copyFile('src/host/review/vendor/volcengine-signer.cjs', 'lib/vendor/volcengine-signer.cjs')
for (const [config, outDir, rootDir] of [
  ['tsconfig.host.json', 'lib/types', 'src'],
  ['tsconfig.client.json', 'lib/types', 'src'],
]) {
  const checked = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config, '--noEmit', 'false', '--declaration', '--emitDeclarationOnly', '--outDir', outDir, '--rootDir', rootDir], { stdio: 'inherit' })
  if (checked.status) process.exit(checked.status)
}
// The package's browser subpath uses the lazy Harness module; declarations sit beside its source structure.
const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
if (!packageJson.exports['./client']) throw new Error('Missing client export')
console.log('Built Harness host + lazy browser module in lib/')
