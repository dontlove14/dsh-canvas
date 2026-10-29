// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaLoadingEffect } from '../src/client/MediaLoadingEffect'
import { NodeLoading, NodeLoadingContext } from '../src/client/NodeLoading'

// Exercise img-fx's real components, shaders, theme and shared scheduler.
// Only the unavailable jsdom GPU driver is replaced.
const gpu = vi.hoisted(() => ({
  created: 0, disposed: 0, fail: false,
  draws: [] as Array<{ background: number[]; colors: number[][]; effect: number }>,
}))
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>()
  return { ...actual, WebGLRenderer: class {
    ratio = 1
    domElement: HTMLCanvasElement
    constructor(options: { canvas: HTMLCanvasElement }) {
      if (gpu.fail) throw new Error('GPU unavailable')
      gpu.created++; this.domElement = options.canvas
    }
    setPixelRatio(value: number) { this.ratio = value }
    getPixelRatio() { return this.ratio }
    setClearColor() {}
    getContext() { return {} }
    setSize(width: number, height: number) {
      this.domElement.width = width * this.ratio; this.domElement.height = height * this.ratio
    }
    setViewport() {}
    setScissor() {}
    setScissorTest() {}
    render(scene: import('three').Scene) {
      const material = (scene.children[0] as import('three').Mesh).material as import('three').ShaderMaterial
      const uniforms = material.uniforms
      gpu.draws.push({
        background: uniforms.u_cardBg.value.toArray(),
        colors: Array.from({ length: 7 }, (_, i) => uniforms[`u_color${i + 1}`].value.toArray()),
        effect: uniforms.u_effect.value,
      })
    }
    dispose() { gpu.disposed++ }
  } }
})
const roots: Root[] = []
const frames = new Map<number, FrameRequestCallback>()
const intersections = new Map<Element, (visible: boolean) => void>()
beforeEach(() => {
  gpu.created = 0; gpu.disposed = 0; gpu.fail = false; gpu.draws.length = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('WebGL2RenderingContext', class {})
  vi.stubGlobal('ResizeObserver', class { observe() {}; disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class {
    targets: Element[] = []
    constructor(private notify: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe(element: Element) {
      this.targets.push(element)
      intersections.set(element, (visible) => this.notify([{ isIntersecting: visible }]))
      this.notify([{ isIntersecting: true }])
    }
    disconnect() { this.targets.forEach((element) => intersections.delete(element)) }
  })
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (value: number) => frames.delete(value))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180, toJSON() {},
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { canvas: this, clearRect() {}, drawImage() {}, save() {}, restore() {}, setTransform() {} } as unknown as CanvasRenderingContext2D
  })
})
afterEach(() => {
  act(() => roots.splice(0).forEach((root) => root.unmount()))
  document.body.replaceChildren(); frames.clear(); intersections.clear()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount(element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  act(() => root.render(element))
  return { container, root }
}
function tick() {
  act(() => {
    const callbacks = [...frames.entries()]
    callbacks.forEach(([id, callback]) => { frames.delete(id); callback(performance.now() + 1000) })
  })
}
describe('libraries.dev image media loading', () => {
  it('renders the real pixel shader with monochrome Harness light/dark surfaces without remount or media fetch', () => {
    const fetch = vi.spyOn(window, 'fetch')
    const view = (theme: 'light' | 'dark', surface: string) =>
      <MediaLoadingEffect theme={theme} surface={surface} paused={false} radius={10} />
    const { container, root } = mount(view('light', '#f5f5f5'))
    const shader = container.querySelector('canvas.image-gen-shader')
    expect(shader).toBeTruthy()
    expect(container.querySelector('.image-gen-root')?.getAttribute('data-preset')).toBe('pixels-organic')
    expect(container.querySelector('.image-gen-root')?.getAttribute('data-theme')).toBe('light')
    expect(container.querySelector('[data-loading-fallback]')).toBeNull()
    const light = gpu.draws.at(-1)!
    expect(light.background).toEqual(Array(3).fill(245 / 255))
    expect(light.colors.every(([r, g, b]) => r === g && g === b)).toBe(true)
    act(() => root.render(view('dark', '#202023')))
    const dark = gpu.draws.at(-1)!
    expect(dark.background).toEqual([32 / 255, 32 / 255, 35 / 255])
    expect(dark.colors).not.toEqual(light.colors)
    expect(container.querySelector('canvas.image-gen-shader')).toBe(shader)
    expect(gpu.created).toBe(1); expect(fetch).not.toHaveBeenCalled()
  })
  it('shares one renderer and frame loop across media nodes, sleeps while paused/offscreen and releases the final GPU', () => {
    const view = (paused: boolean, count = 3) => <>{Array.from({ length: count }, (_, i) =>
      <MediaLoadingEffect key={i} theme="dark" surface="#202023" paused={paused} radius={10} />)}</>
    const { container, root } = mount(view(false))
    tick()
    expect(gpu.created).toBe(1); expect(frames.size).toBe(1)
    expect(container.querySelectorAll('.image-gen-shader')).toHaveLength(3)
    act(() => root.render(view(true)))
    tick()
    expect(frames.size).toBe(0)
    const draws = gpu.draws.length
    tick(); expect(gpu.draws).toHaveLength(draws)
    act(() => root.render(view(false)))
    tick(); expect(frames.size).toBe(1); expect(gpu.draws.length).toBeGreaterThan(draws)
    act(() => intersections.forEach((notify) => notify(false)))
    tick(); expect(frames.size).toBe(0)
    act(() => intersections.forEach((notify) => notify(true)))
    tick(); expect(frames.size).toBe(1)
    act(() => root.render(view(false, 1)))
    expect(gpu.disposed).toBe(0)
    act(() => root.render(null))
    expect(gpu.disposed).toBe(1); expect(frames.size).toBe(0); expect(intersections.size).toBe(0)
  })
  it('uses the dependency for the common media phase with one accessible status and no task Orb/Beam', () => {
    const { container, root } = mount(<NodeLoadingContext.Provider value={{ theme: 'light', ink: '#202023', surface: '#ffffff', paused: true }}>
      <NodeLoading title="视频" mediaLoading />
    </NodeLoadingContext.Provider>)
    tick()
    expect(container.querySelector('.image-gen-root[data-theme="light"][data-paused="true"]')).toBeTruthy()
    expect(container.querySelector('[data-beam]')).toBeNull()
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('正在加载媒体')
    expect(container.querySelector('[role="status"]')?.classList.contains('dc-sr-only')).toBe(true)
    expect(frames.size).toBe(0)
    act(() => root.render(<NodeLoading title="视频" />))
    expect(gpu.disposed).toBe(1); expect(container.childElementCount).toBe(0)
  })
  it('retains a static monochrome indicator when WebGL2 is unsupported', () => {
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    const { container } = mount(<MediaLoadingEffect theme="light" surface="#ffffff" paused={false} radius={10} />)
    expect(container.querySelector('[data-loading-fallback="webgl"] svg')).toBeTruthy()
    expect(container.querySelector('canvas')).toBeNull()
    expect(gpu.created).toBe(0); expect(frames.size).toBe(0)
  })
  it('isolates a GPU initialization failure without breaking the node or leaving frames running', () => {
    gpu.fail = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = mount(<MediaLoadingEffect theme="dark" surface="#202023" paused={false} radius={10} />)
    expect(container.querySelector('[data-loading-fallback="webgl"]')).toBeTruthy()
    expect(gpu.created).toBe(0); expect(frames.size).toBe(0)
  })
})
