import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { capabilitiesFor, type Asset, type PublicModel } from '../src/shared/contracts'
import { BUILTIN_MODELS } from '../src/shared/modelCatalog'
import { videoReferenceLimits, validateVideoConnections } from '../src/shared/video'
import { referenceDependencyCatalog } from '../src/host/agent/references'

describe('Agent model budgets match accepted video inputs', () => {
  it.each(BUILTIN_MODELS.filter((model) => model.kind === 'video' && model.protocol !== 'openai-video'))(
    'matches each media boundary for $model_id at $api_base', (model) => {
      const publicModel = { ...model, has_api_key: true, api_key_mask: '', capabilities: capabilitiesFor(model) } as PublicModel
      const budget = videoReferenceLimits(publicModel).reference
      for (const kind of ['image', 'video', 'audio'] as const) {
        const input = (count: number) => Array.from({ length: count }, () => ({ id: randomUUID(), kind } as Asset))
        const params = { size: publicModel.capabilities.defaultSize!, n: 1, seconds: 5, videoMode: 'reference' as const }
        expect(() => validateVideoConnections(params, input(budget[kind]), model)).not.toThrow()
        expect(() => validateVideoConnections(params, input(budget[kind] + 1), model)).toThrow()
      }
      expect(budget.total).toBe(publicModel.capabilities.maxReferences)
      if (publicModel.capabilities.videoModes?.some((mode) => mode.value === 'frames')) {
        const frames = { size: publicModel.capabilities.defaultSize!, n: 1, seconds: 5, videoMode: 'frames' as const }
        expect(videoReferenceLimits(publicModel).frames).toEqual({ image: 2, video: 0, audio: 0, total: 2 })
        expect(() => validateVideoConnections(frames, [{ id: randomUUID(), kind: 'audio' } as Asset], model)).toThrow()
      }
    })
  it('uses exact result task identity and never substitutes another task, current edges or latest output for missing history', () => {
    const assetId = randomUUID(), nodeId = randomUUID(), origin = randomUUID(), older = randomUUID(), newer = randomUUID()
    const state = { graph: { nodes: [{ id: nodeId, assetId: null }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      assets: [{ id: assetId, nodeId, taskId: origin }], tasks: [
        { id: newer, nodeId, resultIds: [assetId], snapshot: { referenceIds: [newer] } },
        { id: origin, nodeId, resultIds: [assetId], snapshot: { referenceIds: [older] } },
      ] } as unknown as Parameters<typeof referenceDependencyCatalog>[0]
    expect(referenceDependencyCatalog(state)).toEqual([{ assetId, provenance: 'task-snapshot', originTaskId: origin,
      dependencies: [{ assetId: older, available: false }] }])
    state.tasks = state.tasks.filter((task) => task.id !== origin)
    expect(referenceDependencyCatalog(state)).toEqual([{ assetId, provenance: 'unavailable', dependencies: [] }])
  })
})
