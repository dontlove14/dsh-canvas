// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TaskDiagnosisCard, taskDiagnosisDefinition } from '../src/client/chatTaskDiagnosis'
import { TASK_ISSUES_URL, type TaskDiagnosis } from '../src/shared/taskFailure'

const diagnosis: TaskDiagnosis = {
  taskId: crypto.randomUUID(), status: 'failed', category: 'plugin', title: '插件程序问题',
  reason: '插件处理任务时出现程序错误。', suggestion: '请反馈给作者。', evidence: [],
}
it('renders a fixed author feedback button only for a plugin diagnosis and replays without requests', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const box = document.body.appendChild(document.createElement('div')), root = createRoot(box)
  try {
    act(() => root.render(<TaskDiagnosisCard node={{ data: diagnosis } as any} />))
    expect(box.querySelector('a')?.href).toBe(TASK_ISSUES_URL)
    expect(box.querySelector('a')?.rel).toContain('noopener')
    act(() => root.render(<TaskDiagnosisCard node={{ data: { ...diagnosis, category: 'unknown' } } as any} />))
    expect(box.querySelector('a')).toBeNull()
  } finally { act(() => root.unmount()); box.remove(); vi.unstubAllGlobals() }
})
it('accepts only validated successful diagnostic receipts and rejects injected links or success tasks', () => {
  const ctx = { state: null } as any
  const result = (value: unknown, isError = false) => ({ event: { type: 'tool/result', data: { message: { isError,
    content: [{ type: 'text', text: JSON.stringify({ diagnosis: value }) }] } } } }) as any
  expect(taskDiagnosisDefinition.match({ type: 'tool/call', data: { name: 'canvas_task_diagnose', callId: 'actual' } } as any)).toEqual({ id: 'actual', role: 'start' })
  expect(taskDiagnosisDefinition.match({ type: 'tool/call', data: { name: 'canvas_task', callId: 'other' } } as any)).toBeNull()
  expect(taskDiagnosisDefinition.update(ctx, result(diagnosis))).toEqual(diagnosis)
  expect(taskDiagnosisDefinition.update(ctx, result({ ...diagnosis, issuesUrl: 'https://evil.test' }))).toBeNull()
  expect(taskDiagnosisDefinition.update(ctx, result({ ...diagnosis, status: 'completed' }))).toBeNull()
  expect(taskDiagnosisDefinition.update(ctx, result(diagnosis, true))).toBeNull()
})
