import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, basename, dirname } from 'node:path'
import assert from 'node:assert/strict'

const digest = (text) => createHash('sha256').update(text).digest('hex')
async function markdown(directory) {
  const paths = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await markdown(path))
    else if (entry.name.endsWith('.md')) paths.push(path)
  }
  return paths.sort()
}
/** Validate the real packaged texts, including resource paths; the host imports the same bytes. */
export async function agentSkillIdentity(directory, version) {
  const files = await markdown(directory), skills = [], hashes = {}
  for (const path of files) hashes[path.slice(directory.length + 1)] = digest(await readFile(path))
  for (const path of files.filter((path) => basename(path) === 'SKILL.md')) {
    const raw = await readFile(path, 'utf8')
    const parsed = /^---\nname: ([a-z0-9-]{2,64})\ndescription: ([^\n]+)\n---\n([\s\S]+)$/.exec(raw)
    assert(parsed, `Invalid frontmatter ${path}`)
    const [, name, description, body] = parsed
    assert.equal(name, basename(dirname(path)))
    assert(!name.includes('--') && !description.includes(': ') && !/[<>]/.test(description))
    assert(body.includes('输入') && body.includes('交付') && body.includes('检查'), `Missing operational method ${name}`)
    const resources = {}
    for (const match of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
      const relative = join(dirname(path), match[1]).slice(directory.length + 1)
      assert(hashes[relative], `Missing resource ${relative}`)
      resources[match[1]] = hashes[relative]
    }
    skills.push({ name, description, sha256: digest(body), resources })
  }
  assert.equal(skills.length, 36)
  assert.equal(new Set(skills.map((skill) => skill.name)).size, 36)
  return { version, skills, files: hashes }
}
export async function writeAgentSkillIdentity(directory, version) {
  const identity = await agentSkillIdentity(directory, version)
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(identity, null, 2) + '\n')
  return identity
}
