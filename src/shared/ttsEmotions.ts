export interface TtsEmotion { tag: string; label: string; group: string }
// FishTTS guide: https://apidoc.modellink.online/7812015m0
const groups: Array<[string, Array<[string, string]>]> = [
  ['情绪', [['happy', '开心'], ['sad', '悲伤'], ['angry', '愤怒'], ['excited', '兴奋'], ['calm', '平静'], ['nervous', '紧张'], ['confident', '自信'], ['surprised', '惊讶'], ['empathetic', '共情'], ['sarcastic', '讽刺'], ['grateful', '感激'], ['curious', '好奇'], ['frustrated', '沮丧'], ['proud', '自豪']]],
  ['语气', [['shouting', '大声喊'], ['whispering', '低声耳语'], ['soft tone', '柔和语气'], ['in a hurry tone', '急促语气'], ['screaming', '尖叫']]],
  ['声音与停顿', [['laughing', '大笑'], ['chuckling', '轻笑'], ['sighing', '叹气'], ['sobbing', '抽泣'], ['groaning', '呻吟'], ['panting', '喘气'], ['break', '短暂停顿'], ['long-break', '长暂停顿']]],
  ['更多表达', [['friendly', '友好'], ['mysterious', '神秘'], ['scared', '害怕'], ['enthusiastic', '热情'], ['helpful', '乐于帮助'], ['concerned', '担忧'], ['encouraging', '鼓励'], ['narrator', '旁白'], ['relieved', '释然'], ['brave', '勇敢'], ['struggling', '挣扎'], ['triumphant', '胜利'], ['uncertain', '不确定'], ['audience laughing', '观众大笑'], ['background laughter', '背景笑声'], ['crowd laughing', '人群大笑'], ['slightly sad', '略微悲伤'], ['very excited', '非常兴奋']]],
]
export const TTS_EMOTIONS: readonly TtsEmotion[] = groups.flatMap(([group, entries]) => entries.map(([tag, label]) => ({ tag, label, group })))
const emotionByTag = new Map(TTS_EMOTIONS.map((item) => [item.tag, item]))
export interface EmotionPart { kind: 'text' | 'mention'; value: string; start: number; end: number }
/** Only documented tokens become badges; the stored text remains the original FishTTS syntax. */
export function emotionParts(text: string): EmotionPart[] {
  const parts: EmotionPart[] = []
  let cursor = 0
  for (const match of text.matchAll(/\(([^()\r\n]+)\)/g)) {
    if (!emotionByTag.has(match[1])) continue
    if (match.index > cursor) parts.push({ kind: 'text', value: text.slice(cursor, match.index), start: cursor, end: match.index })
    parts.push({ kind: 'mention', value: match[0], start: match.index, end: match.index + match[0].length })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor), start: cursor, end: text.length })
  return parts
}
export function emotionForToken(token: string): TtsEmotion | undefined { return emotionByTag.get(token.slice(1, -1)) }
export function emotionQuery(text: string, caret: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /@([^@\s()]*)$/.exec(before)
  return match ? { start: caret - match[0].length, end: caret, query: match[1] } : null
}
export function filterEmotions(query: string): readonly TtsEmotion[] {
  const q = query.toLocaleLowerCase()
  return TTS_EMOTIONS.filter((item) => `${item.label} ${item.tag} ${item.group}`.toLocaleLowerCase().includes(q))
}
export function insertEmotion(text: string, query: { start: number; end: number }, tag: string) {
  if (!TTS_EMOTIONS.some((item) => item.tag === tag)) throw new Error('未知情绪标签')
  const token = `(${tag})`
  return { text: text.slice(0, query.start) + token + text.slice(query.end), caret: query.start + token.length }
}
