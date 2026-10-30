import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JSX from 'react/jsx-runtime'

/** Real SDK ModelSelect; primitive shells preserve refs/roles, without claiming browser styling QA. */
export function nativeHarnessModelSelect(): React.ComponentType<any> {
  const primitives = new Proxy({
    Input: React.forwardRef<HTMLInputElement, any>((props, ref) => <input {...props} ref={ref} />),
    MenuSurface: React.forwardRef<HTMLDivElement, any>((props, ref) => <div {...props} ref={ref} />),
    MenuGroup: ({ label, children }: any) => <section><div>{label}</div>{children}</section>,
    rankByName: (models: any[], query: string) => models.filter((model) => model.name.toLowerCase().includes(query.toLowerCase())),
    observeStickyMenuGroups: () => () => {},
  } as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : () => null })
  const peers: Record<string, unknown> = {
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/cordis': { Service: class {} },
    '@deepseek-ai/dsh-client-store': {},
    'react/jsx-runtime': JSX, react: React, 'react-dom': ReactDOM,
  }
  let body!: { apply: (ctx: any) => void }
  const source = readFileSync(resolve('node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js'), 'utf8')
  const loaderWindow = window as typeof window & { __ModuleLoader__?: unknown }
  const previous = loaderWindow.__ModuleLoader__
  loaderWindow.__ModuleLoader__ = { load: ({ factory }: any) => {
    body = factory((name: string) => {
      if (!(name in peers)) throw new Error(`Unexpected native model peer: ${name}`)
      return peers[name]
    })
  } }
  try { new Function('window', source)(window) }
  finally { if (previous === undefined) delete loaderWindow.__ModuleLoader__; else loaderWindow.__ModuleLoader__ = previous }
  let component!: React.ComponentType<any>
  const scope = {
    modelDirectories: {}, sessions: {},
    slots: {
      inject: (_name: string, install: () => unknown) => install(),
      register: (_options: unknown, Body: React.ComponentType<any>) => { component = Body; return () => {} },
    },
  }
  body.apply({
    effect: (install: () => unknown) => install(),
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    plugin: () => {},
    inject: (names: string[], install: (ctx: unknown) => void) => { if (names[0] === 'slots') install(scope) },
  })
  return component
}
