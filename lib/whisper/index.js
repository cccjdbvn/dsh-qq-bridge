// 本地听写：faster-whisper（Python venv）+ 音频文件 → 文字。
//
// 模型首次使用时从 hf-mirror 下载到 modelsDir；之后离线可用。
// 不依赖任何云服务，也不把音频发出去。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'transcribe.py')

export function createWhisper({ venvDir, modelsDir, model = 'small', language = 'zh', ffmpegPath = 'ffmpeg', logger, timeoutMs = 240000 } = {}) {
  if (!venvDir) throw Error('听写模块缺少 venv 目录')
  const python = join(venvDir, 'Scripts', 'python.exe')

  function available() {
    return existsSync(python) && existsSync(SCRIPT)
  }

  function run(audio, options = {}) {
    return new Promise((resolve, reject) => {
      if (!available()) {
        reject(Error('本地听写未安装（venv 里没有 faster-whisper）'))
        return
      }
      if (!existsSync(audio)) {
        reject(Error(`音频文件不存在：${audio}`))
        return
      }
      const args = [
        SCRIPT,
        audio,
        String(options.model || model),
        String(options.language || language),
        String(options.modelsDir || modelsDir || ''),
        String(options.ffmpegPath || ffmpegPath || 'ffmpeg'),
      ]
      const child = spawn(python, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
          HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
        },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        reject(Error(`本地听写超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        try {
          const value = JSON.parse(line)
          if (value.ok === true) resolve({ ...value, model: String(options.model || model) })
          else reject(Error(String(value.error || '听写失败')))
        } catch {
          logger?.warn?.(`whisper 输出无法解析（exit ${code}）：${(stderr || stdout).slice(-400)}`)
          reject(Error(`听写输出无法解析（exit ${code}）`))
        }
      })
    })
  }

  return { run, available, python, modelsDir }
}
