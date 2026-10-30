// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { KeyboardGuide } from '../src/client/KeyboardGuide'
import { CanvasTextSelectionProvider } from '../src/client/canvasTextSelection'
import { HarnessUiProvider } from '../src/client/ui'
import { harnessPrimitives } from './support/harnessPrimitives'

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(platform = 'MacIntel') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.classList.contains('canvas-fixture') ? new DOMRect(400, 60, 500, 600) : new DOMRect(830, 610, 30, 30)
  })
  const host = document.createElement('div'); host.className = 'canvas-fixture'; document.body.append(host); root = createRoot(host)
  let enabled = true
  const render = () => root!.render(<HarnessUiProvider components={harnessPrimitives}><CanvasTextSelectionProvider>
    <KeyboardGuide enabled={enabled} container={{ current: host }} />
  </CanvasTextSelectionProvider></HarnessUiProvider>)
  await act(async () => render())
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="快捷键"]')!
  return { host, trigger, hide: () => act(async () => { enabled = false; render() }), open: () => act(async () => trigger.click()) }
}
it.each(['MacIntel', 'Win32'])('uses platform modifier badges and accessible focus/escape with a canvas-bounded portal on %s', async (platform) => {
  const f = await fixture(platform); await f.open()
  const panel = document.querySelector<HTMLElement>('[aria-label="快捷键指引"]')!
  expect(panel.classList.contains('dc-canvas-text-scope')).toBe(true)
  expect(panel.classList.contains('dc-overlay-scope')).toBe(true)
  expect(panel.dataset.columns).toBe('2')
  expect(panel.querySelector('[aria-label="Command"]') !== null).toBe(platform === 'MacIntel')
  expect(panel.querySelector('[aria-label="Ctrl"]') !== null).toBe(platform === 'Win32')
  expect(panel.textContent).not.toContain('保存')
  expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(412)
  expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(888)
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭快捷键指引')
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(document.querySelector('.dc-keyboard-guide')).toBeNull()
  expect(document.activeElement).toBe(f.trigger)
})
it('closes on outside click, hidden workspace or blur, and ignores deletion keys within the guide', async () => {
  const f = await fixture(); await f.open()
  const outside = document.createElement('button'); document.body.append(outside)
  await act(async () => outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
  expect(document.querySelector('.dc-keyboard-guide')).toBeNull()
  await f.open()
  const propagated = vi.fn(); document.addEventListener('keydown', propagated)
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
  expect(propagated).not.toHaveBeenCalled(); document.removeEventListener('keydown', propagated)
  await act(async () => window.dispatchEvent(new Event('blur')))
  expect(document.querySelector('.dc-keyboard-guide')).toBeNull()
  await f.open(); await f.hide()
  expect(document.querySelector('.dc-keyboard-guide')).toBeNull()
})
