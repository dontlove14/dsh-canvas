/** Display geometry only; never add layout fields to persisted asset/node records. */
export function mediaFrame(width: number, height: number, rotation = 0) {
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) { width = 16; height = 9 }
  const quarterTurn = rotation % 180 !== 0
  const rotatedWidth = quarterTurn ? height : width
  const rotatedHeight = quarterTurn ? width : height
  const scale = Math.min(320 / rotatedWidth, 480 / rotatedHeight)
  return { width: Math.max(1, Math.round(rotatedWidth * scale)), height: Math.max(1, Math.round(rotatedHeight * scale)), imageWidth: Math.max(1, Math.round(width * scale)), imageHeight: Math.max(1, Math.round(height * scale)) }
}
