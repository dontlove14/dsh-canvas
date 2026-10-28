import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const digest = (text) => createHash('sha256').update(text).digest('hex')
const dpr = '    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" && devicePixelRatio || 1);'
const replacements = [
  ['  gravity,\n  style,', '  gravity,\n  pixelRatio,\n  style,'],
  [dpr, `    const dpr = Number.isFinite(pixelRatio) && pixelRatio > 0
      ? Math.max(1, Math.min(8, pixelRatio))
      : Math.min(2, typeof devicePixelRatio !== "undefined" && devicePixelRatio || 1);`],
  ['optsKey, customFrame]);', 'optsKey, customFrame, pixelRatio]);'],
]
const targets = [
  ['dist/index.es.js', '04d55a22c73d441b0e569c87c4d7ffb9fa7b07540c70aebdd635bedbd2d59d22', replacements],
  ['dist/index.cjs', '46e6a462c0946de8ee87f14c5fcbbb7e1439ea56fdc8852fbef42fa1825d57a5', replacements],
  ['dist/types.d.ts', '4d2e11056eaf7a5d3a373d55c6a4c77671faf4779d5b8e5821162d4005aafca5', [
    ['    speed?: number;', `    speed?: number;
    /** Backing pixels per CSS pixel, clamped to 1–8. Omit for the stock screen DPR. */
    pixelRatio?: number;`],
  ]],
]

/** Only extends backing resolution; the dependency still owns every animation frame. */
export async function patchThinkingOrbs(directory) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (pkg.name !== 'thinking-orbs' || pkg.version !== '0.3.2') throw new Error('Thinking Orbs patch requires exactly 0.3.2')
  const changes = []
  for (const [name, originalHash, edits] of targets) {
    const path = join(directory, name)
    const current = await readFile(path, 'utf8')
    let original = current
    // Reconstruct the upstream bytes to validate both pristine and patched installs.
    for (const [before, after] of edits) {
      if (original.includes(after)) original = original.replace(after, before)
    }
    if (digest(original) !== originalHash) throw new Error(`Thinking Orbs upstream integrity mismatch: ${name}`)
    let patched = original
    for (const [before, after] of edits) {
      if (patched.split(before).length !== 2) throw new Error(`Thinking Orbs patch anchor mismatch: ${name}`)
      patched = patched.replace(before, after)
    }
    if (current !== original && current !== patched) throw new Error(`Thinking Orbs partial patch rejected: ${name}`)
    if (current !== patched) changes.push([path, patched])
  }
  // Validate all targets before touching any installed file.
  for (const [path, patched] of changes) {
    // Replace the inode so pnpm hard links cannot mutate the upstream store.
    const temporary = `${path}.dsh-canvas-${randomUUID()}.tmp`
    try {
      await writeFile(temporary, patched, { mode: (await stat(path)).mode })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  return changes.length
}

export async function ensureThinkingOrbsPatch() {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('thinking-orbs')
  return patchThinkingOrbs(dirname(dirname(entry)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await ensureThinkingOrbsPatch()
  console.log('Thinking Orbs 0.3.2 backing-resolution patch verified')
}
