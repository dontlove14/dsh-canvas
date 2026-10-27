export type ViewportTransform = readonly [number, number, number]
type Motion = 'idle' | 'pan' | 'zoom'

/** A cached transform layer is useful for translation, but must not persist across scaling. */
export class ViewportCompositing {
  private last: ViewportTransform
  private motion: Motion = 'idle'
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  constructor(private root: HTMLElement, transform: ViewportTransform) {
    this.last = [...transform]
    this.setMotion('idle')
  }
  private setMotion(motion: Motion): void {
    this.motion = motion
    if (this.root.dataset.viewportMotion !== motion) this.root.dataset.viewportMotion = motion
  }
  update(transform: ViewportTransform): void {
    if (this.disposed) return
    const [x, y, zoom] = transform
    const [oldX, oldY, oldZoom] = this.last
    this.last = [...transform]
    if (x === oldX && y === oldY && zoom === oldZoom) return
    if (this.root.ownerDocument.hidden) { this.settle(); return }
    // Keep mixed pan/zoom gestures unpromoted until they stop.
    this.setMotion(zoom !== oldZoom || this.motion === 'zoom' ? 'zoom' : 'pan')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.settle(), 200)
  }
  settle = (): void => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.disposed) this.setMotion('idle')
  }
  destroy(): void {
    this.settle(); this.disposed = true
    delete this.root.dataset.viewportMotion
  }
}
