// 音频分析（BPM / 包络 / 静音比例）：把 pcm 交给 Python + numpy 算。
//
// 为什么不用 Node 算：FFT/自相关手写容易算错，而听写那边已经有一个带 numpy 的
// venv（faster-whisper 的依赖），直接复用，不额外装东西。
import { spawn } from 'node:child_process'

export function createAudioAnalyzer({ python, script, logger, timeoutMs = 60000 } = {}) {
  if (!python) throw Error('音频分析缺少 Python 路径')
  if (!script) throw Error('音频分析缺少脚本路径')

  function run(pcmFile, sampleRate) {
    return new Promise((resolve, reject) => {
      const child = spawn(python, [script, pcmFile, String(sampleRate)], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        reject(Error(`音频分析超时（${Math.round(timeoutMs / 1000)} 秒）`))
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-1500)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(Error(`音频分析启动失败：${error?.message ?? error}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
        try {
          const value = JSON.parse(line)
          if (value.ok === true) resolve(value)
          else reject(Error(String(value.error || '音频分析失败')))
        } catch {
          logger?.warn?.(`音频分析输出无法解析（exit ${code}）：${(stderr || stdout).slice(-300)}`)
          reject(Error(`音频分析输出无法解析（exit ${code}）`))
        }
      })
    })
  }

  return { run }
}
