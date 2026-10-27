import { PanOnScrollMode, type ReactFlowProps } from '@xyflow/react'

// Both wheel axes pan in screen pixels; modifier keys switch the native handler to zoom.
export const canvasScrollGestures = {
  panOnScroll: true,
  panOnScrollMode: PanOnScrollMode.Free,
  panOnScrollSpeed: 1,
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomActivationKeyCode: ['Meta', 'Control'],
} satisfies Pick<ReactFlowProps, 'panOnScroll' | 'panOnScrollMode' | 'panOnScrollSpeed' | 'zoomOnScroll' | 'zoomOnPinch' | 'zoomActivationKeyCode'>
