import { emotionParts, emotionForToken, emotionQuery, TTS_EMOTIONS } from '../shared/ttsEmotions'
import type { PromptEditorCodec } from './promptEditorController'

export const EMOTION_CHOICES = TTS_EMOTIONS.map((item) => ({ ...item, token: `(${item.tag})`, name: `${item.label} ${item.tag} ${item.group}` }))
export type EmotionChoice = typeof EMOTION_CHOICES[number]
function syncBadge(chip: HTMLElement): void {
  const token = chip.dataset.promptToken!
  const emotion = emotionForToken(token)
  chip.className = 'dc-prompt-token dc-emotion-token'
  const text = emotion ? `@${emotion.label}` : token
  if (chip.textContent !== text) chip.textContent = text
  chip.title = emotion ? `${emotion.label} ${token}` : token
}
export const emotionEditorCodec: PromptEditorCodec = {
  parts: emotionParts, query: emotionQuery, suffix: '',
  sync: (root) => { for (const chip of root.querySelectorAll<HTMLElement>('[data-prompt-token]')) syncBadge(chip) },
  render: (root, value) => {
    root.dataset.empty = String(!value)
    const fragment = root.ownerDocument.createDocumentFragment()
    for (const part of emotionParts(value)) {
      if (part.kind === 'text') { fragment.append(root.ownerDocument.createTextNode(part.value)); continue }
      const chip = root.ownerDocument.createElement('span')
      chip.dataset.promptToken = part.value
      chip.contentEditable = 'false'; chip.setAttribute('contenteditable', 'false')
      syncBadge(chip); fragment.append(chip)
    }
    if (!value || value.endsWith('\n')) { const end = root.ownerDocument.createElement('br'); end.dataset.promptEnd = ''; fragment.append(end) }
    root.replaceChildren(fragment)
  },
}
