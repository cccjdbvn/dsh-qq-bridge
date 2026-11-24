// ffmpeg 封装：把任意音视频转成 16k 单声道 wav，供本地听写使用。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export function createAudioTools({ ffmpegPath = 'ffmpeg', logger, timeoutMs = 180000 } = {}) {
  function run(args, timeout = timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        reject(Error('ffmpeg 超时'))
      }, timeout)
      child.stderr.on('data', (chunk) => {
        // 只留尾巴：ffmpeg 的输出很长，出错时最后几行才有用。
        stderr = (stderr + chunk).slice(-4000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(Error(`ffmpeg 启动失败（${ffmpegPath}）：${error?.message ?? error}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else {
          logger?.warn?.(`ffmpeg 失败（exit ${code}）：${stderr.slice(-500)}`)
          reject(Error(`ffmpeg 处理失败（exit ${code}）`))
        }
      })
    })
  }

  /** 转成 16k 单声道 wav；可选只取前 N 秒（长视频听写别一上来跑半小时）。 */
  async function toWav16k(input, output, { seconds = 0 } = {}) {
    if (!existsSync(input)) throw Error(`音频文件不存在：${input}`)
    const args = ['-y', '-i', input]
    if (Number(seconds) > 0) args.push('-t', String(Math.min(3600, Number(seconds))))
    args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', output)
    await run(args)
    if (!existsSync(output)) throw Error('ffmpeg 没有生成 wav 文件')
    return output
  }

  /** 下载一个媒体地址到本地文件（B 站音频流需要 referer）。 */
  async function download(url, output, { referer = 'https://www.bilibili.com/', userAgent, timeoutMs: downloadTimeout = 120000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), downloadTimeout)
    try {
      const response = await fetch(url, {
        headers: {
          ...(referer ? { referer } : {}),
          ...(userAgent ? { 'user-agent': userAgent } : {}),
          accept: '*/*',
        },
        signal: controller.signal,
        redirect: 'follow',
      })
      if (!response.ok) throw Error(`媒体下载失败（HTTP ${response.status}）`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 1024) throw Error('媒体下载内容过小，可能不是有效音频')
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, bytes)
      return { file: output, bytes: bytes.length }
    } finally {
      clearTimeout(timer)
    }
  }

  return { toWav16k, download, run }
}
