import { readFileSync } from 'node:fs'
import postcss from 'postcss'
import { calc } from '@csstools/css-calc'
import { describe, expect, it } from 'vitest'

const stylesheet = postcss.parse(readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8'))
function declarations(selector: string) {
  const values: Record<string, string> = {}
  stylesheet.walkRules(selector, (rule) => {
    if (rule.parent?.type !== 'root') return
    rule.walkDecls((decl) => { values[decl.prop] = decl.value })
  })
  return values
}
function animationOffsets(properties: Record<string, string>) {
  const name = properties['animation-name'] ?? properties.animation.split(' ')[0]
  const values: Record<string, string> = {}
  stylesheet.walkAtRules('keyframes', (frames) => {
    if (frames.params !== name) return
    frames.walkRules((frame) => {
      frame.walkDecls('stroke-dashoffset', (decl) => {
        values[frame.selector] = calc(decl.value.replace(/var\((--[\w-]+)\)/g, (_, variable) => properties[variable]))
      })
    })
  })
  return values
}
describe('edge flow CSS animation values', () => {
  it.each(['trail', 'core'])('provides interpolable CSS lengths and moves %s forward by exactly one dash period per cycle', (layer) => {
    const base = declarations('.dc-edge-flow path')
    const properties = { ...base, ...declarations(`.dc-edge-flow .dc-edge-flow-${layer}`) }
    const offsets = animationOffsets(properties)
    // A calc() number is not a CSS length; the old endpoint was ignored even
    // though the stylesheet parsed and the static SVG dashes were visible.
    expect(offsets.to).toMatch(/^-?[\d.]+px$/)
    expect(offsets.from).toMatch(/^-?[\d.]+px$/)
    const start = parseFloat(offsets.from), end = parseFloat(offsets.to)
    const period = properties['stroke-dasharray'].split(/\s+/).reduce((sum, value) => sum + parseFloat(value), 0)
    expect(end).toBeLessThan(start)
    expect(start - end).toBeCloseTo(period, 5)
    expect(base.animation).toContain('linear infinite')
  })
})
