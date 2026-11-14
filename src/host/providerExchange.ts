import { Buffer } from 'node:buffer'
import { diagnosticHeaders, redactDiagnosticText, type ProviderExchange, type ProviderExchangeStep, type ProviderHttpMessage } from '../shared/taskDiagnostics'

export interface ProviderExchangeWriter {
  recordProviderExchange?(taskId: string, exchange: ProviderExchange): Promise<void>
}

/** Records the same serialized body handed to fetch; tracing never submits another request. */
export async function fetchWithExchange(
  store: ProviderExchangeWriter, trace: { taskId: string; step: ProviderExchangeStep } | undefined,
  url: string | URL, init: RequestInit, secrets: string[], limit: number,
): Promise<Response> {
  if (!trace || !store.recordProviderExchange) return fetch(url, init)
  const request = new Request(url, init)
  const bytes = request.body ? Buffer.from(await request.arrayBuffer()) : null
  if (bytes) request.headers.set('content-length', String(bytes.byteLength))
  const message = (headers: Headers, body: Buffer | null, truncated = false): ProviderHttpMessage => {
    const contentType = headers.get('content-type') ?? ''
    const text = /(?:json|text\/|xml|javascript|x-www-form-urlencoded)/i.test(contentType)
      || !contentType && body !== null && !body.includes(0) && Buffer.from(body.toString('utf8')).equals(body)
    return { headers: diagnosticHeaders(headers, secrets), body: body === null ? null
      : text ? redactDiagnosticText(body.toString('utf8'), secrets) : body.toString('base64'),
    encoding: text ? 'utf8' : 'base64', ...(truncated ? { truncated: true } : {}) }
  }
  const exchange: ProviderExchange = {
    step: trace.step, time: Date.now(), url: redactDiagnosticText(request.url, secrets), method: request.method,
    request: message(request.headers, bytes),
  }
  const save = async () => { try { await store.recordProviderExchange!(trace.taskId, exchange) } catch { /* Diagnostics must not change task execution. */ } }
  await save()
  let response: Response
  try {
    response = await fetch(url, { ...init, headers: Object.fromEntries(request.headers),
      ...(bytes && init.body instanceof FormData ? { body: new Uint8Array(bytes) } : {}) })
  } catch (error) {
    exchange.error = redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets)
    await save(); throw error
  }
  exchange.response = { ...message(response.headers, null, !!response.body), status: response.status, statusText: response.statusText }
  await save()
  if (!response.body) return response
  // A single consuming stream keeps audio downloads streaming; it also captures non-JSON errors.
  const reader = response.body.getReader()
  const chunks: Buffer[] = []; let size = 0; let truncated = false
  const finish = async () => {
    exchange.response = { ...message(response.headers, Buffer.concat(chunks), truncated),
      status: response.status, statusText: response.statusText }
    await save()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { await finish(); controller.close(); return }
        const remaining = Math.max(0, limit - size)
        if (remaining) chunks.push(Buffer.from(next.value.subarray(0, remaining)))
        size += next.value.byteLength; truncated ||= size > limit
        controller.enqueue(next.value)
      } catch (error) {
        exchange.error = redactDiagnosticText(error instanceof Error ? error.message : String(error), secrets)
        await finish(); controller.error(error)
      }
    },
    async cancel(reason) { truncated = true; await reader.cancel(reason).catch(() => {}); await finish() },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
