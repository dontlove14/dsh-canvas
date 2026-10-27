import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { HarnessUiProvider, UiMediaModal } from '../src/client/ui'
import { VideoPlayer } from '../src/client/VideoPlayer'

describe('minimal media UI', () => {
  it('renders the same small custom controls for node and original-video preview', () => {
    for (const preview of [false, true]) {
      const markup = renderToStaticMarkup(<VideoPlayer src="/original.mp4" label="测试视频" preview={preview} />)
      const videoTag = markup.match(/<video[^>]*>/)?.[0] ?? ''
      expect(videoTag).toContain('loop=""')
      expect(videoTag).toContain('playsinline=""')
      expect(videoTag).not.toMatch(/\b(?:controls|muted)=/)
      expect(markup.match(/<button\b/g)).toHaveLength(1)
      expect(markup).toContain('aria-label="播放视频"')
      expect(markup).toContain('type="range"')
      expect(markup).not.toMatch(/全屏|静音|更多|下载|另存/)
    }
  })

  it('uses the official headless modal with an accessible title and only its own close button', () => {
    const modal = vi.fn(({ title, children, className }: { title: string; children: ReactNode; className: string }) =>
      <div role="dialog" aria-label={title} className={className}>{children}</div>)
    const Button = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>
    const components = { Modal: modal, Button } as unknown as Parameters<typeof HarnessUiProvider>[0]['components']
    const markup = renderToStaticMarkup(<HarnessUiProvider components={components}>
      <UiMediaModal label="原图.png" onClose={() => {}}><img src="/original.png" alt="原图" /></UiMediaModal>
    </HarnessUiProvider>)
    expect(modal.mock.calls[0][0]).toMatchObject({ headless: true, backdropBlur: false, title: '原图.png' })
    expect(markup.match(/<button\b/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="关闭预览"')
    expect(markup).toContain('data-modal-autofocus="true"')
    expect(markup).not.toMatch(/<h[12]\b|另存|dc-preview-heading/)
  })

  it('keeps the standalone dialog minimal and labelled', () => {
    const markup = renderToStaticMarkup(<UiMediaModal label="原图.png" onClose={() => {}}><img src="/original.png" alt="原图" /></UiMediaModal>)
    expect(markup).toContain('<dialog')
    expect(markup).toContain('aria-labelledby=')
    expect(markup.match(/<button\b/g)).toHaveLength(1)
    expect(markup).not.toMatch(/dc-modal-close|另存|dc-preview-heading/)
  })
})
