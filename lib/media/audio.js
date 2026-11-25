// ffmpeg 封装：转 wav（听写用）、测量、画波形/频谱、下载。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export function createAudioTools({ ffmpegPath = 'ffmpeg', logger, timeoutMs = 180000 } = {}) {
  // ffprobe 一般和 ffmpeg 同目录（winget 装的就是），也允许用环境变量指。
  const ffprobePath =
    String(process.env.FFPROBE_PATH || '').trim() ||
    (/ffmpeg(\.exe)?$/i.test(ffmpegPath) ? ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe')

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
        if (code === 0) resolve(stderr)
        else {
          logger?.warn?.(`ffmpeg 失败（exit ${code}）：${stderr.slice(-500)}`)
          reject(Error(`ffmpeg 处理失败（exit ${code}）`))
        }
      })
    })
  }

  /** 跑一个命令并收 stdout（ffprobe 用），stderr 只留尾巴。 */
  function runCapture(bin, args, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        reject(Error(`${bin} 超时`))
      }, timeout)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(Error(`${bin} 启动失败：${error?.message ?? error}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout)
        else reject(Error(`${bin} 失败（exit ${code}）：${stderr.slice(-300)}`))
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

  /**
   * 基本信息：容器、编码、采样率、声道、码率、时长。
   * 拿不到就返回空字段，让调用方自己说「不知道」，不猜。
   */
  async function probe(file) {
    if (!existsSync(file)) throw Error(`文件不存在：${file}`)
    const stdout = await runCapture(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ])
    const json = JSON.parse(stdout || '{}')
    const audio = (json.streams || []).find((s) => s.codec_type === 'audio') || {}
    const fmt = json.format || {}
    return {
      duration: Number(fmt.duration ?? audio.duration ?? 0) || 0,
      container: String(fmt.format_name ?? ''),
      codec: String(audio.codec_name ?? ''),
      sampleRate: Number(audio.sample_rate ?? 0) || 0,
      channels: Number(audio.channels ?? 0) || 0,
      bitRate: Number(fmt.bit_rate ?? audio.bit_rate ?? 0) || 0,
      sizeBytes: Number(fmt.size ?? 0) || 0,
    }
  }

  /** 响度：mean / max（dB）。用的是 volumedetect，够回答「这条是不是很轻/是不是爆了」。 */
  async function loudness(file) {
    if (!existsSync(file)) throw Error(`文件不存在：${file}`)
    const stderr = await run(['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
    const mean = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)
    const max = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)
    return {
      meanDb: mean ? Number(mean[1]) : null,
      maxDb: max ? Number(max[1]) : null,
    }
  }

  /** 波形图 / 频谱图（PNG）。看「有没有声音、哪里炸了」比读数字直观。 */
  async function picture(file, output, { kind = 'waveform', width = 1200, height = 320 } = {}) {
    if (!existsSync(file)) throw Error(`文件不存在：${file}`)
    const filter =
      kind === 'spectrum'
        ? `showspectrumpic=s=${width}x${height}:legend=1:scale=log`
        : `showwavespic=s=${width}x${height}:colors=#4a9eff`
    await run(['-y', '-i', file, '-lavfi', filter, '-frames:v', '1', output])
    if (!existsSync(output)) throw Error('ffmpeg 没有生成图片')
    return output
  }

  /** 解码成 22.05k 单声道 f32（给 BPM/包络分析用，Python 那边用 numpy 读）。 */
  async function extractMonoF32(input, output, { seconds = 0, sampleRate = 22050 } = {}) {
    if (!existsSync(input)) throw Error(`音频文件不存在：${input}`)
    const args = ['-y', '-i', input]
    if (Number(seconds) > 0) args.push('-t', String(Math.min(600, Number(seconds))))
    args.push('-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-acodec', 'pcm_f32le', output)
    await run(args)
    if (!existsSync(output)) throw Error('ffmpeg 没有生成 pcm 文件')
    return { file: output, sampleRate }
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

  return { toWav16k, download, run, probe, loudness, picture, extractMonoF32, ffprobePath }
}
