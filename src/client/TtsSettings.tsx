import { useEffect, useState } from 'react'
import { FISH_TTS_ENDPOINT, TtsSettingsInputSchema, type PublicTtsSettings } from '../shared/contracts'
import { CanvasApi } from './api'
import { TtsIcon } from './TtsIcon'
import { UiButton, UiCheckbox } from './ui'
import { SecretInput } from './SecretField'

export function TtsSettings({ api, onChanged }: { api: CanvasApi; onChanged?: () => void }) {
  const [settings, setSettings] = useState<PublicTtsSettings | null>(null)
  const [key, setKey] = useState('')
  const [clear, setClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    let live = true
    void api.ttsSettings().then((value) => { if (live) setSettings(value) }).catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [api])
  const save = async () => {
    if (!settings || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const input = TtsSettingsInputSchema.parse({ endpoint: FISH_TTS_ENDPOINT, revision: settings.revision, api_key: clear ? '' : key.trim() || (settings.configured ? undefined : '') })
      setSettings(await api.saveTtsSettings(input)); setKey(''); setClear(false); setMessage('FishTTS 服务已保存在本机'); onChanged?.()
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { setBusy(false) }
  }
  return <form className="dc-tts-settings dc-model-form" aria-label="FishTTS 服务设置" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <h3><TtsIcon size={24} /> FishTTS 语音服务</h3>
    <p className="dc-muted">供应商：Model Link。语音服务密钥独立配置。</p>
    <label>API Key<SecretInput key={settings?.revision} label="FishTTS API Key" aria-label="FishTTS API Key" value={key} disabled={!settings || clear || busy}
      savedMask={settings?.api_key_mask} load={settings?.has_api_key ? (signal) => api.settingSecret({ scope: 'tts', field: 'api_key' }, signal) : undefined}
      placeholder={settings?.has_api_key ? `${settings.api_key_mask} · 留空保留原密钥` : '输入 ModelLink API Key'}
      onChange={(event) => setKey(event.target.value)} /></label>
    {settings?.has_api_key && <UiCheckbox label="清除 FishTTS 已有密钥" checked={clear} disabled={busy} onChange={setClear} />}
    <div className="dc-form-actions"><UiButton variant="primary" type="submit" disabled={!settings || busy}>{busy ? '保存中…' : '保存语音服务'}</UiButton></div>
    {error && <p className="dc-error" role="alert">{error}</p>}{message && <p className="dc-success" role="status">{message}</p>}
  </form>
}
