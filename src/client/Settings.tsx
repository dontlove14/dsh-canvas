import { useEffect, useRef, useState } from 'react'
import { KEY_MASK, type ModelInput, type PublicModel } from '../shared/contracts'
import { builtinDefinition, PROVIDERS, providerFor, modelRequiresEndpoint, modelConfigured } from '../shared/modelCatalog'
import { CanvasApi } from './api'
import { MediaIcon } from './MediaIcon'
import { UiButton, UiCheckbox, UiSelect } from './ui'
import { ObjectStorageSettings } from './ObjectStorageSettings'
import { TtsSettings } from './TtsSettings'
import { SecretInput, SecretValue } from './SecretField'
import { SeedanceReviewSettings } from './SeedanceReviewSettings'

export type SettingsTab = 'storage' | 'models' | 'tts' | 'review'
export function CanvasSettings({ api, onChanged, initialTab = 'storage', showTitle = true }: { api: CanvasApi; onChanged?: () => void; initialTab?: SettingsTab; showTitle?: boolean }) {
  const [tab, setTab] = useState(initialTab)
  return <section className="dc-settings dc-canvas-settings" aria-label="无限画布">
    {showTitle && <h2>无限画布</h2>}
    <div className="dc-settings-tabs" role="tablist" aria-label="无限画布设置分类">
      {([['storage', '对象存储'], ['models', '模型设置'], ['tts', 'TTS 设置'], ['review', 'Seedance 预审']] as const).map(([id, label]) =>
        <button type="button" role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    <div key={tab} className="dc-settings-panel" role="tabpanel">{tab === 'storage' ? <ObjectStorageSettings api={api} onChanged={onChanged} />
      : tab === 'models' ? <ModelSettings api={api} onChanged={onChanged} /> : tab === 'review' ? <SeedanceReviewSettings api={api} onChanged={onChanged} /> : <TtsSettings api={api} onChanged={onChanged} />}</div>
  </section>
}

const modelChoice = (model: PublicModel) => `${model.kind}:${model.model_id}`
const providerMarks: Readonly<Record<string, string>> = { 'model-link': 'ML', openai: 'AI', gemini: 'G', bytedance: 'BD', byteplus: 'B+' }
function providerGroups(models: readonly PublicModel[]) {
  const groups = new Map<string, { id: string; label: string; models: PublicModel[] }>()
  for (const model of models) {
    const provider = providerFor(model)
    if (!provider) continue
    const group = groups.get(provider.id) ?? { id: provider.id, label: provider.label, models: [] }
    group.models.push(model); groups.set(provider.id, group)
  }
  return [...groups.values()].sort((a, b) => Number(b.models.some((model) => model.has_api_key)) - Number(a.models.some((model) => model.has_api_key)))
}

export function ModelSettings({ api, onChanged }: { api: CanvasApi; onChanged?: () => void }) {
  const [models, setModels] = useState<PublicModel[]>([])
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [providerScope, setProviderScope] = useState('')
  const [choice, setChoice] = useState('')
  const [provider, setProvider] = useState<string>(PROVIDERS[0].apiBase)
  const [key, setKey] = useState('')
  const [endpointId, setEndpointId] = useState('')
  const [clear, setClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const section = useRef<HTMLElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const returnLabel = useRef('')
  const wasOpen = useRef(false)
  const saving = useRef(false)
  useEffect(() => {
    if (open) form.current?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)')?.focus()
    else if (wasOpen.current) {
      const buttons = [...(section.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const target = buttons.find((button) => button.getAttribute('aria-label') === returnLabel.current)
        ?? buttons.find((button) => button.getAttribute('aria-label') === '配置新模型')
      target?.focus()
    }
    wasOpen.current = open
  }, [open])
  useEffect(() => {
    let live = true
    void api.models().then((list) => {
      if (live) { setModels(list); setReady(true) }
    }).catch((e) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [api])
  const catalog = models.filter((model) => builtinDefinition(model))
  const formCatalog = providerScope ? catalog.filter((model) => providerFor(model)?.id === providerScope) : catalog
  const choices = [...new Map(formCatalog.map((model) => [modelChoice(model), { value: modelChoice(model), label: model.name }])).values()]
  const selected = catalog.find((model) => modelChoice(model) === choice && model.api_base === provider)
  const hasKey = !!selected?.has_api_key
  const needsEndpoint = !!selected && modelRequiresEndpoint(selected)
  const endpointValid = !needsEndpoint || /^ep-[a-zA-Z0-9-]+$/.test(endpointId.trim())
  const providers = [...new Map(catalog.filter((model) => modelChoice(model) === choice).flatMap((model) => {
    const provider = providerFor(model); return provider ? [[provider.apiBase, provider] as const] : []
  })).values()]
  const start = (label: string, model?: PublicModel, scope = '') => {
    returnLabel.current = label
    setEditing(!!model); setProviderScope(scope); setChoice(model ? modelChoice(model) : '')
    setProvider(model?.api_base ?? PROVIDERS.find((channel) => channel.id === scope)?.apiBase ?? PROVIDERS[0].apiBase)
    setKey(''); setEndpointId(model?.endpoint_id ?? ''); setClear(false); setOpen(true); setError(''); setMessage('')
  }
  const save = async () => {
    if (saving.current || busy || !ready || !selected || (!hasKey && !key.trim()) || (!clear && !endpointValid)) return
    saving.current = true
    setBusy(true); setError(''); setMessage('')
    try {
      const api_key = clear ? '' : key.trim() || undefined
      {
        const { id, kind, name, model_id, api_base, protocol } = selected
        const input: ModelInput = { id, kind, name, model_id, api_base, protocol, api_key,
          ...(needsEndpoint && endpointValid ? { endpoint_id: endpointId.trim() } : {}) }
        setModels(await api.saveModel(input))
      }
      setOpen(false); setKey(''); setClear(false)
      setMessage(clear ? '该供应商的密钥已清除' : '供应商配置已保存在本机'); onChanged?.()
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { saving.current = false; setBusy(false) }
  }
  return <section ref={section} className="dc-settings dc-model-settings" aria-label="模型设置">
    <div className="dc-settings-heading"><h3>{open ? editing ? '编辑模型' : '配置模型' : '模型设置'}</h3>
      {!open && <UiButton aria-label="配置新模型" variant="outline" disabled={!ready || busy} onClick={() => start('配置新模型')}>＋ 配置模型</UiButton>}</div>
    {!open && <div className="dc-provider-grid" aria-label="模型供应商">
      {providerGroups(catalog).map((group) => {
        const saved = group.models.filter((model) => model.has_api_key), configuredCount = saved.filter(modelConfigured).length
        const status = configuredCount ? '已配置' : saved.length ? '待完善' : '未配置'
        const addLabel = `配置 ${group.label} 模型`
        return <article className="dc-provider-card" data-provider={group.id} key={group.id} aria-label={`${group.label} 模型配置`}>
          <div className="dc-provider-heading">
            <span className="dc-provider-mark" aria-hidden="true">{providerMarks[group.id] ?? group.label.slice(0, 2)}</span>
            <h4>{group.label}</h4><span className={`dc-provider-status ${configuredCount ? 'configured' : saved.length ? 'incomplete' : ''}`}>{status}</span>
          </div>
          <div className="dc-provider-summary"><span>模型</span><strong>{configuredCount} / {group.models.length} 已配置</strong></div>
          <div className="dc-provider-models" aria-label={`${group.label} 已保存模型`} tabIndex={saved.length ? 0 : undefined}>
            {saved.map((model) => {
              const editLabel = `编辑 ${model.name} · ${group.label}`
              return <div className="dc-provider-model" key={model.id}>
                <span className="dc-provider-model-icon"><MediaIcon kind={model.kind} size={20} /></span>
                <div className="dc-provider-model-info"><strong>{model.name}</strong>
                  <small className="dc-provider-secret">API Key：<SecretValue label={`${model.name} · ${group.label} API Key`} mask={model.api_key_mask || KEY_MASK}
                    load={(signal) => api.settingSecret({ scope: 'model', id: model.id, field: 'api_key' }, signal)} /></small>
                  {model.endpoint_id && <small className="dc-provider-secret">EP：<SecretValue label={`${model.name} · ${group.label} EP`} value={model.endpoint_id} /></small>}
                  {!modelConfigured(model) && <small className="dc-provider-model-warning">请完善 EP 配置</small>}</div>
                <UiButton aria-label={editLabel} disabled={busy} onClick={() => start(editLabel, model, group.id)}>编辑</UiButton>
              </div>
            })}
            {!saved.length && <p className="dc-provider-empty">尚未配置模型</p>}
          </div>
          <div className="dc-provider-footer"><div className="dc-provider-kinds">
            {[...new Set(group.models.map((model) => model.kind))].map((kind) => <span key={kind}>{kind === 'image' ? '图像' : '视频'}</span>)}
          </div><UiButton aria-label={addLabel} disabled={!ready || busy} onClick={() => start(addLabel, undefined, group.id)}>＋ 配置模型</UiButton></div>
        </article>
      })}
    </div>}
    {open && <form ref={form} className="dc-model-form" aria-label="模型供应商设置" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="dc-form-columns">
        <label>模型<UiSelect label="配置模型" value={choice} disabled={busy || editing} options={[{ value: '', label: '请选择模型' }, ...choices]}
          onChange={(value) => { const next = formCatalog.find((model) => modelChoice(model) === value); setChoice(value); setProvider(next?.api_base ?? PROVIDERS[0].apiBase); setEndpointId(next?.endpoint_id ?? ''); setKey(''); setClear(false); setError('') }} /></label>
        <label>供应商<UiSelect label="配置供应商" value={choice ? provider : ''} disabled={busy || !choice || editing || !!providerScope}
          options={choice ? providers.map((channel) => ({ value: channel.apiBase, label: channel.label })) : [{ value: '', label: '请先选择模型' }]}
          onChange={(value) => { setProvider(value); setEndpointId(catalog.find((model) => modelChoice(model) === choice && model.api_base === value)?.endpoint_id ?? ''); setKey(''); setClear(false); setError('') }} /></label>
      </div>
      {needsEndpoint && <label>EP（推理接入点）<SecretInput key={`${choice}:${provider}:ep`} label="模型供应商 EP" aria-label="模型供应商 EP" value={endpointId} disabled={busy || clear}
        placeholder="ep-… · 填写当前型号对应的接入点" onChange={(event) => setEndpointId(event.target.value)} /></label>}
      <label>API Key<SecretInput key={`${choice}:${provider}:key`} label="模型供应商 API Key" aria-label="模型供应商 API Key" value={key} disabled={busy || clear || !choice}
        savedMask={selected?.api_key_mask} load={hasKey && selected ? (signal) => api.settingSecret({ scope: 'model', id: selected.id, field: 'api_key' }, signal) : undefined}
        placeholder={hasKey ? `${selected?.api_key_mask || KEY_MASK} · 留空保留原密钥` : '输入所选供应商的 API Key'} onChange={(event) => setKey(event.target.value)} /></label>
      {hasKey && <UiCheckbox label="清除该供应商的密钥" checked={clear} disabled={busy} onChange={setClear} />}
      <div className="dc-form-actions"><UiButton variant="outline" disabled={busy} onClick={() => { setOpen(false); setKey('') }}>取消</UiButton>
        <UiButton variant="primary" disabled={busy || !choice || (!hasKey && !key.trim()) || (!clear && !endpointValid)} type="submit">{busy ? '保存中…' : '保存配置'}</UiButton></div>
    </form>}
    {error && <p className="dc-error" role="alert">{error}</p>}{message && <p className="dc-success" role="status">{message}</p>}
  </section>
}
