import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react'
import { maskSecret } from '../shared/settingSecrets'
import { UiButton, UiInput } from './ui'

type LoadSecret = (signal: AbortSignal) => Promise<string>
function useReveal(value: string, load: LoadSecret | undefined, disabled: boolean) {
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef(0)
  const controller = useRef<AbortController>()
  const hide = () => {
    attempt.current++; controller.current?.abort(); controller.current = undefined
    setVisible(false); setLoaded(''); setLoading(false); setError('')
  }
  useEffect(() => {
    const visibility = () => { if (document.hidden) hide() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', hide)
    return () => {
      attempt.current++; controller.current?.abort()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', hide)
    }
  }, [])
  useEffect(() => { if (disabled) hide() }, [disabled])
  const toggle = async () => {
    if (disabled) return
    if (visible || loading) { hide(); return }
    setError('')
    if (value) { setVisible(true); return }
    if (!load) return
    const current = ++attempt.current, pending = new AbortController()
    controller.current = pending; setLoading(true)
    try {
      const result = await load(pending.signal)
      if (current !== attempt.current || pending.signal.aborted) return
      setLoaded(result); setVisible(true)
    } catch {
      if (current === attempt.current && !pending.signal.aborted) setError('读取失败，请重试')
    } finally {
      if (current === attempt.current) { controller.current = undefined; setLoading(false) }
    }
  }
  return { visible, loaded, loading, error, hide, toggle }
}

function EyeButton({ label, visible, loading, disabled, toggle }: {
  label: string; visible: boolean; loading: boolean; disabled: boolean; toggle: () => Promise<void>
}) {
  const action = loading ? '取消显示' : visible ? '隐藏' : '显示'
  return <UiButton className="dc-secret-toggle" type="button" aria-label={`${action} ${label}`} title={`${action} ${label}`}
    aria-pressed={visible} aria-busy={loading} disabled={disabled} onClick={() => void toggle()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />
      {!visible && <path d="m3 3 18 18" />}
    </svg>
  </UiButton>
}

/** No stored secret is fetched until this field's eye button is activated. */
export function SecretValue({ label, value = '', mask = '', load, disabled = false }: {
  label: string; value?: string; mask?: string; load?: LoadSecret; disabled?: boolean
}) {
  const reveal = useReveal(value, load, disabled)
  return <span className="dc-secret-value">
    <span className="dc-secret-text">{reveal.visible ? value || reveal.loaded : value ? maskSecret(value) : mask}</span>
    <EyeButton label={label} {...reveal} disabled={disabled || (!value && !load)} />
    {reveal.error && <span className="dc-secret-error" role="alert">{reveal.error}</span>}
  </span>
}

/** Revealing an existing key is a preview; only user input changes the save draft. */
export function SecretInput({ value, label, savedMask = '', load, disabled = false, onChange, ...props }:
  Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'type'> & { value: string; label: string; savedMask?: string; load?: LoadSecret }) {
  const reveal = useReveal(value, load, disabled)
  return <span className="dc-secret-field">
    <span className="dc-secret-input">
      <UiInput {...props} aria-label={props['aria-label'] ?? label} type={reveal.visible ? 'text' : 'password'}
        autoComplete="new-password" spellCheck={false} value={reveal.visible && !value ? reveal.loaded : value}
        disabled={disabled} placeholder={props.placeholder ?? savedMask} onChange={(event) => {
          if (reveal.loading || reveal.loaded) reveal.hide()
          onChange?.(event)
        }} />
      <EyeButton label={label} {...reveal} disabled={disabled || (!value && !load)} />
    </span>
    {reveal.error && <span className="dc-secret-error" role="alert">{reveal.error}</span>}
  </span>
}
