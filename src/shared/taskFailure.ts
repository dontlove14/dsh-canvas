import { z } from 'zod'
import type { ProviderExchange, ProviderExchangeStep } from './taskDiagnostics'
import type { TaskStatus } from './contracts'

export const TASK_ISSUES_URL = 'https://github.com/dontlove14/dsh-canvas/issues'
export const canAskTaskAgent = (status?: TaskStatus) => status === 'failed' || status === 'save_failed'
const shortText = z.string().max(1200)
export const TaskDiagnosisSchema = z.object({
  taskId: z.string().uuid(), status: z.enum(['failed', 'save_failed']),
  category: z.enum(['provider', 'plugin', 'unknown']),
  title: shortText, reason: shortText, suggestion: shortText,
  evidence: z.array(shortText).max(8),
}).strict()
export type TaskDiagnosis = z.infer<typeof TaskDiagnosisSchema>
export interface FailureExchangeEvidence {
  step: ProviderExchangeStep; time: number; status?: number; code?: string; message?: string; requestId?: string
  incomplete: boolean
}
export interface TaskFailureEvidence {
  taskId: string; status: TaskStatus; kind: string; modelName: string; providerName: string
  phase: string; failureStage: string | null; failureCode: string | null; failureMessage: string | null
  savedResults: number; exchanges: FailureExchangeEvidence[]
  attempts: Array<{ step: string; outcome: string | null; error: string | null }>
  recordsIncomplete: boolean; programError: boolean
}

