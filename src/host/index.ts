import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { z } from 'zod'
import { API_ROOT } from '../shared/contracts'
import { V2_ROOT } from '../shared/v2'
import { CanvasService, routeDefinitions } from './service'
import { HarnessVault } from './credentials'
import { CanvasAgentCoordinator } from './agent/coordinator'

export const name = 'dsh-canvas'
export const inject = ['connection', 'credentials', 'agents', 'llm', 'sessionController', 'agentPresets']
export const Config = z.object({
  dataDir: z.string().default(resolve(homedir(), '.dsh-canvas')),
  maxConcurrentTasks: z.number().int().min(1).max(8).default(2),
  pollIntervalMs: z.number().int().min(500).max(60000).default(3000),
  requestTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  maxMediaBytes: z.number().int().min(1024).max(1024 * 1024 * 1024).default(200 * 1024 * 1024),
  maxReferenceBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(20 * 1024 * 1024),
})
export type Config = z.infer<typeof Config>

/** Local service, mounted only through Harness's authenticated owner routes. */
export async function apply(ctx: Context, input: Partial<Config> = {}): Promise<void> {
  const config = Config.parse(input)
  const service = new CanvasService({ ...config, dataDir: resolve(config.dataDir) }, new HarnessVault(ctx.credentials))
  const coordinator = new CanvasAgentCoordinator(ctx, service)
  service.agentControl = coordinator
  service.runtime.dispatchGate = (taskId, operation) => coordinator.dispatch(taskId, operation)
  await service.init()
  coordinator.installModelSelectionGuard()
  coordinator.installPresetRosterGuard()
  ctx.effect(() => async () => { coordinator.presentation.close(); await coordinator.drain(); await service.close() })
  for (const route of routeDefinitions) ctx.effect(() => ctx.connection.fetch.register({
    path: `/${V2_ROOT}/${route.suffix}`,
    methods: route.methods,
    requestBody: route.requestBody,
    fetch: (request) => service.handle(request),
  }))
  ctx.effect(() => ctx.connection.fetch.register({
    path: `/${API_ROOT}/workspace`, methods: ['GET'], requestBody: 'buffered',
    fetch: (request) => service.handle(request),
  }))
}
