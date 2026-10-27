import { z } from 'zod'

export const WAVEFORM_VERSION = '1'
export const WAVEFORM_BARS = 96
export const WaveformSchema = z.object({
  version: z.literal(1),
  duration: z.number().finite().positive().max(7200),
  peaks: z.array(z.number().finite().min(0).max(1)).length(WAVEFORM_BARS),
}).strict()
export type AudioWaveform = z.infer<typeof WaveformSchema>
