import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JSX from 'react/jsx-runtime'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as DockKit from '@deepseek-ai/dsh-client-ui-dockkit'
import * as Zod from 'zod'

/** Export only SDK internals from the unmodified published bundle into this test loader. */
export function nativeHarnessSidebar() {
  const peers: Record<string, unknown> = {
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-ui-dockkit': DockKit, '@deepseek-ai/dsh-client-store': Store,
    'react/jsx-runtime': JSX, react: React, 'react-dom': ReactDOM, zod: Zod,
  }
  let sdk: any
  const source = readFileSync(resolve('node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js'), 'utf8')
    .replace('exports.apply = apply;', 'exports.createSidebarRightController = createSidebarRightController; exports.createSidebarRightStore = createSidebarRightStore; exports.SidebarRightTabRegistry = SidebarRightTabRegistry; exports.pageAddress = pageAddress; exports.apply = apply;')
  const loaderWindow = window as typeof window & { __ModuleLoader__?: unknown }, previous = loaderWindow.__ModuleLoader__
  loaderWindow.__ModuleLoader__ = { load: ({ factory }: any) => { sdk = factory((name: string) => {
    if (!(name in peers)) throw new Error(`Unexpected sidebar peer: ${name}`)
    return peers[name]
  }) } }
  try { new Function('window', source)(window) }
  finally { if (previous === undefined) delete loaderWindow.__ModuleLoader__; else loaderWindow.__ModuleLoader__ = previous }
  return sdk
}
