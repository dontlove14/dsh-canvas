import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const docsRoot = resolve(root, 'docs')
const failures = []
const contents = new Map()
const label = (file) => relative(root, file)
const fail = (file, message) => failures.push(`${label(file)}: ${message}`)

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    const file = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await markdownFiles(file))
    else if (entry.isFile() && extname(file) === '.md') result.push(file)
  }
  return result.sort()
}

async function read(file) {
  if (!contents.has(file)) contents.set(file, await readFile(file, 'utf8'))
  return contents.get(file)
}

function withoutCode(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
}

function anchors(text) {
  const result = new Set()
  const counts = new Map()
  for (const match of withoutCode(text).matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)) {
    const title = match[1].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    const base = title.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-')
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    result.add(count ? `${base}-${count}` : base)
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1])
  return result
}

async function checkLinks(file, text) {
  for (const match of withoutCode(text).matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].trim().replace(/^<([^>]+)>.*$/, '$1').replace(/\s+["'][\s\S]*$/, '')
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue
    const hash = target.indexOf('#')
    const rawPath = (hash < 0 ? target : target.slice(0, hash)).split('?')[0]
    try {
      const destination = rawPath ? resolve(dirname(file), decodeURIComponent(rawPath)) : file
      const info = await stat(destination)
      if (hash >= 0 && info.isFile() && extname(destination) === '.md') {
        const fragment = decodeURIComponent(target.slice(hash + 1))
        if (fragment && !anchors(await read(destination)).has(fragment))
          fail(file, `不存在的锚点：${target}`)
      }
    } catch {
      fail(file, `本地链接不可访问：${target}`)
    }
  }
}

const files = [resolve(root, 'README.md'), resolve(root, 'AGENTS.md'), ...await markdownFiles(docsRoot)]
for (const file of files) {
  const text = await read(file)
  for (const field of ['文档类型：', '负责人：', '最近核对：']) {
    if (!text.includes(field)) fail(file, `缺少元数据 ${field}`)
  }
  if (!/最近核对：\d{4}-\d{2}-\d{2}/.test(text)) fail(file, '缺少 YYYY-MM-DD 核对日期')
  await checkLinks(file, text)
}

const adrRoot = resolve(docsRoot, 'adr')
const adrIndex = await read(resolve(adrRoot, 'index.md'))
const adrFiles = files.filter((file) => dirname(file) === adrRoot && /^\d{4}-/.test(relative(adrRoot, file))).sort()
const sections = ['背景与驱动因素', '决策', '备选方案', '后果', '可逆性与重审条件', '验证与证据']

if (!adrFiles.length) fail(resolve(adrRoot, 'index.md'), '没有 ADR')
for (const [index, file] of adrFiles.entries()) {
  const text = await read(file)
  const name = relative(adrRoot, file)
  const id = name.slice(0, 4)
  if (Number(id) !== index + 1) fail(file, 'ADR 编号必须从 0001 连续递增')
  if (!text.startsWith(`# ADR-${id}：`)) fail(file, '标题编号与文件编号不一致')
  const status = /^状态：(已采纳（补录）|已采纳|提议|已替代|已撤销)[ \t]*$/m.exec(text)?.[1]
  if (!status) fail(file, '缺少有效 ADR 状态')
  if (!/(?:补录日期|记录日期)：\d{4}-\d{2}-\d{2}/.test(text)) fail(file, '缺少记录或补录日期')
  if (status === '已采纳（补录）' && !/补录日期：\d{4}-\d{2}-\d{2}/.test(text))
    fail(file, '补录 ADR 必须标明补录日期')
  for (const section of sections) {
    if (!text.includes(`## ${section}\n`)) fail(file, `缺少章节 ${section}`)
  }
  const context = text.split('## 背景与驱动因素\n')[1]?.split('\n## ')[0] ?? ''
  if ([...context.matchAll(/^\d+\.\s/gm)].length < 2) fail(file, '至少记录两个驱动因素')
  const alternatives = text.split('## 备选方案\n')[1]?.split('\n## ')[0] ?? ''
  if (alternatives.split('\n').filter((line) => line.startsWith('|')).length < 4)
    fail(file, '至少记录两个备选方案')
  if (!text.includes('正面：') || !text.includes('负面：')) fail(file, '缺少正面或负面后果')
  if (!/\]\(\.\.\/\.\.\/(?:src|scripts|tests|package\.json|tsconfig)/.test(text))
    fail(file, '缺少本地实现或测试证据')
  if (!adrIndex.includes(`](${name})`)) fail(file, '未被 ADR 索引引用')
}

if (failures.length) {
  console.error(`文档检查失败（${failures.length} 项）:\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`文档检查通过：${files.length} 份 Markdown，${adrFiles.length} 条 ADR；本地链接、锚点、元数据与决策结构有效。`)
}
