import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer as createViteServer } from 'vite'
import { CanvasService } from '../host/service'

const port = Number(process.env.CANVAS_PORT ?? 5173)
const host = '127.0.0.1'
const base = `http://${host}:${port}`
const token = randomBytes(32).toString('hex')
const service = new CanvasService({
  dataDir: resolve(process.env.CANVAS_DATA_DIR ?? '.dev-data'),
  maxConcurrentTasks: 2, pollIntervalMs: 3000, requestTimeoutMs: 120000,
  maxMediaBytes: 200 * 1024 * 1024, maxReferenceBytes: 20 * 1024 * 1024,
})
await service.init()
const vite = await createViteServer({ server: { middlewareMode: true, fs: { strict: true } }, appType: 'spa' })
const server = createServer(async (request, response) => {
  const allowedHost = [ `${host}:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')
  const origin = request.headers.origin
  if (!allowedHost || (origin && ![base, `http://localhost:${port}`].includes(origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
    response.writeHead(403); response.end('Forbidden'); return
  }
  if (request.url?.startsWith('/api/canvas/')) {
    const cookie = /(?:^|; )dc_session=([a-f0-9]+)/.exec(request.headers.cookie ?? '')?.[1] ?? ''
    if (cookie.length !== token.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(token)) || (request.method === 'POST' && !origin)) {
      response.writeHead(403); response.end('Open the local canvas page first'); return
    }
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const body = ['GET', 'HEAD'].includes(request.method ?? '') ? undefined : Readable.toWeb(request)
      const init = { method: request.method, headers, ...(body ? { body, duplex: 'half' } : {}) } as RequestInit
      const result = await service.handle(new Request(`${base}${request.url}`, init))
      response.writeHead(result.status, Object.fromEntries(result.headers))
      if (result.body) {
        const stream = Readable.fromWeb(result.body as import('node:stream/web').ReadableStream)
        response.on('close', () => stream.destroy())
        stream.on('error', () => response.destroy())
        stream.pipe(response)
      } else response.end()
    } catch { response.writeHead(500); response.end('Local request failed') }
    return
  }
  if (request.method === 'GET' && request.url === '/') response.setHeader('Set-Cookie', `dc_session=${token}; HttpOnly; SameSite=Strict; Path=/`)
  vite.middlewares(request, response, () => { response.writeHead(404); response.end() })
})
server.listen(port, host, () => console.log(`Canvas: ${base}\nData: ${service.config.dataDir}`))
async function stop() {
  server.close()
  await vite.close()
  await service.close()
  process.exit()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
