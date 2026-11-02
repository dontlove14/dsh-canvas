import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as JSX from 'react/jsx-runtime'
import * as Store from '@deepseek-ai/dsh-client-store'
import * as Cordis from '@deepseek-ai/cordis'

/** Execute the published SDK unchanged; expose its menu only for integration assertions. */
export function nativeInputTrigger() {
  const peers: Record<string, unknown> = {
    '@deepseek-ai/cordis': Cordis, react: React, 'react/jsx-runtime': JSX, '@deepseek-ai/dsh-client-store': Store,
    '@deepseek-ai/dsh-client-ui-primitives': {
      useAnchoredMaxHeight: () => 400,
      MenuSurface: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => <div {...props} ref={ref} />),
      IconFileOutlineRegular: () => null, IconFolderOutlineRegular: () => null, IconSessionOutlineRegular: () => null,
      IconChevronRightOutlineRegular: () => null,
      ReferenceIconRegular: () => null,
    },
  }
  const source = readFileSync(resolve('node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js'), 'utf8')
    .replace('exports.apply = apply;', 'exports.MenuView = MenuView; exports.apply = apply;')
  let sdk: any
  new Function('window', source)({ __ModuleLoader__: { load: ({ factory }: any) => {
    sdk = factory((name: string) => { if (!(name in peers)) throw new Error(`Unexpected input peer ${name}`); return peers[name] })
  } } })
  return sdk
}
