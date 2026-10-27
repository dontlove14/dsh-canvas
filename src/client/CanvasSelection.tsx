import { createContext, useContext } from 'react'

export const CanvasSelectionContext = createContext<{ selecting: boolean; selectedIds: readonly string[] | null }>({
  selecting: false, selectedIds: null,
})

/** Portals inherit this context too; selection outlines remain independent. */
export function useNodeActions(id: string, selected: boolean, allowHover = false): boolean {
  const { selecting, selectedIds } = useContext(CanvasSelectionContext)
  return !selecting && ((selectedIds === null && (allowHover || selected)) || (allowHover && selectedIds?.length === 0) ||
    (selected && selectedIds?.length === 1 && selectedIds[0] === id))
}
