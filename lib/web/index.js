// 网页阅读与搜索（2026-11-25 移植，第 7 块剩下的两项）。
//
// 两条路都走同一个有头浏览器（lib/browser）：DSH 自带的 web_fetch 拿不到 JS 渲染的
// 页面，也拿不到登录态；同一份 profile 里已经有 B 站、抖音的登录，读微博/知乎这类
// 需要渲染的页面时不至于只抓到一屏骨架。
//
// 只做「读」和「搜」：不点、不填、不发帖。网站 MCP 另起一套，不在这里。

const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?)/i

// 只放行普通公网 http(s)：带账号密码的、内网地址、非标准端口的都不读。
// 网页正文里可能夹着「请访问 xxx」这类外部指令，工具层的边界要在这里先卡死。
export function checkedUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw Error('网址格式不对，需要以 http:// 或 https:// 开头')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('只读取 http / https 网页')
  if (url.username || url.password) throw Error('网址里带着账号密码，不读')
  if (url.port && !['80', '443'].includes(url.port)) throw Error('只读取标准端口（80 / 443）的网页')
  if (PRIVATE_HOST.test(url.hostname)) throw Error('内网、本机地址不读')
  if (!url.hostname.includes('.')) throw Error('这个地址不像公开网页')
  url.hash = ''
  return url.href
}

