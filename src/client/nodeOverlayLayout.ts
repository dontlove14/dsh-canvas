/** Node attachments share a layer below the canvas's fixed controls. */
export const NODE_OVERLAY_STYLE = { zIndex: 'var(--dc-node-overlay-layer)' } as const

/** Fixed screen-size editor, centered below the node; the canvas clips off-screen content. */
export function nodeEditorPosition(
  position: { x: number; y: number },
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number } = { width: 320, height: 285 },
) {
  const width = 530
  return {
    width,
    left: viewport.x + (position.x + size.width / 2) * viewport.zoom - width / 2,
    top: viewport.y + (position.y + size.height) * viewport.zoom + 18,
  }
}
