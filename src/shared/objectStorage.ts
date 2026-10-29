import { z } from 'zod'

export const STORAGE_REQUIRED = '请前往设置页面设置对象存储'
export const StorageInputSchema = z.object({
  requestId: z.string().uuid(), revision: z.number().int().nonnegative(),
  id: z.string().uuid().optional(), type: z.literal('aliyun-oss'),
  name: z.string().trim().min(1).max(80),
  region: z.string().regex(/^oss-(?:cn-[a-z]+|(?:us|eu|ap|me|na)-[a-z]+-\d+)$/, '请填写标准外网 OSS 地域'),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  endpoint: z.string().url(),
  prefix: z.string().trim().max(240).default('dsh-canvas')
    .transform((v) => v.replace(/^\/+|\/+$/g, ''))
    .refine((v) => !!v && new TextEncoder().encode(v).length <= 240 && !v.split('/').some((p) => !p || p === '.' || p === '..') && !/[\\\x00-\x1f]/.test(v), '根路径前缀无效'),
  accessKeyId: z.string().trim().max(512).optional(),
  accessKeySecret: z.string().trim().max(512).optional(),
}).strict().refine((v) => v.endpoint === `https://${v.region}.aliyuncs.com`, {
  message: '请使用地域对应的阿里云标准外网 HTTPS Endpoint', path: ['endpoint'],
})
export type StorageInput = z.infer<typeof StorageInputSchema>
export interface PublicStorageProvider {
  id: string; type: 'aliyun-oss'; name: string; region: string; bucket: string; endpoint: string; prefix: string
  active: boolean; hasCredentials: boolean; accessKeyIdMask: string; accessKeySecretMask?: string; verifiedAt: number; revision: number
}
export interface ObjectStorageSettings {
  configured: boolean; activeProviderId: string | null; revision: number
  providers: PublicStorageProvider[]; moving: number; failed: number
}
export interface ObjectLocator {
  providerId: string; objectKey: string; bytes: number; mime: string; sha256: string
  etag?: string; versionId?: string; credentialRef?: string
}
export const MediaVariantSchema = z.enum(['original', 'preview', 'waveform'])
export type MediaVariant = z.infer<typeof MediaVariantSchema>
export const MediaUrlsSchema = z.object({
  items: z.array(z.object({ assetId: z.string().uuid(), variant: MediaVariantSchema.default('original') }).strict()).min(1).max(100),
  force: z.boolean().default(false),
}).strict()
export interface MediaUrl { assetId: string; variant: MediaVariant; url: string; expiresAt: number }