// bing 的搜索结果有时包一层 /ck/a?u=a1<base64url>，解开才能给真实链接。
function unwrapBingLink(raw) {
  try {
    const url = new URL(raw)
    if (!/(?:^|\.)bing\.com$/i.test(url.hostname)) return raw
    const packed = url.searchParams.get('u')
    if (!packed || !packed.startsWith('a1')) return ''
    const decoded = Buffer.from(packed.slice(2), 'base64url').toString('utf8')
    if (!/^https?:\/\//i.test(decoded)) return ''
    return decoded
  } catch {
    return ''
  }
}

const SEARCH_HOST = /(?:^|\.)(?:bing\.com|microsoft\.com|msn\.com|microsofttranslator\.com|go\.microsoft\.com)$/i

// bing 的 RSS 输出：比抓搜索结果页稳得多，也不用起浏览器。
// 同一个查询在冷启动的浏览器里会偶发白屏（实测「汐涟 名字 出处」连续两次空页，
// 换成 RSS 一次就回来了），所以搜索主路走这里，页面抓取只当兜底。
const RSS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function xmlText(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!match) return ''
  const raw = match[1].trim()
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  return decodeEntities(cdata ? cdata[1] : raw)
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

async function rssSearch(word) {
  const url = 'https://cn.bing.com/search?format=rss&q=' + encodeURIComponent(word)
  const response = await fetch(url, {
    headers: { 'user-agent': RSS_UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw Error('HTTP ' + response.status)
  const xml = await response.text()
  const rows = []
  const seen = new Set()
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = match[1]
    const title = xmlText(block, 'title').replace(/\s+/g, ' ').trim()
    const link = xmlText(block, 'link').trim()
    const snippet = xmlText(block, 'description').replace(/\s+/g, ' ').trim()
    if (!title || !/^https?:\/\//i.test(link) || seen.has(link)) continue
    seen.add(link)
    rows.push({ title: title.slice(0, 180), url: link, snippet: snippet.slice(0, 240) })
  }
  return rows
}

// bing 搜索结果页的专用提取器（在页面上下文里跑，不能引用外部变量）。
// 只取 `#b_results > li.b_algo` 里的标题链接：通用链接提取会把右侧的推广、
// 抽奖报名、页脚导航一起捞进来（实测第一批 12 条里混着 2 条 aka.ms 广告）。
function bingExtract() {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
  const links = []
  const seen = new Set()
  for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
    if (li.querySelector('.b_ad, [data-bm="ad"]')) continue
    const a = li.querySelector('h2 a')
    if (!a?.href || seen.has(a.href)) continue
    const clone = a.cloneNode(true)
    for (const cite of clone.querySelectorAll('cite')) cite.remove()
    // detached 节点的 innerText 是空的（依赖布局），这里只能用 textContent。
    const title = norm(clone.textContent).slice(0, 180)
    if (!title) continue
    seen.add(a.href)
    links.push({ url: a.href, title })
  }
  return {
    title: document.title,
    description: '',
    body: norm(document.body?.innerText || '').slice(0, 3000),
    links,
    url: location.href,
  }
}

export function createWebReader({ browser, logger }) {
  if (!browser) throw Error('网页阅读缺少浏览器控制')

  // 同一页面的目录锚点（#heading-3 这种）对「要不要点进去」没有意义，
  // 实测一篇掘金文章 60 条链接里 42 条是它自己的标题锚点。
  function usefulLinks(rows, finalUrl) {
    const base = String(finalUrl || '').split('#')[0]
    const seen = new Set()
    const out = []
    for (const row of rows || []) {
      const href = String(row?.url || '')
      if (!/^https?:/i.test(href)) continue
      const plain = href.split('#')[0]
      if (plain === base) continue
      if (seen.has(plain)) continue
      seen.add(plain)
      out.push({ url: href, title: row.title })
      if (out.length >= 60) break
    }
    return out
  }

  async function read(input, { signal } = {}) {
    const url = checkedUrl(input)
    if (signal?.aborted) throw Error('已取消')
    let page = await browser.read(url, { includeLinks: true })
    // 白屏大多是首字节慢，不是真没内容：隔一会儿再读一次，取字数多的那份。
    if (page.status !== 'read') {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const again = await browser.read(url, { includeLinks: true })
      if (again.body.length > page.body.length) page = again
    }
    const blocked = /^(?:https?:\/\/)?(?:www\.)?(?:bing|baidu)\.com\/search/i.test(page.finalUrl)
    return {
      ok: page.status === 'read',
      url,
      finalUrl: page.finalUrl,
      title: page.title,
      description: page.description,
      text: page.body,
      links: usefulLinks(page.links, page.finalUrl),
      chars: page.body.length,
      coverage:
        page.status === 'read'
          ? '这是页面实际渲染出来的文字，不是全文存档；图片、内嵌视频、需要登录才能看的部分都不在里面。'
          : blocked
            ? '这个地址是搜索页，请改用 qq_bridge_search。'
            : '只拿到标题和少量文字，页面可能要求登录、验证或依赖 JavaScript。',
    }
  }

  async function search(query) {
    const word = String(query || '').trim()
    if (!word) throw Error('搜索词不能为空')
    if (word.length > 200) throw Error('搜索词最多 200 字')

    // 主路：bing 的 RSS（不需要浏览器，毫秒级，没有推广位）。
    let links = []
    let via = 'rss'
    let note = ''
    try {
      links = (await rssSearch(word)).slice(0, 12)
    } catch (error) {
      note = `RSS 通道没通（${String(error?.message ?? error).slice(0, 80)}）`
    }

    // 兜底：真的打开搜索结果页抓一遍（偶发白屏，抓不到就认了）。
    let page = null
    if (!links.length) {
      via = 'page'
      try {
        page = await browser.read('https://cn.bing.com/search?q=' + encodeURIComponent(word), {
          extract: bingExtract,
          includeLinks: true,
          waitFor: '#b_results li.b_algo',
        })
        const seen = new Set()
        for (const row of page.links || []) {
          let href = row.url
          if (SEARCH_HOST.test(new URL(href).hostname)) href = unwrapBingLink(href)
          if (!href || seen.has(href)) continue
          try {
            if (SEARCH_HOST.test(new URL(href).hostname)) continue
          } catch {
            continue
          }
          seen.add(href)
          links.push({ title: row.title, url: href })
          if (links.length >= 12) break
        }
      } catch (error) {
        note = note || `搜索页也没打开（${String(error?.message ?? error).slice(0, 80)}）`
      }
    }

    logger?.info?.(`网页搜索「${word}」取得 ${links.length} 条候选（${via}）`)
    return {
      ok: links.length > 0,
      query: word,
      via,
      links,
      ...(page?.title ? { pageTitle: page.title } : {}),
      ...(page ? { text: page.body.slice(0, 1200) } : {}),
      coverage:
        links.length > 0
          ? `这是搜索结果里的候选链接（${via === 'rss' ? '必应 RSS' : '必应结果页'}），不是已读全文；` +
            '要说内容，先用 qq_bridge_read 打开其中一两条。摘要只是搜索站的转述，别当原文。'
          : `没有拿到可确认的搜索结果${note ? '：' + note : ''}，可能碰到验证码或网络问题，换个说法再试。`,
    }
  }

  return { read, search }
}
