import sdk from './vendor/volcengine-signer.cjs'
import { REVIEW_PROVIDERS, ReviewAssetIdSchema, ReviewGroupIdSchema, type ReviewProvider } from '../../shared/seedanceReview'
import { CanvasError } from '../store'

export interface ReviewCredentials { projectName: string; accessKeyId: string; accessKeySecret: string }
export type ReviewAction = 'CreateAssetGroup' | 'CreateAsset' | 'GetAsset' | 'GetAssetGroup' | 'ListAssets' | 'ListAssetGroups'
export interface ReviewTransport {
  call(provider: ReviewProvider, credentials: ReviewCredentials, action: ReviewAction, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, any>>
}
export class ReviewFailure extends Error {
  constructor(message: string, readonly code: string, readonly definitive = false) { super(message) }
}
export function cleanReviewError(value: unknown, secrets: string[] = []): string {
  let text = typeof value === 'string' ? value : '预审服务暂不可用'
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏]')
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[地址已隐藏]')
    .replace(/(?:HMAC-SHA256|Bearer)\s+[^\r\n]+/gi, '[凭据已隐藏]')
    .replace(/(?:Authorization|Signature|Token|AccessKey|SecretKey)\s*[:=]\s*[^,\s]+/gi, '[凭据已隐藏]').slice(0, 500)
}
export function signReviewRequest(provider: ReviewProvider, credentials: ReviewCredentials, action: ReviewAction,
  payload: Record<string, unknown>, date = new Date()) {
  const target = REVIEW_PROVIDERS.find((item) => item.id === provider)!
  const body = JSON.stringify({ ...payload, ProjectName: credentials.projectName })
  const headers: Record<string, string> = { Host: target.host, 'Content-Type': 'application/json' }
  const Signer = (typeof sdk === 'function' ? sdk : sdk.default) as typeof sdk.default
  const signer = new Signer({ region: target.region, method: 'POST', pathname: '/',
    params: { Action: action, Version: '2024-01-01' }, headers, body }, 'ark')
  signer.addAuthorization({ accessKeyId: credentials.accessKeyId, secretKey: credentials.accessKeySecret }, date)
  return { url: `https://${target.host}/?Action=${action}&Version=2024-01-01`, body, headers }
}
export class OfficialReviewTransport implements ReviewTransport {
  constructor(private timeoutMs: number) {}
  async call(provider: ReviewProvider, credentials: ReviewCredentials, action: ReviewAction, payload: Record<string, unknown>, signal: AbortSignal) {
    const signed = signReviewRequest(provider, credentials, action, payload)
    const response = await fetch(signed.url, { method: 'POST', body: signed.body, headers: signed.headers, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) })
    let result: Record<string, any> = {}
    if (response.body) {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []; let bytes = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          bytes += next.value.length
          if (bytes > 1024 * 1024) throw new ReviewFailure('预审响应超过大小限制', 'RESPONSE_TOO_LARGE')
          chunks.push(next.value)
        }
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
    }
    const error = result.ResponseMetadata?.Error
    if (!response.ok || error) throw new ReviewFailure(
      cleanReviewError(error?.Message ?? `预审服务返回 HTTP ${response.status}`, Object.values(credentials)),
      cleanReviewError(error?.Code ?? `HTTP_${response.status}`, Object.values(credentials)),
      (response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status))
      || (!!error && /^(Invalid|Missing|Unauthorized|Forbidden|AccessDenied|Authentication|Signature|Permission|ResourceNotFound)/i.test(error.Code ?? '')))
    const metadata = result.ResponseMetadata
    const target = REVIEW_PROVIDERS.find((item) => item.id === provider)!
    if (metadata && (metadata.Action && metadata.Action !== action || metadata.Region && metadata.Region !== target.region
      || metadata.Service && metadata.Service !== 'ark' || metadata.Version && metadata.Version !== '2024-01-01'))
      throw new ReviewFailure('预审响应上下文不匹配', 'RESPONSE_MISMATCH')
    if (!result.Result || typeof result.Result !== 'object') throw new ReviewFailure('预审响应缺少 Result', 'RESPONSE_INVALID')
    return result.Result
  }
}
export function officialId(value: unknown, kind: 'asset' | 'group'): string {
  const result = (kind === 'asset' ? ReviewAssetIdSchema : ReviewGroupIdSchema).safeParse(value)
  if (!result.success) throw new ReviewFailure('预审服务返回的 ID 无效', 'ID_INVALID')
  return result.data
}
export function assertGroup(result: Record<string, any>, id: string, project: string, type: string): void {
  if (officialId(result.Id, 'group') !== id || result.ProjectName !== project || result.GroupType !== type)
    throw new CanvasError('素材组类型、项目或身份不匹配', 409, 'GROUP_MISMATCH')
}
