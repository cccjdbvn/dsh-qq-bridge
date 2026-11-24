// 抖音：只做「单条链接观看」。搜索被连续验证码拦住，首页推荐流暂不开放。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const URL_RE = /https?:\/\/[^\s<>"'）】]+/i
const VIDEO_RE = /\/video\/(\d{6,})/
const MODAL_RE = /[?&]modal_id=(\d{6,})/

/** 从一段分享文案里挑出第一个链接。 */
export function extractDouyinUrl(text) {
  const match = String(text ?? '').match(URL_RE)
  return match ? match[0].replace(/[，。！？、；：]+$/, '') : ''
}

/** 从 /video/{id} 或 ?modal_id={id} 提取视频 id。 */
export function videoIdFromUrl(value) {
  const text = String(value ?? '')
  const match = text.match(VIDEO_RE) || text.match(MODAL_RE)
  return match ? match[1] : ''
}

export function createDouyinRuntime({ browser, shotsDir, logger } = {}) {
  if (!browser) throw Error('抖音运行时缺少浏览器控制')
  if (!shotsDir) throw Error('抖音运行时缺少截图目录')

  async function watch(input, options = {}) {
    const raw = String(input ?? '').trim()
    const url = /^https?:/i.test(raw) ? raw : extractDouyinUrl(raw)
    if (!url) throw Error('请提供抖音视频链接（或带链接的分享文案）')

    const page = await browser.page()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(8000)

    let videoId = videoIdFromUrl(page.url()) || videoIdFromUrl(url)
    if (!videoId) throw Error('这个链接不像抖音视频页（没找到 /video/ 或 modal_id）')

    const canonical = `https://www.douyin.com/video/${videoId}`
    if (!page.url().includes(`/video/${videoId}`)) {
      await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(8000)
    }

    const data = await page.evaluate(() => {
      const lines = (selector) =>
        (document.querySelector(selector)?.innerText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      // 作者：user-info 整段是「名字粉丝数获赞已关注」挤在一起，切掉后面的统计。
      const authorNode = document.querySelector('[data-e2e="user-info"]')
      const authorRaw = (authorNode?.innerText || '').replace(/\s+/g, '')
      const author =
        (authorRaw.match(/^(.*?)(?:粉丝|获赞|已关注|关注)/) || [null, ''])[1] || authorRaw.slice(0, 24)
      const publish = lines('[data-e2e="detail-video-publish-time"]').find((line) => line.includes('发布时间')) || ''
      // 评论节点第一行是头像占位/用户名，后面夹时间地点和点赞数；挑正文行并去掉「2月前·广东」。
      const comments = [...document.querySelectorAll('[data-e2e="comment-item"]')]
        .slice(0, 12)
        .map((el) => {
          const rows = el.innerText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((row) => row.length >= 2 && !/^\d+(\.\d+)?万?$/.test(row) && !/^(分享|回复|展开|举报)/.test(row))
          const body = (rows.slice(1).join(' ') || rows.join(' '))
            .replace(/^\.{2,}\s*/, '')
            .replace(/\d+[月天年]前·\S+/g, '')
            .trim()
          return body
        })
        .filter(Boolean)
      // 正文优先取视频详情区：整页 innerText 开头是抖音的页脚导航（ICP 备案那一串），
      // 1200 字里能有一半是它。没有详情区才退回 body，并滤掉这几类明显无关的行。
      const detailNode = document.querySelector('[data-e2e="video-detail"], main')
      const rawText = (detailNode?.innerText || document.body.innerText || '')
        .split('\n')
        .filter((line) => !/京ICP|京公网安备|许可证|备案|网络文化经营|电子营业执照|违法和不良|算法推荐|信息网络传播/.test(line))
        .join('\n')
        // 「推荐视频」之后是别的视频的简介，跟这一条没关系，直接截掉。
        .split(/推荐视频|下载客户端，桌面快捷访问/)[0]
      return {
        title: document.title.replace(/\s*-\s*抖音\s*$/, ''),
        author,
        publish,
        comments,
        // 页面全文只留一截：够核对标题/作者/评论区，不把整页导航灌给模型。
        pageText: rawText.slice(0, 1200),
        // 全文另存一份：抖音给部分视频生成「章节要点」，那是比听写更准的摘要，
        // 但它埋在长文本中段，1200 字常常截不到。
        fullText: rawText.slice(0, 12000),
      }
    })

    mkdirSync(shotsDir, { recursive: true })
    const shot = join(shotsDir, `douyin-${videoId}-${Date.now()}.png`)
    let captured = false
    try {
      const player = page.locator('[data-e2e="player-container"]').first()
      if (await player.count()) {
        await player.screenshot({ path: shot })
        captured = true
      }
    } catch (error) {
      logger?.warn?.(`抖音截图失败：${error?.message ?? error}`)
    }
    if (!captured) {
      try {
        await page.screenshot({ path: shot })
        captured = true
      } catch {
        /* 没有截图也不影响文字部分 */
      }
    }

    // 可选：从正在播放的 <video> 抓一段音频（抖音没有公开音频接口）。
    let audioFile = ''
    let audioSeconds = 0
    if (options.audio === true) {
      const seconds = Math.max(5, Math.min(60, Number(options.seconds) || 15))
      try {
        const base64 = await page.evaluate(async (duration) => {
          const video = document.querySelector('video')
          if (!video || typeof video.captureStream !== 'function') return ''
          try {
            video.muted = false
            await video.play()
          } catch {
            /* 自动播放被拦时，仍尝试用已加载的流 */
          }
          const stream = video.captureStream()
          const tracks = stream.getAudioTracks()
          if (!tracks.length) return ''
          const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm' })
          const chunks = []
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) chunks.push(event.data)
          }
          const stopped = new Promise((resolve) => {
            recorder.onstop = resolve
          })
          recorder.start()
          await new Promise((resolve) => setTimeout(resolve, duration * 1000))
          recorder.stop()
          await stopped
          const blob = new Blob(chunks, { type: 'audio/webm' })
          if (!blob.size) return ''
          const bytes = new Uint8Array(await blob.arrayBuffer())
          let binary = ''
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
          }
          return btoa(binary)
        }, seconds)
        if (base64) {
          mkdirSync(shotsDir, { recursive: true })
          audioFile = join(shotsDir, `douyin-${videoId}-${Date.now()}.webm`)
          const { writeFileSync } = await import('node:fs')
          writeFileSync(audioFile, Buffer.from(base64, 'base64'))
          audioSeconds = seconds
        }
      } catch (error) {
        logger?.warn?.(`抖音音频抓取失败：${error?.message ?? error}`)
      }
    }

    // 平台自己给部分视频生成的「章节要点」：文字比 whisper 听写稳，但它是
    // 抖音的 AI 摘要（不是作者原话、也不是字幕），用的时候要当成二手转述。
    const chapterMatch = String(data.fullText || '').match(/章节要点\s*([\s\S]*?)\s*内容由AI生成/)
    const chapters = chapterMatch ? chapterMatch[1].trim().slice(0, 3000) : ''

    return {
      ok: true,
      url: canonical,
      videoId,
      title: data.title,
      author: data.author,
      publish: data.publish,
      comments: data.comments,
      shot: captured ? shot : '',
      audioFile,
      audioSeconds,
      ...(chapters ? { chapters, chaptersFrom: '抖音页面的「章节要点」，平台 AI 生成，不是原话' } : {}),
      pageText: String(data.pageText || '').replace(/章节要点[\s\S]*?内容由AI生成/, '［章节要点已单独放 chapters］'),
      coverage: audioFile
        ? '读取了当前视频页的文案、评论、一张画面，并抓了一段实际音轨；不是完整观看。'
        : '只读取了当前视频页的文案、评论和一张画面；没有解码音轨，也没有完整观看。',
    }
  }

  return { watch }
}
