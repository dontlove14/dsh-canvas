import { useEffect, useState } from 'react'
import { KEY_MASK, type ModelInput, type PublicModel } from '../shared/contracts'
import { builtinDefinition, PROVIDERS, providerFor } from '../shared/modelCatalog'
import { CanvasApi } from './api'
import { MediaIcon } from './MediaIcon'
import { UiButton, UiCheckbox, UiInput, UiSelect } from './ui'
import { ObjectStorageSettings } from './ObjectStorageSettings'
import { TtsSettings } from './TtsSettings'

export function CanvasSettings({ api, onChanged, initialTab = 'storage' }: { api: CanvasApi; onChanged?: () => void; initialTab?: 'storage' | 'models' | 'tts' }) {
  const [tab, setTab] = useState(initialTab)
  return <section className="dc-settings" aria-label="无限画布">
    <h2>无限画布</h2>
    <div className="dc-settings-tabs" role="tablist" aria-label="无限画布设置分类">
      {([['storage', '对象存储'], ['models', '模型设置'], ['tts', 'TTS 设置']] as const).map(([id, label]) =>
        <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div role="tabpanel">{tab === 'storage' ? <ObjectStorageSettings api={api} onChanged={onChanged} />
      : tab === 'models' ? <ModelSettings api={api} onChanged={onChanged} /> : <TtsSettings api={api} onChanged={onChanged} />}</div>
  </section>
}

const modelChoice = (model: PublicModel) => `${model.kind}:${model.model_id}`

export function ModelSettings({ api, onChanged }: { api: CanvasApi; onChanged?: () => void }) {
  const [models, setModels] = useState<PublicModel[]>([])
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [provider, setProvider] = useState<string>(PROVIDERS[0].apiBase)
  const [key, setKey] = useState('')
  const [clear, setClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void api.models().then((list) => {
      if (live) { setModels(list); setReady(true) }
    }).catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [api])
  const catalog = models.filter((model) => builtinDefinition(model))
  const choices = [...new Map(catalog.map((model) => [modelChoice(model), { value: modelChoice(model), label: model.name }])).values()]
  const configured = catalog.filter((model) => model.has_api_key)
  const configuredChoices = [...new Set(configured.map(modelChoice))]
  const selected = catalog.find((model) => modelChoice(model) === choice && model.api_base === provider)
  const hasKey = !!selected?.has_api_key
  const providers = PROVIDERS.filter((channel) => catalog.some((model) => modelChoice(model) === choice && model.api_base === channel.apiBase))
  const start = () => {
    setChoice(''); setProvider(PROVIDERS[0].apiBase); setKey(''); setClear(false); setOpen(true); setError(''); setMessage('')
  }
  const save = async () => {
    if (busy || !ready || !selected || (!hasKey && !key.trim())) return
    setBusy(true); setError(''); setMessage('')
    try {
      const api_key = clear ? '' : key.trim() || undefined
      {
        const { id, kind, name, model_id, api_base, protocol } = selected
        const input: ModelInput = { id, kind, name, model_id, api_base, protocol, api_key }
        setModels(await api.saveModel(input))
      }
      setOpen(false); setKey(''); setClear(false)
      setMessage(clear ? '该供应商的密钥已清除' : '供应商配置已保存在本机'); onChanged?.()
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { setBusy(false) }
  }
  return <section className="dc-settings" aria-label="模型设置">
    <div className="dc-settings-heading"><h3>模型设置</h3>
      <UiButton variant="outline" disabled={!ready || busy} onClick={() => start()}>＋ 配置模型</UiButton></div>
    <p className="dc-muted">选择模型和供应商配置密钥。每个组合独立保存，Model Link 为默认渠道。</p>
    <div className="dc-model-list" aria-label="已配置模型">
      {configuredChoices.map((value) => {
        const channels = configured.filter((model) => modelChoice(model) === value), model = channels[0]
        return <div className="dc-model-row" key={value}>
          <div className={`dc-model-symbol ${model.kind}`}><MediaIcon kind={model.kind} size={30} /></div>
          <div className="dc-model-info"><strong>{model.name}</strong>
            <small>{channels.map((channel) => providerFor(channel)?.label).join('、')} · 已配置</small></div>
        </div>
      })}
      {ready && !configuredChoices.length && <div className="dc-settings-empty">尚未配置模型，点击“配置模型”添加。</div>}
    </div>
    {open && <form className="dc-model-form" aria-label="模型供应商设置" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h3>配置模型</h3>
      <div className="dc-form-columns">
        <label>模型<UiSelect label="配置模型" value={choice} disabled={busy} options={[{ value: '', label: '请选择模型' }, ...choices]}
          onChange={(value) => { setChoice(value); setProvider(catalog.find((model) => modelChoice(model) === value)?.api_base ?? PROVIDERS[0].apiBase); setKey(''); setClear(false); setError('') }} /></label>
        <label>供应商<UiSelect label="配置供应商" value={choice ? provider : ''} disabled={busy || !choice}
          options={choice ? providers.map((channel) => ({ value: channel.apiBase, label: channel.label })) : [{ value: '', label: '请先选择模型' }]}
          onChange={(value) => { setProvider(value); setKey(''); setClear(false); setError('') }} /></label>
      </div>
      <label>API Key<UiInput aria-label="模型供应商 API Key" type="password" value={key} autoComplete="new-password" disabled={busy || clear || !choice}
        placeholder={hasKey ? `${KEY_MASK} · 留空保留原密钥` : '输入所选供应商的 API Key'} onChange={(event) => setKey(event.target.value)} /></label>
      {hasKey && <UiCheckbox label="清除该供应商的密钥" checked={clear} onChange={setClear} />}
      <div className="dc-form-actions"><UiButton variant="outline" disabled={busy} onClick={() => { setOpen(false); setKey('') }}>取消</UiButton>
        <UiButton variant="primary" disabled={busy || !choice || (!hasKey && !key.trim())} type="submit">{busy ? '保存中…' : '保存配置'}</UiButton></div>
    </form>}
    {error && <p className="dc-error" role="alert">{error}</p>}{message && <p className="dc-success" role="status">{message}</p>}
    <p className="dc-settings-footnote">模型配置与凭据保存在本机；生成内容发送到所选供应商，媒体保存到对象存储。</p>
  </section>
}
