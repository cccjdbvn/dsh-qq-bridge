// 从 NapCat 取 QQ 空间凭据（移植自 dsh-im-bridge 1.62.128 的 qzone-auth.js，MIT）。
//
// 链路：get_login_info 取 uin → get_credentials(domain=qzone.qq.com) 取 cookies
//      → 失败再退回 get_cookies(domain) → 从 cookie 里抽 p_skey 算 g_tk。
// 这三个都是 NapCat 的 OneBot 扩展 action；不在标准 OneBot 11 里。
const fail = (code, message) => Object.assign(Error(message), { code })
const normalizeUin = (value) => String(value ?? '').replace(/^o/, '').replace(/^0+(?=\d)/, '')
const cookieFields = (cookie) =>
  Object.fromEntries(
    String(cookie)
      .split(';')
      .map((item) => {
        const index = item.indexOf('=')
        return index < 0 ? ['', ''] : [item.slice(0, index).trim(), item.slice(index + 1).trim()]
      }),
  )

export function qzoneCredentials(cookie, uin, expectedUin = '') {
  cookie = String(cookie || '')
  uin = normalizeUin(uin)
  if (!/^\d{5,20}$/.test(uin) || /[\r\n]/.test(cookie) || !cookie) {
    throw fail('QZONE_AUTH_REQUIRED', 'QQ 登录后才能取得空间凭据')
  }
  const fields = cookieFields(cookie)
  const key = fields.p_skey || fields.skey || ''
  const cookieUin = normalizeUin(fields.p_uin || fields.uin || '')
  if (!key || (cookieUin && cookieUin !== uin) || (expectedUin && normalizeUin(expectedUin) !== uin)) {
    throw fail('QZONE_AUTH_REQUIRED', '空间凭据与当前 QQ 登录不一致')
  }
  let gtk = 5381
  for (const char of key) gtk = (gtk * 33 + char.charCodeAt(0)) | 0
  return { uin, cookie, gtk: gtk & 0x7fffffff }
}

/**
 * @param {(action: string, params?: object) => Promise<any>} call OneBot action 调用
 */
export async function loadQzoneAuth(call, { expectedUin = '', signal } = {}) {
  signal?.throwIfAborted()
  const login = await call('get_login_info', {})
  signal?.throwIfAborted()
  const uin = normalizeUin(login?.user_id || login?.uin)
  if (!/^\d{5,20}$/.test(uin)) throw fail('QZONE_AUTH_REQUIRED', 'QQ 尚未完成登录')
  let combined
  try {
    combined = await call('get_credentials', { domain: 'qzone.qq.com' })
  } catch {
    signal?.throwIfAborted()
  }
  signal?.throwIfAborted()
  if (combined?.cookies) {
    try {
      return qzoneCredentials(combined.cookies, uin, expectedUin)
    } catch {
      /* 退回 get_cookies */
    }
  }
  const cookies = await call('get_cookies', { domain: 'qzone.qq.com' })
  signal?.throwIfAborted()
  return qzoneCredentials(cookies?.cookies, uin, expectedUin)
}
