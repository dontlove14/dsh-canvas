import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as JSX from 'react/jsx-runtime'
import * as Store from '@deepseek-ai/dsh-client-store'

/** Exercise the unmodified published plan navigation and preview components. */
export function nativeHarnessPlan() {
  const peers: Record<string, unknown> = {
    '@deepseek-ai/cordis': {}, react: React, 'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-store': Store,
    '@deepseek-ai/dsh-client-ui-primitives': {
      IconChevronRightOutlineRegular: () => null,
      MarkdownText: ({ text }: { text: string }) => <div data-native-markdown>{text}</div>,
      extractMarkdownPlainText: (text: string) => text.split('\n')[0].replace(/^#+\s*/, ''),
    },
  }
  const source = readFileSync(resolve('node_modules/@deepseek-ai/dsh-client-ui-plan/lib/client.js'), 'utf8')
    .replace('exports.apply = apply;', 'exports.PlanReviewOpen = PlanReviewOpen; exports.PlanPreview = PlanPreview; exports.submittedPlan = submittedPlan; exports.apply = apply;')
  let sdk: any
  const loaderWindow = window as typeof window & { __ModuleLoader__?: unknown }, previous = loaderWindow.__ModuleLoader__
  loaderWindow.__ModuleLoader__ = { load: ({ factory }: any) => { sdk = factory((name: string) => {
    if (!(name in peers)) throw new Error(`Unexpected plan peer: ${name}`)
    return peers[name]
  }) } }
  try { new Function('window', source)(window) }
  finally { if (previous === undefined) delete loaderWindow.__ModuleLoader__; else loaderWindow.__ModuleLoader__ = previous }
  return sdk
}
