import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { patchThinkingOrbs } from '../scripts/patch-thinking-orbs.mjs'

const installed = dirname(dirname(createRequire(import.meta.url).resolve('thinking-orbs')))
const temporary: string[] = []
const targets = ['package.json', 'dist/index.es.js', 'dist/index.cjs', 'dist/types.d.ts', 'dist/engine.es.js', 'dist/engine.cjs']
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'canvas-orb-patch-'))
  temporary.push(path)
  await mkdir(join(path, 'dist'))
  for (const file of targets) await copyFile(join(installed, file), join(path, file))
  return path
}
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }) })

it('applies the resolution extension to a pristine dependency without replacing its animation engine', async () => {
  const path = await fixture()
  for (const file of ['dist/index.es.js', 'dist/index.cjs']) {
    const pristine = (await readFile(join(path, file), 'utf8'))
      .replace('  pixelRatio,\n', '')
      .replace(/    const dpr = Number\.isFinite\(pixelRatio\)[\s\S]*?: Math\.min\(2,/, '    const dpr = Math.min(2,')
      .replace('customFrame, pixelRatio]);', 'customFrame]);')
    await writeFile(join(path, file), pristine)
  }
  const types = (await readFile(join(path, 'dist/types.d.ts'), 'utf8'))
    .replace(/    \/\*\* Backing pixels[^\n]*\n    pixelRatio\?: number;\n/, '')
  await writeFile(join(path, 'dist/types.d.ts'), types)
  const engine = await readFile(join(path, 'dist/engine.es.js'))
  expect(await patchThinkingOrbs(path)).toBe(3)
  expect(await patchThinkingOrbs(path)).toBe(0)
  expect(await readFile(join(path, 'dist/engine.es.js'))).toEqual(engine)
  expect((await readFile(join(path, 'dist/types.d.ts'), 'utf8'))).toContain('pixelRatio?: number')
})
it('verifies an already patched install idempotently while leaving both animation engines unchanged', async () => {
  const path = await fixture()
  const before = await Promise.all(targets.map((file) => readFile(join(path, file))))
  expect(await patchThinkingOrbs(path)).toBe(0)
  expect(await patchThinkingOrbs(path)).toBe(0)
  expect(await Promise.all(targets.map((file) => readFile(join(path, file))))).toEqual(before)
})
it('rejects dependency drift before changing any other target', async () => {
  const path = await fixture()
  const esm = await readFile(join(path, 'dist/index.es.js'))
  await writeFile(join(path, 'dist/index.cjs'), 'unexpected upstream implementation')
  await expect(patchThinkingOrbs(path)).rejects.toThrow('integrity mismatch')
  expect(await readFile(join(path, 'dist/index.es.js'))).toEqual(esm)
})
it('rejects an unreviewed dependency version', async () => {
  const path = await fixture()
  await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'thinking-orbs', version: '0.3.3' }))
  await expect(patchThinkingOrbs(path)).rejects.toThrow('exactly 0.3.2')
})
