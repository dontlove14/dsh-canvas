import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Keep the real img-fx engine in Vitest's module graph so its WebGL driver
  // can be substituted in jsdom without mocking the component or scheduler.
  test: { server: { deps: { inline: ['img-fx', '@deepseek-ai/dsh-client-ui-dockkit'] } } },
})
