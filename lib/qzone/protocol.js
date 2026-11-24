// QQ 空间接口返回的 JSON 解析（移植自 dsh-im-bridge 1.62.128，MIT）。
// 空间接口有时返回的是 JS 对象字面量而不是严格 JSON，这里复用 data-literal 解析。
import { parseQzoneDataLiteral } from './data-literal.js'

const AUTH_CODES = new Set([-3, -100, -3000, -10001, -10006])
const RATE_CODES = new Set([-10000, -2])

export function qzoneJson(raw) {
  const s = String(raw).trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end < start) throw Object.assign(Error('空间接口没有返回有效资料'), { code: 'QZONE_RESPONSE_INVALID' })
  let value
  try {
    value = parseQzoneDataLiteral(s.slice(start, end + 1))
  } catch {
    throw Object.assign(Error('空间接口资料无法解析'), { code: 'QZONE_RESPONSE_INVALID' })
  }
  const code = value.code ?? value.ret ?? value.retcode
  if (code === undefined || !/^[-+]?\d+$/.test(String(code))) {
    throw Object.assign(Error('空间接口缺少明确状态'), { code: 'QZONE_RESPONSE_INVALID' })
  }
  if (Number(code) !== 0) {
    throw Object.assign(Error('空间接口拒绝请求，code=' + Number(code)), {
      apiCode: Number(code),
      code: AUTH_CODES.has(Number(code))
        ? 'QZONE_AUTH_REQUIRED'
        : RATE_CODES.has(Number(code))
          ? 'QZONE_THROTTLED'
          : 'QZONE_API_ERROR',
    })
  }
  return value
}
