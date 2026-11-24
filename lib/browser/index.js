// 共享浏览器控制（playwright-core + 本机 Edge）。
//
// 为什么必须有头：抖音对 headless 直接跳验证码；窗口移到屏幕外并最小化，
// 不抢焦点、不弹到用户面前。登录态存在 profileDir，和用户日常 Edge 完全隔离
// （Edge 127+ 的 cookie 应用绑定加密，复制 profile 解不开，只能各存一份）。
//
// 这里只做「读一页」和「抓音轨」两种一次性动作。能点、能输、能翻页的那套
// 交给她自己的浏览器（dsh-world 的 page_*），不在这里重复一份。
import { chromium } from '../../vendor/playwright-core/index.mjs'

export const DEFAULT_EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

export function createBrowserController({ profileDir, executablePath = DEFAULT_EDGE, logger, idleMs = 10 * 60000 } = {}) {
  if (!profileDir) throw Error('浏览器控制缺少 profile 目录')
  let context = null
  let idleTimer = null
  let launching = null

  async function launch() {
    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      viewport: { width: 1280, height: 900 },
      locale: 'zh-CN',
      args: [
        '--disable-blink-features=AutomationControlled',
        // 进程级静音：抓音轨靠的是元素内部的 MediaStream，不受这个开关影响，
        // 但用户不会在后台听到两个浏览器同时放歌（真机上被抱怨过一次）。
        '--mute-audio',
        // 移到屏幕外 + 最小化：窗口存在（避开 headless 检测），但不打扰用户。
        '--window-position=-2200,-2200',
        '--start-minimized',
      ],
    })
    await ctx.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
      } catch {
        /* 忽略 */
      }
    })
    return ctx
  }

  async function ensure() {
    if (context) return context
    if (!launching) {
      launching = launch()
        .then((ctx) => {
          context = ctx
          logger?.info?.('浏览器已启动（有头，屏幕外）')
          return ctx
        })
        .finally(() => {
          launching = null
        })
    }
    return launching
  }

  function touch() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void close()
    }, idleMs)
    idleTimer.unref?.()
  }

  async function page() {
    const ctx = await ensure()
    touch()
    const existing = ctx.pages()[0]
    return existing ?? ctx.newPage()
  }

  // 默认提取器：在页面上下文里跑（playwright 会把函数源码送过去，所以不能引用外部变量）。
  // 不做「正文算法」那套打分：站点结构千差万别，硬猜不如把 article/main 里最长的
  // 一段 innerText 拿出来，再用长度兜底。宁可混进一点导航，也别把正文切掉。
  function defaultExtract(includeLinks) {
    const norm = (s) =>
      String(s || '')
        .replace(/\r/g, '')
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    const candidates = [
      ...document.querySelectorAll(
        'article, main, [role="main"], #content, #main, .markdown-body, .article, .post, .entry-content, .article-content',
      ),
    ]
    let best = null
    let bestLength = 0
    for (const el of candidates) {
      const text = norm(el.innerText)
      if (text.length > bestLength) {
        best = text
        bestLength = text.length
      }
    }
    const whole = norm(document.body?.innerText)
    const body = (bestLength > 400 && bestLength > whole.length * 0.3 ? best : whole).slice(0, 20000)
    const description = norm(
      document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '',
    ).slice(0, 1000)
    const links = []
    if (includeLinks) {
      const seen = new Set()
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href
        if (!/^https?:/i.test(href) || seen.has(href)) continue
        const title = String(a.innerText || a.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
        if (title.length < 2) continue
        seen.add(href)
        links.push({ url: href, title: title.slice(0, 180) })
        if (links.length >= 120) break
      }
    }
    return { title: document.title, description, body, links, url: location.href }
  }

  // 读一页：goto → 等渲染 → 交给提取器（默认 defaultExtract，搜索页会换一个）。
  //
  // 固定等 1.5 秒不够用：浏览器冷启动后第一页常常还在白屏（实测同一条搜索，
  // 第一次返回空、第二次正常）。这里改成「等到页面真的有字」，最多等 8 秒。
  async function read(
    url,
    { timeout = 30000, waitMs = 600, minText = 200, waitFor = '', includeLinks = true, extract } = {},
  ) {
    const target = String(url || '').trim()
    const p = await page()
    const response = await p.goto(target, { waitUntil: 'domcontentloaded', timeout })
    await p.waitForTimeout(waitMs)
    if (waitFor) {
      await p.waitForSelector(waitFor, { timeout: 8000 }).catch(() => {})
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const length = await p
        .evaluate(() => String(document.body?.innerText || '').length)
        .catch(() => 0)
      if (length >= minText) break
      await p.waitForTimeout(250)
    }
    const observed = await p.evaluate(extract || defaultExtract, includeLinks)
    return {
      status: String(observed.body || '').length > 60 ? 'read' : 'metadata',
      title: observed.title,
      description: observed.description,
      body: observed.body,
      links: observed.links,
      url: target,
      finalUrl: observed.url || p.url(),
      httpStatus: response?.status() ?? 0,
      rendered: true,
    }
  }

  async function close() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (!context) return
    const ctx = context
    context = null
    try {
      await ctx.close()
    } catch {
      /* 关闭失败忽略 */
    }
  }

  return { page, read, close, touch }
}
