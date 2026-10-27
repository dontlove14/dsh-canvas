export type GpuReason =
  | 'checking'
  | 'hardware-webgl'
  | 'hardware-webgpu'
  | 'software-renderer'
  | 'unverified'
  | 'unavailable'
  | 'unsupported-css'

export interface GpuCapability {
  /** Permission to request CSS compositing; the browser still decides layer placement. */
  enabled: boolean
  reason: GpuReason
}
interface ProbeContext {
  isContextLost(): boolean
  getExtension(name: string): unknown
  getParameter(parameter: number): unknown
}
interface ProbeCanvas {
  width: number
  height: number
  getContext(name: string, options: WebGLContextAttributes): ProbeContext | null
}
interface ProbeAdapter {
  isFallbackAdapter?: boolean
  info?: { isFallbackAdapter?: boolean }
}
export interface GpuProbeEnvironment {
  supports3dTranslate(): boolean
  createCanvas(): ProbeCanvas
  requestAdapter?: () => Promise<ProbeAdapter | null>
}

const softwareRenderer = /swiftshader|llvmpipe|softpipe|lavapipe|swrast|software|microsoft basic render|(?:\bwarp\b)/i
const hardwareRenderer = /apple|nvidia|geforce|quadro|amd|radeon|intel|adreno|qualcomm|mali|powervr|vivante|videocore|xclipse/i
const disabled = (reason: GpuReason): GpuCapability => ({ enabled: false, reason })

/** Successful WebGL creation alone does not prove that a physical GPU is being used. */
export async function probeGpu(environment: GpuProbeEnvironment): Promise<GpuCapability> {
  try {
    if (!environment.supports3dTranslate()) return disabled('unsupported-css')
  } catch { return disabled('unsupported-css') }

  let contextAvailable = false
  for (const name of ['webgl2', 'webgl']) {
    let context: ProbeContext | null = null
    try {
      const canvas = environment.createCanvas()
      canvas.width = canvas.height = 1
      context = canvas.getContext(name, {
        failIfMajorPerformanceCaveat: true,
        powerPreference: 'low-power',
        antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
      })
      if (!context || context.isContextLost()) continue
      contextAvailable = true
      const info = context.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL?: number } | null
      if (info?.UNMASKED_RENDERER_WEBGL === undefined) continue
      const renderer = context.getParameter(info.UNMASKED_RENDERER_WEBGL)
      if (typeof renderer !== 'string') continue
      if (softwareRenderer.test(renderer)) return disabled('software-renderer')
      if (hardwareRenderer.test(renderer)) return { enabled: true, reason: 'hardware-webgl' }
    } catch {
      // Privacy settings, context limits, or driver failures must not break the canvas.
    } finally {
      try {
        const release = context?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null
        release?.loseContext?.()
      } catch { /* A failed diagnostic cleanup never enables acceleration. */ }
    }
  }

  // Some browsers hide WebGL renderer details but expose a verified non-fallback WebGPU adapter.
  if (environment.requestAdapter) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const adapter = await Promise.race([
        environment.requestAdapter(),
        new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1500) }),
      ])
      if (adapter) {
        const flags = [adapter.isFallbackAdapter, adapter.info?.isFallbackAdapter]
        if (flags.includes(true)) return disabled('software-renderer')
        if (flags.includes(false)) return { enabled: true, reason: 'hardware-webgpu' }
        contextAvailable = true
      }
    } catch { /* WebGPU is optional, and detecting it does not request a device. */ }
    finally { if (timeout) clearTimeout(timeout) }
  }
  return disabled(contextAvailable ? 'unverified' : 'unavailable')
}

let browserProbe: Promise<GpuCapability> | undefined
/** Shared by the Harness entry and local development page, without persisting hardware identifiers. */
export function browserGpuCapability(): Promise<GpuCapability> {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return Promise.resolve(disabled('unavailable'))
  if (!browserProbe) {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options: { powerPreference: string }): Promise<ProbeAdapter | null> } }).gpu
    browserProbe = probeGpu({
      supports3dTranslate: () => typeof CSS !== 'undefined' && CSS.supports('translate', '0px 0px 0px'),
      createCanvas: () => document.createElement('canvas') as unknown as ProbeCanvas,
      ...(gpu ? { requestAdapter: () => gpu.requestAdapter({ powerPreference: 'low-power' }) } : {}),
    }).catch(() => disabled('unavailable'))
  }
  return browserProbe
}
