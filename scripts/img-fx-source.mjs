import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const imgFxSourceDir = new URL('../src/client/vendor/img-fx/', import.meta.url)

/** Refuse builds whose fixed upstream source no longer matches its identity. */
export async function verifyImgFxSource(directory = imgFxSourceDir) {
  const source = JSON.parse(await readFile(new URL('source.json', directory), 'utf8'))
  assert.equal(source.version, '0.6.0')
  assert.equal(source.commit, '2098279964046e23bad86d9f42f41a3b06dca735')
  assert.deepEqual(source.localModifications, [])
  async function files(url, prefix = '') {
    const result = []
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const path = join(prefix, entry.name)
      if (entry.isDirectory()) result.push(...await files(new URL(`${entry.name}/`, url), path))
      else if (path !== 'source.json') result.push(path)
    }
    return result.sort()
  }
  assert.deepEqual(await files(directory), Object.keys(source.files).sort(), 'img-fx source file set changed')
  for (const [path, expected] of Object.entries(source.files)) {
    const actual = createHash('sha256').update(await readFile(new URL(path, directory))).digest('hex')
    assert.equal(actual, expected, `img-fx source identity mismatch: ${path}`)
  }
  return source
}
