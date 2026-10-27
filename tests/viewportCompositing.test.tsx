// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ReactFlowProvider, useStoreApi } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewportCompositing } from '../src/client/viewportCompositing'
import { useViewportCompositing } from '../src/client/useViewportCompositing'

let reactRoot: Root | undefined
afterEach(() => {
  if (reactRoot) act(() => reactRoot!.unmount())
  reactRoot = undefined
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren()
})
function setup() {
  vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const root = document.createElement('div'); document.body.append(root)
  const controller = new ViewportCompositing(root, [0, 0, 1])
  return { root, controller }
}
describe('viewport compositing and scale changes', () => {
  it('releases idle hints, temporarily promotes pan and removes the hint on the first zoom step', () => {
    const { root, controller } = setup()
    expect(root.dataset.viewportMotion).toBe('idle')
    controller.update([10, 20, 1]); expect(root.dataset.viewportMotion).toBe('pan')
    controller.update([11, 25, 1.01]); expect(root.dataset.viewportMotion).toBe('zoom')
    controller.update([20, 30, 1.01]); expect(root.dataset.viewportMotion).toBe('zoom')
    vi.advanceTimersByTime(200); expect(root.dataset.viewportMotion).toBe('idle')
    controller.update([25, 30, 1.01]); expect(root.dataset.viewportMotion).toBe('pan')
    vi.advanceTimersByTime(200); expect(root.dataset.viewportMotion).toBe('idle')
    controller.destroy()
  })
  it('tracks fractional zoom and resets the settle timer without promoting a mixed gesture', () => {
    const { root, controller } = setup()
    controller.update([0, 0, 1.0001]); expect(root.dataset.viewportMotion).toBe('zoom')
    vi.advanceTimersByTime(150)
    controller.update([10.25, -15.5, 2.5]); vi.advanceTimersByTime(150)
    expect(root.dataset.viewportMotion).toBe('zoom')
    controller.update([10.25, -15.5, 2.5]); vi.advanceTimersByTime(50)
    expect(root.dataset.viewportMotion).toBe('idle')
    controller.destroy(); expect(vi.getTimerCount()).toBe(0)
  })
  it('does not overwrite transforms or rebuild media and cancels all late work on disposal', () => {
    const { root, controller } = setup()
    root.innerHTML = '<div class="react-flow__viewport" style="transform:translate(10px,20px) scale(2)"><audio></audio><span>文字</span></div>'
    const viewport = root.firstElementChild as HTMLElement
    const audio = viewport.querySelector('audio')
    const original = viewport.style.transform
    for (const zoom of [1.2, 1.5, 2, 2.5, .75]) controller.update([30, 40, zoom])
    expect(viewport.style.transform).toBe(original); expect(viewport.querySelector('audio')).toBe(audio)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    controller.update([40, 40, .75])
    expect(root.dataset.viewportMotion).toBe('idle'); expect(vi.getTimerCount()).toBe(0)
    controller.destroy(); controller.update([40, 50, 3]); vi.runAllTimers()
    expect(root.dataset.viewportMotion).toBeUndefined(); expect(vi.getTimerCount()).toBe(0)
  })
  it('only applies the CSS hint for verified hardware during fixed-scale panning', () => {
    const sheet = postcss.parse(readFileSync('src/client/styles.css', 'utf8'))
    const root = document.createElement('div'); root.className = 'dc-canvas-area'
    const viewport = document.createElement('div'); viewport.className = 'react-flow__viewport'; root.append(viewport); document.body.append(root)
    const computed = () => {
      const values: Record<string, string> = {}
      sheet.walkRules((rule) => {
        if (rule.selector.includes('.react-flow__viewport') && viewport.matches(rule.selector))
          rule.walkDecls((decl) => { values[decl.prop] = decl.value })
      })
      return values
    }
    for (const hardware of ['enabled', 'disabled']) for (const motion of ['idle', 'zoom', 'pan']) {
      root.dataset.gpuCompositing = hardware; root.dataset.viewportMotion = motion
      expect(computed()['will-change']).toBe(hardware === 'enabled' && motion === 'pan' ? 'transform' : 'auto')
      expect(computed().translate).toBe('none'); expect(computed().transform).toBeUndefined()
    }
  })
  it('observes actual React Flow store transforms without per-frame React renders and cleans up on hardware fallback', () => {
    vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    let store: ReturnType<typeof useStoreApi>, renders = 0
    function Probe({ enabled }: { enabled: boolean }) {
      renders++
      const root = useRef<HTMLDivElement>(null)
      store = useStoreApi(); useViewportCompositing(root, enabled)
      return <div ref={root} data-test-root><audio /></div>
    }
    const container = document.createElement('div'); document.body.append(container); reactRoot = createRoot(container)
    const render = (enabled: boolean) => act(() => reactRoot!.render(<ReactFlowProvider><Probe enabled={enabled} /></ReactFlowProvider>))
    render(true)
    const root = container.querySelector<HTMLElement>('[data-test-root]')!; const audio = root.querySelector('audio')
    const count = renders
    act(() => store!.setState({ transform: [10, 20, 1] }))
    expect(root.dataset.viewportMotion).toBe('pan')
    for (const scale of [1.1, 1.3, 1.5, 2.5]) act(() => store!.setState({ transform: [20, 20, scale] }))
    expect(root.dataset.viewportMotion).toBe('zoom'); expect(renders).toBe(count)
    act(() => window.dispatchEvent(new Event('blur'))); expect(root.dataset.viewportMotion).toBe('idle')
    render(false); expect(root.dataset.viewportMotion).toBeUndefined()
    act(() => store!.setState({ transform: [25, 20, 2.5] }))
    expect(root.dataset.viewportMotion).toBeUndefined(); expect(root.querySelector('audio')).toBe(audio)
    expect(vi.getTimerCount()).toBe(0)
  })
})
