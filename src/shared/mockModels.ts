import { ModelRecordSchema, validateWithCapabilities, type Asset, type ModelCapabilities, type ModelRecord, type PublicModel, type TaskSnapshot } from './contracts'

const ratios = [[1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [3, 2], [2, 3], [4, 5], [5, 4], [21, 9]] as const
// Exact integer ratios avoid offering combinations unsupported by a preset.
const imageSizes = [1024, 2048, 4096].flatMap((side) => ratios.map(([w, h]) => {
  const unit = Math.floor(side / Math.max(w, h))
  return `${unit * w}x${unit * h}`
}))
const counts = Array.from({ length: 10 }, (_, index) => index + 1)
function preset(id: string, name: string, kind: 'image' | 'video', sizes: string[], seconds: number[] = [], secondsRange?: ModelCapabilities['secondsRange']): PublicModel {
  return {
    id, name, kind, model_id: `dsh-canvas-mock-${id}`, api_base: 'http://mock.invalid',
    protocol: kind === 'image' ? 'openai-image' : 'openai-video', has_api_key: false, api_key_mask: '',
    capabilities: { sizes, counts, seconds, ...(secondsRange ? { secondsRange } : {}), referenceKinds: ['image'], maxReferences: kind === 'image' ? 16 : 1, supportsAudioToggle: false },
  }
}
export const MOCK_MODELS: readonly PublicModel[] = [
  preset('00000000-0000-4000-a000-000000000001', 'Mock Image · 标准', 'image', imageSizes),
  preset('00000000-0000-4000-a000-000000000002', 'Mock Image · 精简', 'image', ['1024x1024', '1008x567', '567x1008']),
  preset('00000000-0000-4000-a000-000000000003', 'Mock Video', 'video', ['1280x720', '720x1280'], [4, 8, 12]),
  preset('00000000-0000-4000-a000-000000000004', 'Mock Video · 区间', 'video', ['1280x720', '720x1280'], [], { min: 0, max: 12, step: 1 }),
]
export function mockModel(id: string): PublicModel | undefined { return MOCK_MODELS.find((model) => model.id === id) }
export function mockRecord(id: string): ModelRecord {
  const model = mockModel(id)
  if (!model) throw new Error('请选择 Mock 模型')
  const { capabilities: _c, has_api_key: _k, api_key_mask: _m, ...record } = model
  return ModelRecordSchema.parse(record)
}
export function isMockModel(record: { id: string; kind: string; name: string; model_id: string; api_base: string; protocol: string }): boolean {
  const model = mockModel(record.id)
  return !!model && ['kind', 'name', 'model_id', 'api_base', 'protocol'].every((key) => record[key as keyof ModelRecord] === model[key as keyof ModelRecord])
}
export function validateMockGeneration(snapshot: TaskSnapshot, assets: readonly Asset[]): void {
  if (!isMockModel(snapshot.model)) throw new Error('请选择 Mock 模型')
  validateWithCapabilities(snapshot, assets, mockModel(snapshot.model.id)!.capabilities)
}
