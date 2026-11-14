import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { canAskTaskAgent, diagnoseTaskFailure, exchangeFailureEvidence, safeFailureText, type TaskFailureEvidence } from '../src/shared/taskFailure'
import type { ProviderExchange } from '../src/shared/taskDiagnostics'

const evidence = (change: Partial<TaskFailureEvidence> = {}): TaskFailureEvidence => ({
  taskId: randomUUID(), status: 'failed', kind: 'generation', modelName: 'model', providerName: 'provider', phase: 'failed',
  failureStage: 'submit', failureCode: 'PROVIDER_ERROR', failureMessage: null, savedResults: 0, exchanges: [], attempts: [], recordsIncomplete: false, programError: false, ...change,
})
const exchange = (body: string, status = 400): ProviderExchange => ({
  step: 'submit', time: 1, url: 'https://provider.test?token=private', method: 'POST',
  request: { body: '{"prompt":"完整原文","api_key":"hidden"}', headers: { authorization: 'Bearer hidden' }, encoding: 'utf8' },
  response: { body, headers: { 'x-request-id': 'real-request', 'set-cookie': 'hidden' }, encoding: 'utf8', status, statusText: '' },
})
describe('task diagnosis evidence and responsibility', () => {
  it.each(['completed', 'submitted', 'queued', 'generating', 'saving', 'unknown', 'abandoned'] as const)('hides ask actions for %s', (status) => {
    expect(canAskTaskAgent(status)).toBe(false)
  })
  it.each([
    ['{"error":{"message":"insufficient balance"}}', '余额'],
    ['{"error":{"message":"invalid API key"}}', '密钥验证'],
    ['{"error":{"message":"参考图内容审核未通过"}}', '参考图'],
  ])('explains explicit provider error %s faithfully', (body, expected) => {
    const raw = exchangeFailureEvidence(exchange(body))
    const result = diagnoseTaskFailure(evidence({ exchanges: [raw] }))
    expect(result.category).toBe('provider'); expect(result.reason).toContain(expected)
    expect(raw.requestId).toBe('real-request')
    expect(JSON.stringify(raw)).not.toMatch(/完整原文|hidden|https|cookie|authorization/)
  })
  it('does not attribute a bare 403, provider exception, timeout or disk fault to either party', () => {
    for (const input of [
      evidence({ exchanges: [exchangeFailureEvidence(exchange('', 403))] }),
      evidence({ failureMessage: 'request timed out' }),
      evidence({ status: 'save_failed', failureStage: 'storage', failureMessage: 'ENOSPC: no space left on device' }),
    ]) expect(diagnoseTaskFailure(input).category).toBe('unknown')
  })
  it('keeps partial results and save failures distinct and attributes only explicit programming faults', () => {
    const partial = diagnoseTaskFailure(evidence({ failureStage: 'provider', failureCode: 'PARTIAL_RESULT', failureMessage: '请求 4 张，已保存 2 张', savedResults: 2 }))
    expect(partial.reason).toContain('已保存 2 张'); expect(partial.suggestion).toContain('已保存')
    const saving = diagnoseTaskFailure(evidence({ status: 'save_failed', failureStage: 'storage', failureMessage: "Cannot read properties of undefined (reading 'id')", programError: true }))
    expect(saving.category).toBe('plugin'); expect(saving.reason).toContain('生成已返回结果')
    const unrelated = diagnoseTaskFailure(evidence({ status: 'save_failed', failureStage: 'storage', failureMessage: '下载中断',
      exchanges: [exchangeFailureEvidence(exchange('账户额度不足'))] }))
    expect(unrelated.category).toBe('unknown')
    expect(diagnoseTaskFailure(evidence({ failureMessage: "Cannot read properties of undefined (reading 'id')" })).category).toBe('unknown')
  })
  it('does not turn successful messages, media, html or truncated responses into provider errors', () => {
    for (const record of [
      exchange('{"message":"success","data":{"url":"https://result.test"}}', 200),
      exchange('<html>proxy error</html>', 403),
      { ...exchange('private', 400), response: { ...exchange('').response!, encoding: 'base64' as const, body: 'cHJpdmF0ZQ==' } },
      { ...exchange('{"error":"bad"}'), response: { ...exchange('{"error":"bad"}').response!, truncated: true } },
    ]) expect(exchangeFailureEvidence(record).message).toBeUndefined()
  })
  it('strips credentials, signed URLs, local paths and long media strings from diagnostic excerpts', () => {
    const result = safeFailureText('API_KEY=secret123 Bearer secret456 https://host.test/a?signature=private /Users/me/private.png sk-privatecredential123 ' + 'A'.repeat(900))
    expect(result).not.toMatch(/secret123|secret456|privatecredential|signature|Users\/me|A{160}/)
    expect(result.length).toBeLessThan(1200)
  })
})
