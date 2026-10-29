import { createContext, useContext, type ReactNode } from 'react'

const CanvasTextSelectionContext = createContext(false)

/** React context follows owned portals; the DOM policy stays inside the canvas. */
export function CanvasTextSelectionProvider({ children }: { children: ReactNode }) {
  return <CanvasTextSelectionContext.Provider value={true}>{children}</CanvasTextSelectionContext.Provider>
}

/** Apply to the root of any canvas-owned portal, including nested menus. */
export function useCanvasTextSelectionScope(): string {
  return useContext(CanvasTextSelectionContext) ? 'dc-canvas-text-scope' : ''
}
