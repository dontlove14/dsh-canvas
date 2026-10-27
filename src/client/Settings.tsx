import { useEffect, useId, useRef, useState } from 'react'
import { ModelInputSchema, ProtocolLabels, KEY_MASK, type ModelKind, type ModelInput, type Protocol, type PublicModel } from '../shared/contracts'
import { CanvasApi } from './api'
import { MediaIcon } from './MediaIcon'
import { UiButton, UiCheckbox, UiInput, UiSegments, UiSelect } from './ui'
import { TtsSettings } from './TtsSettings'

const blank = (kind: ModelKind): ModelInput => ({
  kind, name: '', model_id: kind === 'image' ? 'gpt-image-1' : 'sora-2',
  api_base: 'https://api.openai.com/v1', protocol: kind === 'image' ? 'openai-image' : 'openai-video', api_key: '',
})
export function ModelSettings({ api, onChanged }: { api: CanvasApi; onChanged?: () => void }) {
  const [models, setModels] = useState<PublicModel[]>([])
  const [kind, setKind] = useState<ModelKind>('image')
  const [form, setForm] = useState<ModelInput | null>(null)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const tabsId = useId()
  useEffect(() => { void api.models().then(setModels).catch((error: Error) => setError(error.message)) }, [api])
  useEffect(() => { if (form) nameInput.current?.focus() }, [!!form])
  const open = (model?: PublicModel) => {
    setForm(model ? {
      id: model.id, kind: model.kind, name: model.name, model_id: model.model_id, api_base: model.api_base, protocol: model.protocol,
    } : blank(kind))
    setKey(''); setClearKey(false); setError(''); setMessage('')
  }
  const save = async () => {
    if (!form) return
    setBusy(true); setError('')
    try {
      const input = { ...form, api_key: clearKey ? '' : key.trim() || (form.id ? undefined : '') }
      const parsed = ModelInputSchema.safeParse(input)
      if (!parsed.success) throw new Error(parsed.error.issues[0].message)
      setModels(await api.saveModel(parsed.data)); setForm(null); setKey(''); setClearKey(false)
      setMessage('模型已保存在本机'); onChanged?.()
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败') }
    finally { setBusy(false) }
  }
  const remove = async (model: PublicModel) => {
    if (!window.confirm(`删除“${model.name}”的模型配置？节点和历史结果会保留。`)) return
    setBusy(true); setError('')
    try { setModels(await api.deleteModel(model.id)); setMessage('模型配置已删除'); onChanged?.() }
    catch (error) { setError(error instanceof Error ? error.message : '删除失败') }
    finally { setBusy(false) }
  }
  return <section className="dc-settings" aria-label="无限画布 模型设置">
    <div className="dc-settings-heading"><h2>无限画布 模型设置</h2></div>
    <p className="dc-muted">为图片和视频分别配置模型。API Base 请包含版本路径，例如 /v1；接口需兼容所选协议。</p>
    <UiSegments id={tabsId} label="模型类型" value={kind} disabled={busy}
      options={(['image', 'video'] as const).map((type) => ({ value: type, label: `${type === 'image' ? '图片模型' : '视频模型'} ${models.filter((item) => item.kind === type).length}` }))}
      onChange={(type) => { setKind(type as ModelKind); setForm(null) }} />
    <div className="dc-model-list" role="tabpanel" id={`${tabsId}-${kind}-panel`} aria-labelledby={`${tabsId}-${kind}`}>
      {models.filter((item) => item.kind === kind).map((model) => <div className="dc-model-row" key={model.id}>
        <div className={`dc-model-symbol ${model.kind}`}><MediaIcon kind={model.kind} size={30} /></div>
        <div className="dc-model-info"><strong>{model.name}</strong><small>{model.model_id} · {ProtocolLabels[model.protocol]}</small>
          <span className="dc-model-address">{model.api_base}</span><small>API Key：{model.has_api_key ? model.api_key_mask : '未设置'}</small>
        </div>
        <div className="dc-model-actions"><UiButton variant="outline" disabled={busy} onClick={() => open(model)}>编辑</UiButton>
          <UiButton className="dc-ui-danger" disabled={busy} onClick={() => void remove(model)}>删除</UiButton></div>
      </div>)}
      {!models.some((item) => item.kind === kind) && <div className="dc-settings-empty">还没有{kind === 'image' ? '图片' : '视频'}模型，添加后即可在节点中选择。</div>}
    </div>
    {!form && <UiButton variant="outline" onClick={() => open()}>＋ 添加{kind === 'image' ? '图片' : '视频'}模型</UiButton>}
    {form && <form className="dc-model-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h3>{form.id ? '编辑模型' : '添加模型'}</h3>
      <label>显示名称<UiInput ref={nameInput} required maxLength={120} value={form.name} placeholder="例如：我的图片模型" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <div className="dc-form-columns">
        <label>调用协议<UiSelect label="调用协议" value={form.protocol} onChange={(value) => setForm({ ...form, protocol: value as Protocol })}
          options={(Object.keys(ProtocolLabels) as Protocol[]).filter((protocol) => (protocol === 'openai-video') === (form.kind === 'video')).map((protocol) => ({ value: protocol, label: ProtocolLabels[protocol] }))} /></label>
        <label>Model ID<UiInput required maxLength={200} value={form.model_id} onChange={(event) => setForm({ ...form, model_id: event.target.value })} /></label>
      </div>
      <label>API Base<UiInput required type="url" value={form.api_base} autoComplete="off" onChange={(event) => setForm({ ...form, api_base: event.target.value })} /></label>
      <label>API Key<UiInput type="password" value={key} autoComplete="new-password" disabled={clearKey} placeholder={form.id && models.find((model) => model.id === form.id)?.has_api_key ? `${KEY_MASK} · 留空保留原密钥` : '输入密钥（本地无鉴权服务可留空）'} onChange={(event) => setKey(event.target.value)} /></label>
      {form.id && <UiCheckbox label="清除已有密钥" checked={clearKey} onChange={setClearKey} />}
      <div className="dc-form-actions"><UiButton variant="outline" disabled={busy} onClick={() => { setForm(null); setKey('') }}>取消</UiButton><UiButton variant="primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存模型'}</UiButton></div>
    </form>}
    {error && <p className="dc-error" role="alert">{error}</p>}{message && <p className="dc-success" role="status">{message}</p>}
    <TtsSettings api={api} />
    <p className="dc-settings-footnote">配置、画布和媒体保存在运行 Harness 的本机。保存后仅显示密钥掩码；实际生成会将提示词和参考素材发送到你配置的模型服务。</p>
  </section>
}
