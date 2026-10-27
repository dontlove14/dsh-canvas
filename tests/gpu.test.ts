import { describe, expect, it, vi } from 'vitest'
import { probeGpu, type GpuProbeEnvironment } from '../src/client/gpu'

function environment(renderer: string | null, options: { contextLost?: boolean; css?: boolean } = {}) {
  const release = vi.fn()
  const getContext = vi.fn(() => ({
    isContextLost: () => options.contextLost ?? false,
    getExtension: (name: string) => name === 'WEBGL_debug_renderer_info'
      ? renderer === null ? null : { UNMASKED_RENDERER_WEBGL: 37446 }
      : name === 'WEBGL_lose_context' ? { loseContext: release } : null,
    getParameter: () => renderer,
  }))
  const probe: GpuProbeEnvironment = {
    supports3dTranslate: () => options.css ?? true,
    createCanvas: () => ({ width: 0, height: 0, getContext }),
  }
  return { probe, release, getContext }
}

describe('conditional GPU compositing', () => {
  it.each([
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060, OpenGL)',
    'AMD Radeon Pro 5500M OpenGL Engine',
  ])('enables a recognized hardware backend: %s', async (renderer) => {
    const { probe, release, getContext } = environment(renderer)
    expect(await probeGpu(probe)).toEqual({ enabled: true, reason: 'hardware-webgl' })
    expect(getContext).toHaveBeenCalledWith('webgl2', expect.objectContaining({ failIfMajorPerformanceCaveat: true, powerPreference: 'low-power' }))
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([
    'ANGLE (Google, Vulkan 1.3 SwiftShader Device (Subzero), SwiftShader)',
    'Mesa llvmpipe (LLVM 18.1, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver, D3D11)',
    'Intel Software Rasterizer',
  ])('rejects software backends even when WebGL succeeds: %s', async (renderer) => {
    const { probe, release } = environment(renderer)
    const requestAdapter = vi.fn(async () => ({ isFallbackAdapter: false }))
    expect(await probeGpu({ ...probe, requestAdapter })).toEqual({ enabled: false, reason: 'software-renderer' })
    expect(release).toHaveBeenCalledOnce()
    expect(requestAdapter).not.toHaveBeenCalled()
  })

  it('keeps default rendering if hardware cannot be identified', async () => {
    expect(await probeGpu(environment(null).probe)).toEqual({ enabled: false, reason: 'unverified' })
    expect(await probeGpu(environment('WebKit WebGL').probe)).toEqual({ enabled: false, reason: 'unverified' })
  })
  it('does not enable on unsupported CSS or a lost context', async () => {
    const css = environment('Apple M3', { css: false })
    expect(await probeGpu(css.probe)).toEqual({ enabled: false, reason: 'unsupported-css' })
    expect(css.getContext).not.toHaveBeenCalled()
    expect(await probeGpu(environment('Apple M3', { contextLost: true }).probe)).toEqual({ enabled: false, reason: 'unavailable' })
  })
  it('uses WebGL 1 when WebGL 2 is unavailable', async () => {
    const { probe, getContext } = environment('Apple M2')
    expect(await probeGpu({
      ...probe, createCanvas: () => ({
        width: 1, height: 1,
        getContext: (name, options) => name === 'webgl2' ? null : getContext(name, options),
      }),
    })).toEqual({ enabled: true, reason: 'hardware-webgl' })
    expect(getContext).toHaveBeenCalledWith('webgl', expect.anything())
  })
  it('uses verified non-fallback WebGPU when WebGL details are hidden', async () => {
    const { probe } = environment(null)
    expect(await probeGpu({ ...probe, requestAdapter: async () => ({ info: { isFallbackAdapter: false } }) }))
      .toEqual({ enabled: true, reason: 'hardware-webgpu' })
    expect(await probeGpu({ ...probe, requestAdapter: async () => ({ isFallbackAdapter: true }) }))
      .toEqual({ enabled: false, reason: 'software-renderer' })
    expect(await probeGpu({ ...probe, requestAdapter: async () => ({}) }))
      .toEqual({ enabled: false, reason: 'unverified' })
  })
  it('handles blocked contexts and adapter errors without breaking the page', async () => {
    const { probe } = environment(null)
    expect(await probeGpu({
      ...probe, createCanvas: () => { throw new Error('Blocked by privacy policy') },
      requestAdapter: async () => { throw new Error('Device unavailable') },
    })).toEqual({ enabled: false, reason: 'unavailable' })
  })
  it('bounds a stalled adapter request and leaves acceleration disabled', async () => {
    vi.useFakeTimers()
    try {
      const { probe } = environment(null)
      const result = probeGpu({ ...probe, requestAdapter: () => new Promise(() => {}) })
      await vi.advanceTimersByTimeAsync(1500)
      expect(await result).toEqual({ enabled: false, reason: 'unverified' })
    } finally { vi.useRealTimers() }
  })
})
