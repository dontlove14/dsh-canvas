import { readFile } from 'node:fs/promises'
import type { AgentSpaceManifest } from '../shared/agentSpace'

/** Explicit package whitelist; this route cannot resolve arbitrary local files. */
export function agentSpaceAssets(directory = new URL('./agent-space/', import.meta.url)) {
  let manifest: Promise<AgentSpaceManifest> | undefined
  return async (request: Request) => {
    try {
      const catalog = await (manifest ??= readFile(new URL('manifest.json', directory), 'utf8').then((text): AgentSpaceManifest => JSON.parse(text)))
      const url = new URL(request.url), file = url.searchParams.get('file')
      if (!file) return Response.json(catalog, { headers: { 'Cache-Control': 'no-store' } })
      const entry = catalog.files.find((entry) => entry.file === file && entry.sha256 === url.searchParams.get('hash'))
      if (!entry || !/^[A-Za-z0-9.-]+\.(?:webm|png|svg)$/.test(entry.file))
        return new Response(null, { status: 404 })
      const headers = { 'Content-Type': entry.mime, 'Content-Length': String(entry.bytes),
        'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${entry.sha256}"`,
        'X-Content-Type-Options': 'nosniff' }
      if (request.headers.get('If-None-Match') === headers.ETag) return new Response(null, { status: 304, headers })
      return new Response(new Uint8Array(await readFile(new URL(entry.file, directory))), { headers })
    } catch {
      manifest = undefined
      return Response.json({ error: 'Agent 空间资源暂不可用' }, { status: 503 })
    }
  }
}
