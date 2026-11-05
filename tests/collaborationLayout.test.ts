import { expect, it } from 'vitest'
import { collaborationOutset } from '../src/client/collaborationLayout'

it('uses the real chat gutter beyond the composer without entering the adjacent pane', () => {
  const anchor = { right: 1054, width: 980 }, bounds = { left: 0, right: 1272, width: 1272 }
  const outset = collaborationOutset(anchor, bounds, 2048)
  expect(outset).toBe(206)
  expect(anchor.right + outset).toBe(bounds.right - 12)
})
it('clamps a narrow or clipped chat to its own edge and the viewport', () => {
  const anchor = { right: 360, width: 344 }, bounds = { left: 0, right: 368, width: 368 }
  expect(collaborationOutset(anchor, bounds, 400)).toBe(-4)
  expect(anchor.right + collaborationOutset(anchor, { ...bounds, right: 800, width: 800 }, 390)).toBe(378)
})
it('uses a bounded fallback when native geometry is absent and ignores unmeasured anchors', () => {
  expect(collaborationOutset({ right: 600, width: 500 }, undefined, 1000)).toBe(36)
  expect(collaborationOutset({ right: 0, width: 0 }, undefined, 1000)).toBe(0)
  expect(collaborationOutset({ right: 600, width: 500 }, undefined, 0)).toBe(0)
})
