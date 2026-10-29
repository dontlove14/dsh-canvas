// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { bindCanvasFileDrop, useCanvasFileDrop } from '../src/client/canvasFileDrop'

const cleanups: Array<() => void> = []
let reactRoot: Root | undefined
afterEach(async () => {
  await act(async () => reactRoot?.unmount()); reactRoot = undefined
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

function fixture() {
  const agent = document.createElement('div'), canvas = document.createElement('div'), child = document.createElement('button')
  canvas.append(child); document.body.append(agent, canvas)
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 40, 500, 500))
  // The host mask is pointer-events:none, so hit testing sees the underlying surface.
  const hit = vi.fn((x: number) => x >= 400 && x < 900 ? child : agent)
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit })
  cleanups.push(() => { delete (document as any).elementFromPoint })
  const receive = vi.fn()
  cleanups.push(bindCanvasFileDrop(canvas, receive))
  // Model the host's native document-bubble listeners and retained drag depth.
  let depth = 0, mask = false
  const addFiles = vi.fn()
  const reset = () => { depth = 0; mask = false }
  const host = (event: Event) => {
    const drag = event as DragEvent
    if (!drag.dataTransfer?.types.includes('Files')) return
    if (event.type === 'dragenter') { depth++; mask = true }
    if (event.type === 'dragleave') { depth = Math.max(0, depth - 1); if (!depth) mask = false }
    if (event.type === 'drop') { reset(); addFiles([...drag.dataTransfer.files]) }
  }
  for (const name of ['dragenter', 'dragleave', 'drop']) document.addEventListener(name, host)
  window.addEventListener('dragend', reset)
  cleanups.push(() => {
    for (const name of ['dragenter', 'dragleave', 'drop']) document.removeEventListener(name, host)
    window.removeEventListener('dragend', reset)
  })
  const files = [new File(['image'], 'one.png', { type: 'image/png' }), new File(['video'], 'two.mp4', { type: 'video/mp4' })]
  const send = (type: string, target: Element = child, x = 500, y = 100, types = ['Files'], payload = files) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
    Object.defineProperty(event, 'dataTransfer', { value: { types, files: payload, dropEffect: 'none' } })
    target.dispatchEvent(event)
    return event as unknown as DragEvent
  }
  return { canvas, child, agent, receive, addFiles, files, send, hit, mask: () => mask }
}

it('takes a direct file drop exactly once with original files/coordinates and never raises the Agent mask', () => {
  const f = fixture(), targetDrop = vi.fn(), reset = vi.fn()
  f.child.addEventListener('drop', targetDrop); window.addEventListener('dragend', reset)
  cleanups.push(() => window.removeEventListener('dragend', reset))
  for (const type of ['dragenter', 'dragover', 'dragover']) {
    const event = f.send(type)
    expect(event.defaultPrevented).toBe(true); expect(event.dataTransfer!.dropEffect).toBe('copy'); expect(f.mask()).toBe(false)
  }
  f.send('drop')
  expect(f.receive).toHaveBeenCalledExactlyOnceWith(f.files, { x: 500, y: 100 })
  expect(f.receive.mock.calls[0][0][0]).toBe(f.files[0])
  expect(f.addFiles).not.toHaveBeenCalled(); expect(targetDrop).not.toHaveBeenCalled()
  expect(reset).toHaveBeenCalledTimes(1)
})

it('clears a host mask while crossing from Agent to canvas and leaves the drop exclusively on canvas', () => {
  const f = fixture()
  f.send('dragenter', f.agent, 100); expect(f.mask()).toBe(true)
  f.send('dragenter'); expect(f.mask()).toBe(false)
  f.send('dragleave', f.agent); f.send('dragover'); f.send('drop')
  expect(f.mask()).toBe(false); expect(f.receive).toHaveBeenCalledTimes(1); expect(f.addFiles).not.toHaveBeenCalled()
})

it('preserves Agent enter-before-canvas-leave ordering and only uploads to Agent after leaving canvas', () => {
  const f = fixture()
  f.send('dragenter')
  f.send('dragenter', f.agent, 100); expect(f.mask()).toBe(true)
  f.send('dragleave', f.child, 100); expect(f.mask()).toBe(true)
  f.send('dragover', f.agent, 100); f.send('drop', f.agent, 100)
  expect(f.addFiles).toHaveBeenCalledExactlyOnceWith(f.files)
  expect(f.receive).not.toHaveBeenCalled(); expect(f.mask()).toBe(false)
})