/** The model never receives request bodies, signed URLs, headers or media payloads. */
export function safeFailureText(value: string, limit = 1200): string {
  return value.slice(0, 12000)
    .replace(/["']?(?:prompt|input_text|reference_text|提示词|输入文本)["']?\s*[:=：]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '[原文已省略]')
    .replace(/(?:https?:\/\/|file:\/\/)[^\s"'<>]+/gi, '[地址已隐藏]')
    .replace(/(?:\/Users\/|\/private\/|\/tmp\/|[A-Z]:\\)[^\s"'<>]+/g, '[路径已隐藏]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[凭据已隐藏]')
    .replace(/["']?(?:api[-_]?key|access[-_]?key(?:[-_]?secret)?|authorization|cookie|token|secret|signature|password)["']?\s*[:=]\s*["']?[^"'\s,;}]+/gi, '[凭据已隐藏]')
    .replace(/\b(?:sk-[a-z\d_-]{8,}|[a-z\d_-]{20,}\.[a-z\d_-]{20,}\.[a-z\d_-]+)\b/gi, '[凭据已隐藏]')
    .replace(/[^\s"',;]*…\[已脱敏\]…[^\s"',;]*/g, '[凭据已隐藏]')
    .replace(/[a-z\d+/=_-]{160,}/gi, '[长数据已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, limit)
}
function errorFields(value: unknown, depth = 0): { message?: string; code?: string } {
  if (depth > 5 || !value || typeof value !== 'object') return {}
  const item = value as Record<string, unknown>
  const error = item.error
  const nested = typeof error === 'object' ? errorFields(error, depth + 1) : {}
  const message = nested.message ?? [typeof error === 'string' ? error : undefined,
    item.message, item.error_message, item.errorMessage, item.status_message, item.task_status_msg]
    .find((text): text is string => typeof text === 'string' && !!text.trim())
  const code = nested.code ?? [item.code, item.error_code, item.errorCode].find((code) => typeof code === 'string' || typeof code === 'number')
  if (message) return { message: safeFailureText(message), ...(code !== undefined ? { code: safeFailureText(String(code), 160) } : {}) }
  for (const key of ['data', 'result', 'output']) {
    const result = errorFields(item[key], depth + 1)
    if (result.message) return result
  }
  return code === undefined ? {} : { code: safeFailureText(String(code), 160) }
}
export function exchangeFailureEvidence(exchange: ProviderExchange): FailureExchangeEvidence {
  const response = exchange.response
  let fields: ReturnType<typeof errorFields> = {}
  if (response?.encoding === 'utf8' && response.body && !response.truncated) {
    // Never parse binary or a large success payload just to diagnose an error.
    if (response.body.length <= 64000) {
      try {
        const value = JSON.parse(response.body)
        const rejected = (input: unknown, depth = 0): boolean => {
          if (!input || typeof input !== 'object' || depth > 5) return false
          const item = input as Record<string, unknown>
          return !!item.error || ['status', 'state', 'task_status'].some((key) => /^(?:failed|failure|error|rejected)$/i.test(String(item[key] ?? '')))
            || ['data', 'result', 'output'].some((key) => rejected(item[key], depth + 1))
        }
        if (response.status >= 400 || rejected(value)) fields = errorFields(value)
      }
      catch {
        if (response.status >= 400 && !/[<>]/.test(response.body)) fields = { message: safeFailureText(response.body) }
      }
    }
  }
  const requestId = Object.entries(response?.headers ?? {}).find(([key]) => /^(?:x-request-id|request-id|x-trace-id)$/i.test(key))?.[1]
  return {
    step: exchange.step, time: exchange.time, ...(response ? { status: response.status } : {}), ...fields,
    ...(requestId ? { requestId: safeFailureText(requestId, 160) } : {}),
    incomplete: !!response?.truncated || !response || !!exchange.error,
  }
}
export function diagnoseTaskFailure(input: TaskFailureEvidence): TaskDiagnosis {
  const saving = input.status === 'save_failed'
  const prefix = saving ? '模型生成已返回结果，但结果保存失败。' : ''
  const exchanges = input.exchanges.filter((item) => item.message && !item.incomplete && (saving ? item.step === 'publish' : item.step !== 'publish'))
  const remote = [...exchanges].reverse().find((item) => item.status !== undefined && item.status >= 400)
    ?? (input.failureStage === 'provider' ? exchanges.at(-1) : undefined)
  const failure = safeFailureText(input.failureMessage ?? '')
  const providerMessage = remote?.message ?? (input.failureStage === 'provider' ? failure : '')
  let category: TaskDiagnosis['category'] = 'unknown', reason = `${prefix}现有记录不足以确认具体原因。`
  let suggestion = '请保留任务 ID 和失败记录，补充当时的操作情况后再判断。'
  if (providerMessage && input.failureCode !== 'PARTIAL_RESULT') {
    category = 'provider'
    if (/insufficient.*(?:balance|credit|quota)|(?:balance|credit|quota).*insufficient|余额不足|额度不足|欠费/i.test(providerMessage)) {
      reason = `${prefix}模型服务提示账户余额或可用额度不足。`
      suggestion = '请检查该供应商账户的余额和额度，补充后再决定是否重新生成。'
    } else if (/invalid.*(?:api.?key|credential)|(?:api.?key|credential).*invalid|unauthorized|invalid_api_key|密钥.*(?:无效|错误|过期)|鉴权失败/i.test(providerMessage)) {
      reason = `${prefix}模型服务未通过密钥验证，当前密钥可能错误、失效或没有所需权限。`
      suggestion = '请检查该供应商的 API Key 和账户权限；不要把完整密钥发到对话或公开反馈中。'
    } else if (/content.*(?:policy|moderation|safety)|safety.*(?:check|filter)|risk.control|敏感|风控|审核未通过|内容.*(?:违规|拒绝|不合规)/i.test(providerMessage)) {
      reason = `${prefix}模型服务的内容审核拦截了这次请求。${providerMessage}`
      suggestion = '请按模型服务指出的具体内容检查提示词或参考素材，调整后再决定是否生成。'
    } else {
      reason = `${prefix}模型服务返回：${providerMessage}`
      suggestion = '请根据这条服务提示处理；需要联系供应商时可附上任务 ID 和已脱敏的原始响应。'
    }
  } else if (input.failureCode === 'PARTIAL_RESULT' && input.failureStage === 'provider') {
    category = 'provider'; reason = failure || '模型服务返回的结果数量少于请求数量。'
    suggestion = '已保存的结果仍可使用；请先检查现有结果，再决定是否补充生成。'
  } else if (input.programError && /^(?:\d+ 份结果保存失败：)?(?:TypeError|ReferenceError):|(?:Cannot read properties of (?:undefined|null)|Cannot destructure property|is not a function|is not defined)/i.test(failure)) {
    category = 'plugin'
    reason = `${prefix}插件处理任务时出现了程序错误。${failure}`
    suggestion = '请将任务 ID 和这条错误反馈给插件作者，帮助定位和修复。'
  }
  const evidence = [
    ...(failure ? [`任务记录：${failure}`] : []),
    ...input.exchanges.map((item) => `${item.step}：${item.status === undefined ? '未记录有效响应' : `HTTP ${item.status}`}${item.message ? `；${item.message}` : ''}${item.requestId ? `；请求 ID ${item.requestId}` : ''}${item.incomplete ? '；记录不完整' : ''}`),
    ...(input.recordsIncomplete ? ['部分原始记录过大、缺失或无法读取；未补造历史通信。'] : []),
  ].slice(0, 8).map((item) => safeFailureText(item))
  return TaskDiagnosisSchema.parse({ taskId: input.taskId, status: input.status, category,
    title: { provider: '模型服务返回的原因', plugin: '插件程序问题', unknown: '原因暂无法确定' }[category],
    reason: safeFailureText(reason), suggestion, evidence })
}
