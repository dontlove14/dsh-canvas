import { z } from 'zod'

/** Short values never expose their complete contents through a partial mask. */
export function maskSecret(value: string): string {
  if (!value) return ''
  return value.length <= 6 ? '********' : `${value.slice(0, 3)}********${value.slice(-3)}`
}

export const SettingSecretRequestSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('model'), id: z.string().uuid(), field: z.literal('api_key') }).strict(),
  z.object({ scope: z.literal('tts'), field: z.literal('api_key') }).strict(),
  z.object({ scope: z.literal('storage'), id: z.string().uuid(), field: z.enum(['accessKeyId', 'accessKeySecret']) }).strict(),
  z.object({ scope: z.literal('seedance-review'), provider: z.enum(['bytedance', 'byteplus']),
    field: z.enum(['projectName', 'accessKeyId', 'accessKeySecret']) }).strict(),
])
export type SettingSecretRequest = z.infer<typeof SettingSecretRequestSchema>
export interface SettingSecretResponse { value: string }
