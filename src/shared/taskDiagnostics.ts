export type ProviderExchangeStep = 'submit' | 'poll' | 'publish'
export interface ProviderHttpMessage {
  headers: Record<string, string>
  body: string | null
  encoding: 'utf8' | 'base64'
  truncated?: boolean
}
export interface ProviderExchange {
  step: ProviderExchangeStep
  time: number
  url: string
  method: string
  request: ProviderHttpMessage
  response?: ProviderHttpMessage & { status: number; statusText: string }
  error?: string
}

export function maskDiagnosticSecret(value: string): string {
  const visible = Math.min(4, Math.floor((value.length - 1) / 3))
  return visible > 0 ? `${value.slice(0, visible)}…[已脱敏]…${value.slice(-visible)}` : '[已脱敏]'
}

/** Preserve provider wording while removing credentials, including echoed accepted keys. */
export function redactDiagnosticText(value: string, secrets: string[] = []): string {
  let text = value
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join(maskDiagnosticSecret(secret))
  return text.replace(/\b(Bearer|Basic)\s+([^\s"',;]+)/gi, (_, scheme, token) =>
    token.includes('[已脱敏]') || token.includes('…') ? `${scheme} ${token}` : `${scheme} ${maskDiagnosticSecret(token)}`)
}

export function diagnosticHeaders(headers: Headers, secrets: string[]): Record<string, string> {
  return Object.fromEntries([...headers].map(([name, value]) => [name,
    /authorization|cookie|api[-_]?key|token|secret|signature/i.test(name)
      ? /^(Bearer|Basic)\s/i.test(value)
        ? value.replace(/^(\S+\s+)(.*)$/, (_, scheme, token) => scheme + maskDiagnosticSecret(token))
        : maskDiagnosticSecret(value)
      : redactDiagnosticText(value, secrets)]))
}

export function formatProviderExchange(exchange: ProviderExchange, part: 'request' | 'response'): string {
  const message = exchange[part]
  const start = [
    `阶段：${exchange.step}`,
    `时间：${new Date(exchange.time).toISOString()}`,
    `请求：${exchange.method} ${exchange.url}`,
  ]
  if (!message) return [...start, '未收到响应', ...(exchange.error ? [`错误：${exchange.error}`] : [])].join('\n')
  if (part === 'response' && exchange.response) start.push(`HTTP ${exchange.response.status} ${exchange.response.statusText}`.trim())
  start.push(part === 'request' ? '请求头：' : '响应头：', ...Object.entries(message.headers).map(([key, value]) => `${key}: ${value}`),
    '', `${part === 'request' ? '请求体' : '响应体'}${message.encoding === 'base64' ? '（原始二进制的 Base64）' : ''}：`,
    message.body ?? '（无）')
  if (message.truncated) start.push('（超过记录上限，内容不完整）')
  return start.join('\n')
}
