import { NodeLabels, defaultParams, defaultTtsParams, type CanvasGraph, type CanvasNode, type PublicModel } from './contracts'

/** Shared by the three canvas entrances and the Agent's validated creation tool. */
export const CREATABLE_NODES = [
  { kind: 'image-generation', icon: 'image' },
  { kind: 'video-generation', icon: 'video' },
  { kind: 'tts-generation', icon: 'tts' },
] as const
export type CreatableNodeKind = typeof CREATABLE_NODES[number]['kind']
export function nodeFor(graph: CanvasGraph, kind: CreatableNodeKind, position: { x: number; y: number }, model?: PublicModel): CanvasNode {
  return {
    id: crypto.randomUUID(), kind, title: `${NodeLabels[kind]} ${graph.nodes.filter((node) => node.kind === kind).length + 1}`,
    position, modelId: model?.id ?? null,
    params: kind === 'tts-generation' ? defaultTtsParams() : model ? defaultParams(model) : null,
    prompt: '', assetId: null, selectedResultId: null,
  }
}
