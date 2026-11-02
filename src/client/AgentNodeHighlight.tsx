import { useContext } from 'react'
import { BorderBeam } from 'border-beam'
import { beamPauseCss, NodeLoadingContext } from './NodeLoading'

// Keep the dependency's border geometry and animation; no layer covers content.
const focusCss = `${beamPauseCss}
[data-beam="{id}"] { --beam-inner-opacity: 0; }
`

export function AgentNodeHighlight({ nodeId }: { nodeId: string }) {
  const { theme, paused } = useContext(NodeLoadingContext)
  return <BorderBeam size="md" theme={theme} colorVariant="colorful" strength={1} borderRadius={16}
    css={focusCss} data-dc-agent-highlight={nodeId} data-loading-paused={paused ? '' : undefined}
    className="dc-agent-highlight" aria-hidden="true"
    style={{ position: 'absolute', inset: -3, pointerEvents: 'none', zIndex: 4 }}>
    <div className="dc-agent-highlight-content" />
  </BorderBeam>
}
