import { seedanceLimits, MINIMAX_VIDEO_LIMITS, WAN_VIDEO_LIMITS, KLING_VIDEO_LIMITS } from './modelCatalog'

/** Shared by input validation and Agent planning; absent capabilities remain unknown. */
export function videoReferenceDurations(model: { protocol: string; model_id: string }) {
  const seed = model.protocol === 'seedance-video' ? seedanceLimits(model.model_id) : null
  const maximum = seed?.duration ?? (model.protocol === 'minimax-video' ? MINIMAX_VIDEO_LIMITS.totalDuration
    : model.protocol === 'wan-video' ? WAN_VIDEO_LIMITS.totalDuration : model.protocol === 'kling-video' ? KLING_VIDEO_LIMITS.totalDuration : null)
  return { perVideo: maximum === null ? null : { min: seed || model.protocol === 'minimax-video' ? 2 : model.protocol === 'kling-video' ? 3 : 0, minExclusive: model.protocol === 'wan-video', max: maximum },
    perAudio: maximum === null || model.protocol === 'kling-video' ? null : { min: seed || model.protocol === 'minimax-video' ? 2 : 0, minExclusive: model.protocol === 'wan-video', max: maximum },
    totalVideo: maximum, totalAudio: model.protocol === 'kling-video' ? 0 : maximum,
    inputVideoPlusOutput: model.protocol === 'wan-video' ? maximum! * 2 : null,
    audioOnly: seed?.audioOnly ?? (['wan-video', 'minimax-video'].includes(model.protocol) ? true : model.protocol === 'kling-video' ? false : null) }
}
