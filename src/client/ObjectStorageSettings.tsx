import { useEffect, useState } from 'react'
import { StorageInputSchema, STORAGE_REQUIRED, type ObjectStorageSettings as Settings, type StorageInput } from '../shared/objectStorage'
import { CanvasApi } from './api'
import { UiButton, UiInput, UiSelect } from './ui'
import { invalidateMediaUrls } from './SignedMedia'

const empty = { type: 'aliyun-oss' as const, name: '阿里云 OSS', region: 'oss-cn-hangzhou', bucket: '', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', prefix: 'dsh-canvas', accessKeyId: '', accessKeySecret: '' }
export function ObjectStorageSettings({ api, onChanged }: { api: CanvasApi; onChanged?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [form, setForm] = useState<Partial<StorageInput>>(empty)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const load = () => api.storage().then(setSettings).catch((e) => setError(e.message))
  useEffect(() => { let live = true; void api.storage().then((s) => { if (live) setSettings(s) }).catch((e) => { if (live) setError(e.message) }); return () => { live = false } }, [api])
  const change = (key: keyof StorageInput, value: string) => {
    setMessage(''); setForm((old) => ({ ...old, [key]: value, ...(key === 'region' ? { endpoint: `https://${value}.aliyuncs.com` } : {}) }))
  }
  const submit = async (test: boolean) => {
    if (!settings || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const input = StorageInputSchema.parse({ ...form, requestId: crypto.randomUUID(), revision: settings.revision })
      if (test) { await api.testStorage(input); setMessage('连接测试通过：写入、读取和探测清理正常') }
      else {
        setSettings(await api.setStorage(input)); invalidateMediaUrls(api); setForm(empty); setMessage('对象存储已保存并启用'); onChanged?.()
      }
    } catch (e) { setError(e instanceof Error ? e.message : '对象存储操作失败'); await load() }
    finally { setBusy(false) }
  }
  return <section className="dc-storage-settings" aria-label="对象存储设置">
    <h3>对象存储</h3>
    <p className="dc-muted">{settings?.configured ? '媒体保存到当前对象存储。停用配置仍可读取历史资源，已接受任务继续按原目标完成。' : STORAGE_REQUIRED}</p>
    <div className="dc-model-list">{settings?.providers.map((provider) => <div className="dc-model-row" key={provider.id}>
      <div className="dc-model-info"><strong>{provider.name}</strong><small>{provider.bucket} · {provider.region} · {provider.active ? '当前使用' : '已停用'}</small></div>
      <UiButton variant="outline" disabled={busy} onClick={() => {
        const { id, type, name, region, bucket, endpoint, prefix } = provider
        setForm({ id, type, name, region, bucket, endpoint, prefix, accessKeyId: '', accessKeySecret: '' }); setError(''); setMessage('')
      }}>配置</UiButton>
    </div>)}</div>
    <form className="dc-model-form" onSubmit={(e) => { e.preventDefault(); void submit(false) }}>
      <h3>{form.id ? '更新配置并启用' : '添加对象存储'}</h3>
      <label>提供商<UiSelect label="对象存储提供商" value="aliyun-oss" disabled={busy} options={[{ value: 'aliyun-oss', label: '阿里云 OSS' }]} onChange={() => {}} /></label>
      <div className="dc-form-columns">
        <label>配置名称<UiInput value={form.name ?? ''} disabled={busy} onChange={(e) => change('name', e.target.value)} /></label>
        <label>地域 Region<UiInput value={form.region ?? ''} disabled={busy} onChange={(e) => change('region', e.target.value)} placeholder="oss-cn-hangzhou" /></label>
        <label>Bucket<UiInput value={form.bucket ?? ''} disabled={busy} onChange={(e) => change('bucket', e.target.value)} /></label>
        <label>根路径前缀<UiInput value={form.prefix ?? ''} disabled={busy} onChange={(e) => change('prefix', e.target.value)} /></label>
      </div>
      <label>外网 Endpoint<UiInput value={form.endpoint ?? ''} disabled={busy} onChange={(e) => change('endpoint', e.target.value)} /></label>
      <div className="dc-form-columns">
        <label>AccessKey ID<UiInput type="password" autoComplete="new-password" value={form.accessKeyId ?? ''} disabled={busy} placeholder={form.id ? '留空保留原凭据' : 'RAM AccessKey ID'} onChange={(e) => change('accessKeyId', e.target.value)} /></label>
        <label>AccessKey Secret<UiInput type="password" autoComplete="new-password" value={form.accessKeySecret ?? ''} disabled={busy} placeholder={form.id ? '留空保留原凭据' : 'RAM AccessKey Secret'} onChange={(e) => change('accessKeySecret', e.target.value)} /></label>
      </div>
      <div className="dc-form-actions">
        {form.id && <UiButton variant="outline" disabled={busy} onClick={() => setForm(empty)}>添加新配置</UiButton>}
        <UiButton variant="outline" disabled={!settings || busy} onClick={() => void submit(true)}>测试连接</UiButton>
        <UiButton variant="primary" type="submit" disabled={!settings || busy}>{busy ? '验证中…' : '保存并启用'}</UiButton>
      </div>
    </form>
    {error && <p className="dc-error" role="alert">{error}</p>}{message && <p className="dc-success" role="status">{message}</p>}
    {!!settings?.failed && <UiButton onClick={() => void api.retryMoves().then(load)}>重试资源搬移</UiButton>}
    <p className="dc-settings-footnote">使用已有私有 Bucket 和具备前缀读写权限的 RAM 凭据。媒体按“文件夹 / 画布 / 资源”归纳，重命名保留旧对象副本。</p>
  </section>
}
