// 空间配图的本地读取与格式校验（从 dsh-im-bridge 的 social-images.js 裁剪，MIT）。
//
// 只接受本机绝对路径、file:// 或 data:image/...;base64。
// 不在这里下载远程图片：发说说走 NapCat 原生工具，评论暂不支持带图。
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const MAX_BYTES = 12 * 1024 * 1024

export function imageBytes(bytes) {
  const b = Buffer.from(bytes)
  if (!b.length || b.length > MAX_BYTES) throw Error('配图应小于 12MB')
  const head = b.subarray(0, 16)
  let type = ''
  if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') type = 'png'
  else if (head[0] === 255 && head[1] === 216 && head[2] === 255) type = 'jpeg'
  else if (/^GIF8[79]a/.test(head.toString('ascii'))) type = 'gif'
  else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') type = 'webp'
  if (!type) throw Error('配图需要真实 PNG、JPEG、GIF 或 WebP 图片')
  return { bytes: b, mime: 'image/' + type, extension: type === 'jpeg' ? 'jpg' : type, hash: createHash('sha256').update(b).digest('hex') }
}

export function loadLocalImage(source) {
  if (typeof source === 'string' && /^data:image\/[\w.+-]+;base64,/i.test(source)) {
    const encoded = source.replace(/^data:image\/[\w.+-]+;base64,/i, '')
    if (encoded.length > 17 * 1024 * 1024 || !/^[-\w+/=\r\n]+$/.test(encoded)) throw Error('配图编码无效或过大')
    return { ...imageBytes(Buffer.from(encoded, 'base64')), file: '', source: 'inline' }
  }
  let file = String(source ?? '').trim()
  if (file.startsWith('file://')) file = decodeURIComponent(file.slice(7)).replace(/^\/([A-Za-z]:)/, '$1')
  if (!file || !isAbsolute(file)) throw Error('配图需要本机绝对路径、file:// 或 data:image/...;base64')
  if (statSync(file).size > MAX_BYTES) throw Error('配图应小于 12MB')
  return { ...imageBytes(readFileSync(file)), file, source: 'local' }
}
