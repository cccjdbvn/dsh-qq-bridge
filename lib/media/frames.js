// 视频抽帧：打开一个视频页，把播放器里的画面按时间点截下来。
//
// 用浏览器截图而不是解析视频流：B站有 dash + 防盗链 + 登录校验，直接下流容易碎；
// 而浏览器已经把画面解码好了，截元素就是「她能看到的那一帧」。
// 注意：截的是播放器的渲染结果，暂停/黑屏时截到的就是黑的，所以每帧先等 seeked。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createFrameCapture({ browser, logger, dir } = {}) {
  if (!browser) throw Error('抽帧缺少浏览器控制')
  if (!dir) throw Error('抽帧缺少截图目录')

  /**
   * @param {string} url 视频页地址
   * @param {{ times?: number[], waitSelector?: string, prefix?: string }} options
   *        times：0–1 之间的时间比例（默认取开头、中间、结尾附近各一帧）
   */
  async function capture(url, { times = [0.15, 0.5, 0.85], waitSelector = 'video', prefix = 'video' } = {}) {
    const p = await browser.page()
    await p.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 45000 })
    await p.waitForSelector(waitSelector, { timeout: 20000 }).catch(() => {
      throw Error('视频播放器没有出现在页面上（可能要登录或页面结构变了）')
    })

    // 等元数据：duration 出来才能按比例算时间点。
    let duration = 0
    for (let attempt = 0; attempt < 20; attempt++) {
      duration = await p
        .evaluate((selector) => {
          const video = document.querySelector(selector)
          if (!video) return 0
          return Number.isFinite(video.duration) && video.duration > 1 ? video.duration : 0
        }, waitSelector)
        .catch(() => 0)
      if (duration > 1) break
      await p.waitForTimeout(500)
    }
    if (!duration) {
      logger?.warn?.('视频时长没取到，抽帧可能失败')
      duration = 0
    }

    mkdirSync(dir, { recursive: true })
    const stamp = Date.now()
    const frames = []
    for (const ratio of times) {
      const at = duration ? Math.max(0, Math.min(duration - 0.6, duration * ratio)) : 0
      try {
        await p.evaluate(
          async ({ selector, seconds }) => {
            const video = document.querySelector(selector)
            if (!video) return
            try {
              video.pause()
            } catch {
              /* 暂停失败不影响截帧 */
            }
            if (!seconds) return
            await new Promise((resolve) => {
              let done = false
              const finish = () => {
                if (done) return
                done = true
                resolve()
              }
              video.addEventListener('seeked', finish, { once: true })
              setTimeout(finish, 4000)
              try {
                video.currentTime = seconds
              } catch {
                finish()
              }
            })
          },
          { selector: waitSelector, seconds: at },
        )
        await p.waitForTimeout(400)
        const file = join(dir, `${prefix}-${stamp}-${Math.round(at)}s.png`)
        await p.locator(waitSelector).first().screenshot({ path: file })
        frames.push({ at: Math.round(at), file })
      } catch (error) {
        logger?.warn?.(`抽帧失败（${Math.round(at)} 秒）：${error?.message ?? error}`)
      }
    }
    return { duration: Math.round(duration), frames }
  }

  return { capture }
}
