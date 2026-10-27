import { Handle, Position } from '@xyflow/react'

export function CanvasHandle({ type, id, disabled = false, className = '' }: { type: 'source' | 'target'; id?: string; disabled?: boolean; className?: string }) {
  return <Handle type={type} id={id} position={type === 'target' ? Position.Left : Position.Right}
    isConnectable={!disabled} className={`dc-handle ${className} ${disabled ? 'disabled' : ''}`}
    aria-label={type === 'target' ? '输入参考素材' : disabled ? '生成后连接输出' : '连接输出素材'}>
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--dc-bg)" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6 10h8M10 6v8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  </Handle>
}
