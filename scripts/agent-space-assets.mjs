import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** Copy only runtime motions/posters/scenery; GLBs and source candidates stay out of the package. */
export async function buildAgentSpaceAssets(root, version) {
  const source = resolve(root, 'src/client/assets/agent_team/motions')
  const destination = resolve(root, 'lib/agent-space')
  const original = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'))
  await mkdir(destination, { recursive: true })
  const files = new Map()
  for (const action of original.actions) {
    files.set(action.video, action.verification.sha256)
    files.set(action.poster, action.posterSha256)
  }
  for (const scene of original.scenery) files.set(scene.file, scene.sha256)
  const assets = []
  for (const [file, expected] of files) {
    if (!/^[A-Za-z0-9.-]+\.(?:webm|png|svg)$/.test(file)) throw new Error(`Invalid Agent Space asset: ${file}`)
    const bytes = await readFile(resolve(source, file))
    if (!expected || digest(bytes) !== expected) throw new Error(`Agent Space identity mismatch: ${file}`)
    // The approved demo scenery has workstation captions. The live card is action-only.
    const runtime = file.endsWith('.svg') ? Buffer.from(bytes.toString('utf8').replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '')) : bytes
    await writeFile(resolve(destination, file), runtime)
    assets.push({ file, sha256: digest(runtime), bytes: runtime.length,
      mime: file.endsWith('.webm') ? 'video/webm' : file.endsWith('.png') ? 'image/png' : 'image/svg+xml' })
  }
  const manifest = { version, files: assets, roles: original.roles.map(({ id, name, color, heightScale, idleActionCode }) =>
    ({ id, name, color, heightScale, idleActionCode })),
    actions: original.actions.map(({ code, role, action, video, poster, loop, duration, size, foot, bodyHeight, hand }) =>
      ({ code, role, action, video, poster, loop, duration, size, foot, bodyHeight, ...(hand ? { hand } : {}) })),
    playbackPolicy: original.playbackPolicy }
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
