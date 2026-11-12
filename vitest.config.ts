import { defineConfig } from 'vitest/config'

export default defineConfig({
  // img-fx is now fixed upstream source in the normal module graph.
  test: { server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-dockkit'] } } },
})