it('rechecks final coordinates instead of trusting a stale canvas event target', () => {
  const f = fixture()
  f.send('dragenter')
  f.send('drop', f.child, 100)
  expect(f.receive).not.toHaveBeenCalled(); expect(f.addFiles).toHaveBeenCalledTimes(1)
})

it('keeps unsupported files on the canvas validation path and passes text drags unchanged', () => {
  const f = fixture(), other = [new File(['data'], 'data.txt', { type: 'text/plain' })], textDrop = vi.fn()
  f.child.addEventListener('drop', textDrop)
  f.send('drop', f.child, 500, 100, ['Files'], other)
  expect(f.receive).toHaveBeenCalledExactlyOnceWith(other, { x: 500, y: 100 }); expect(f.addFiles).not.toHaveBeenCalled()
  f.receive.mockClear()
  for (const name of ['dragenter', 'dragover', 'dragleave', 'drop']) expect(f.send(name, f.child, 500, 100, ['text/plain'], []).defaultPrevented).toBe(false)
  expect(f.receive).not.toHaveBeenCalled(); expect(textDrop).toHaveBeenCalledTimes(1)
})

it('rejects hidden/detached/zero-size/off-viewport canvas and a modal hit above the canvas', () => {
  const f = fixture()
  f.hit.mockReturnValue(f.agent); f.send('drop'); expect(f.receive).not.toHaveBeenCalled()
  f.hit.mockReturnValue(f.child)
  f.canvas.style.visibility = 'hidden'; f.send('drop'); f.canvas.style.visibility = ''
  vi.mocked(f.canvas.getBoundingClientRect).mockReturnValue(new DOMRect(400, 40, 0, 500)); f.send('drop')
  vi.mocked(f.canvas.getBoundingClientRect).mockReturnValue(new DOMRect(400, 40, 500, 500))
  f.send('drop', f.child, 500, -1); f.send('drop', f.child, 1100)
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  f.send('drop')
  delete (document as any).hidden
  f.canvas.remove(); f.send('drop')
  expect(f.receive).not.toHaveBeenCalled()
})

it('retains a coordinate-checked fallback when hit testing is unavailable and cleans up all listeners', () => {
  const f = fixture()
  delete (document as any).elementFromPoint
  f.send('drop'); expect(f.receive).toHaveBeenCalledTimes(1)
  f.send('drop', f.child, 100); expect(f.receive).toHaveBeenCalledTimes(1)
  cleanups[1]()
  f.send('dragenter'); expect(f.mask()).toBe(true)
  f.send('drop'); expect(f.receive).toHaveBeenCalledTimes(1); expect(f.addFiles).toHaveBeenCalledTimes(2)
})

it('allows only the top visible canvas binding to own a drop when two workspaces are mounted', () => {
  const f = fixture(), second = document.createElement('div'), receive = vi.fn()
  document.body.append(second)
  vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 40, 500, 500))
  cleanups.push(bindCanvasFileDrop(second, receive))
  f.hit.mockReturnValue(second)
  f.send('drop', second)
  expect(receive).toHaveBeenCalledExactlyOnceWith(f.files, { x: 500, y: 100 })
  expect(f.receive).not.toHaveBeenCalled(); expect(f.addFiles).not.toHaveBeenCalled()
})

it('uses the latest committed callback without rebinding, and releases ownership on tab hide/unmount', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host)
  const first = vi.fn(), latest = vi.fn()
  function Surface({ active, receive }: { active: boolean; receive: typeof first }) {
    const ref = useRef<HTMLDivElement>(null)
    useCanvasFileDrop(ref, active, receive)
    return <div ref={ref} />
  }
  reactRoot = createRoot(host)
  await act(async () => reactRoot!.render(<Surface active receive={first} />))
  const surface = host.firstElementChild!
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 40, 500, 500))
  const addListener = vi.spyOn(window, 'addEventListener')
  await act(async () => reactRoot!.render(<Surface active receive={latest} />))
  expect(addListener).not.toHaveBeenCalled()
  const drop = () => {
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 500, clientY: 100 })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [new File(['a'], 'a.png')], dropEffect: 'none' } })
    surface.dispatchEvent(event)
    return event
  }
  expect(drop().defaultPrevented).toBe(true); expect(latest).toHaveBeenCalledTimes(1); expect(first).not.toHaveBeenCalled()
  await act(async () => reactRoot!.render(<Surface active={false} receive={latest} />))
  expect(drop().defaultPrevented).toBe(false); expect(latest).toHaveBeenCalledTimes(1)
})
