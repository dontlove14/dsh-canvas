import { useEffect, useRef, useState } from 'react'
import { CapsuleBeam, CapsuleStack, CAPSULE_DISPLAY_LIMIT } from './CapsuleStack'
import { UiButton } from './ui'

export interface CanvasNotification { id: string; message: string; tone?: 'success' | 'error' }
export const NOTIFICATION_DURATION = 5000

function NotificationCapsule({ notification, active, onDismiss }: {
  notification: CanvasNotification; active: boolean; onDismiss: (id: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const remaining = useRef(NOTIFICATION_DURATION)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const running = active && !hovered && !focused
  const tone = notification.tone ?? 'error'
  useEffect(() => {
    if (!running) return
    const started = Date.now()
    const timer = setTimeout(() => dismiss.current(notification.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [running, notification.id])
  return <div className="dc-notification-capsule" role={tone === 'success' ? 'status' : 'alert'}
    data-tone={tone} data-capsule-motion-id={notification.id}
    title={notification.message}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
    }}>
    <CapsuleBeam><div className="dc-notification-capsule-body">
      <svg className="dc-notification-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
        {tone === 'success'
          ? <path d="m7.5 12 3 3 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          : <>
            <path d="M12 7.5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="12" cy="16" r="1" fill="currentColor" />
          </>}
      </svg>
      <span className="dc-notification-message">{notification.message}</span>
      <UiButton className="dc-notification-close" aria-label="关闭提示" onClick={() => onDismiss(notification.id)}>×</UiButton>
    </div></CapsuleBeam>
  </div>
}

export function NotificationCapsules({ notifications, active = true, onDismiss }: {
  notifications: readonly CanvasNotification[]; active?: boolean; onDismiss: (id: string) => void
}) {
  const visible = notifications.slice(0, CAPSULE_DISPLAY_LIMIT)
  const overflow = notifications.length - visible.length
  // Queued messages mount only when visible, so each gets its full reading time.
  return <CapsuleStack ids={visible.map((item) => item.id)} overflow={overflow}
    className="dc-notification-capsules" label="画布通知">
    {visible.map((notification) => <NotificationCapsule key={notification.id} notification={notification}
      active={active} onDismiss={onDismiss} />)}
    {overflow > 0 && <div className="dc-capsule-more" data-capsule-motion-id="overflow"
      aria-label={`还有 ${overflow} 条通知`} title={`还有 ${overflow} 条通知`}>+{overflow}</div>}
  </CapsuleStack>
}
