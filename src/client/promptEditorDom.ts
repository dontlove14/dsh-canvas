import { promptParts } from '../shared/promptMentions'
export interface PromptChoice { token: string; name: string; label: string; assetId?: string }

const tokenOf = (node: Node): string | null => node.nodeType === 1 ? (node as Element).getAttribute('data-prompt-token') : null
export function editorText(root: Node): string {
  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === 3) { out += node.nodeValue ?? ''; return }
    const token = tokenOf(node)
    if (token !== null) { out += token; return }
    if (node.nodeType === 1) {
      const el = node as Element
      if (el.hasAttribute('data-prompt-end')) return
      if (el.tagName === 'BR') { out += '\n'; return }
      if (['DIV', 'P', 'LI'].includes(el.tagName) && out && !out.endsWith('\n')) out += '\n'
    }
    node.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return out
}
export interface EditorSelection { start: number; end: number }
export function editorSelection(root: HTMLElement): EditorSelection | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection?.rangeCount) return null
  const selected = selection.getRangeAt(0)
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return null
  const position = (node: Node, offset: number) => {
    const range = root.ownerDocument.createRange()
    range.selectNodeContents(root); range.setEnd(node, offset)
    return editorText(range.cloneContents()).length
  }
  return { start: position(selected.startContainer, selected.startOffset), end: position(selected.endContainer, selected.endOffset) }
}
export function restoreEditorSelection(root: HTMLElement, selection: EditorSelection): void {
  const length = editorText(root).length
  const point = (wanted: number): [Node, number] => {
    let remaining = Math.max(0, Math.min(length, wanted))
    const walk = (node: Node): [Node, number] | null => {
      const token = tokenOf(node)
      if (token !== null) {
        const parent = node.parentNode!
        const index = Array.prototype.indexOf.call(parent.childNodes, node)
        if (remaining === 0) return [parent, index]
        if (remaining <= token.length) return [parent, index + 1]
        remaining -= token.length; return null
      }
      if (node.nodeType === 3) {
        const size = node.nodeValue?.length ?? 0
        if (remaining <= size) return [node, remaining]
        remaining -= size; return null
      }
      if (node.nodeType === 1 && (node as Element).tagName === 'BR') {
        if (remaining === 0) return [node.parentNode!, Array.prototype.indexOf.call(node.parentNode!.childNodes, node)]
        if (!(node as Element).hasAttribute('data-prompt-end')) remaining--
        return null
      }
      for (const child of node.childNodes) { const found = walk(child); if (found) return found }
      return null
    }
    return walk(root) ?? [root, root.childNodes.length]
  }
  const range = root.ownerDocument.createRange()
  range.setStart(...point(selection.start)); range.setEnd(...point(selection.end))
  const browserSelection = root.ownerDocument.getSelection()
  browserSelection?.removeAllRanges(); browserSelection?.addRange(range)
}
function updateChip(chip: HTMLElement, reference: PromptChoice | undefined, preview: (id: string) => string): void {
  const valid = !!reference?.assetId
  chip.className = `dc-prompt-token${valid ? '' : ' invalid'}`
  chip.title = valid ? reference!.name : '素材已丢失或未连接，请重新引用或删除标签'
  const label = chip.querySelector('span')!
  label.textContent = valid ? `@${reference!.label}` : '@引用失效'
  const image = chip.querySelector('img')
  if (valid) {
    const src = preview(reference!.assetId!)
    if (image?.getAttribute('src') !== src) image?.setAttribute('src', src)
    if (image) image.hidden = false
  } else if (image) { image.removeAttribute('src'); image.hidden = true }
}
export function syncEditorChips(root: HTMLElement, references: readonly PromptChoice[], preview: (id: string) => string): void {
  const byToken = new Map(references.map((item) => [item.token, item]))
  for (const chip of root.querySelectorAll<HTMLElement>('[data-prompt-token]'))
    updateChip(chip, byToken.get(chip.dataset.promptToken!), preview)
}
export function renderEditor(root: HTMLElement, value: string, references: readonly PromptChoice[], preview: (id: string) => string): void {
  const doc = root.ownerDocument
  root.dataset.empty = String(value.length === 0)
  const fragment = doc.createDocumentFragment()
  const byToken = new Map(references.map((item) => [item.token, item]))
  for (const part of promptParts(value)) {
    if (part.kind === 'text') { fragment.append(doc.createTextNode(part.value)); continue }
    const chip = doc.createElement('span')
    chip.dataset.promptToken = part.value; chip.contentEditable = 'false'; chip.setAttribute('contenteditable', 'false')
    const image = doc.createElement('img')
    image.alt = ''; image.draggable = false
    image.addEventListener('error', () => { image.hidden = true })
    chip.append(image, doc.createElement('span'))
    updateChip(chip, byToken.get(part.value), preview); fragment.append(chip)
  }
  if (!value || value.endsWith('\n')) { const end = doc.createElement('br'); end.dataset.promptEnd = ''; fragment.append(end) }
  root.replaceChildren(fragment)
}
