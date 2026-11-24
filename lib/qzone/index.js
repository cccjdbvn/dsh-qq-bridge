// QQ 空间运行时适配层。
//
// 把 dsh-im-bridge 的 qzone-service（MIT）接到本插件的 OneBot transport 上：
//   - 凭据：NapCat get_login_info / get_credentials / get_cookies
//   - 状态：<statePath 同目录>/qq-bridge-qzone.json
//   - 配图：本机绝对路径 / file:// / data URL
//   - 目标：自己 + 白名单 + 好友列表（可配置放开）
//   - 频率：写操作最小间隔、每小时评论上限、签名每天一次
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createQzoneService } from './service.js'
import { loadQzoneAuth } from './auth.js'
import { loadLocalImage } from './image.js'

const MINUTE = 60000
const HOUR = 60 * MINUTE

function emptyState() {
  return { version: 1, entries: [], comments: [], posts: [], usage: { sign: {}, writes: [] } }
}

export function createQzoneRuntime({ call, stateFile, logger, getSettings, now = Date.now }) {
  // ── 状态文件 ──────────────────────────────────────────────────────────────
  let fileCache = { mtimeMs: -1, value: null }
  function readState() {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
      const value = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) }
      value.usage = { ...emptyState().usage, ...(value.usage || {}) }
      return value
    } catch {
      return emptyState()
    }
  }
  function writeState(value) {
    mkdirSync(dirname(stateFile), { recursive: true })
    const tmp = `${stateFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8')
    renameSync(tmp, stateFile)
    fileCache = { mtimeMs: -1, value: null }
  }
  const storage = {
    read: () => {
      if (!existsSync(stateFile)) throw Object.assign(Error('no state'), { code: 'ENOENT' })
      return readState()
    },
    write: (value) => writeState(value),
  }

  // ── 凭据（缓存 60 秒，避免每个动作都惊动 NapCat）─────────────────────────
  let authCache = { at: 0, value: null }
  async function getAuth() {
    if (authCache.value && now() - authCache.at < MINUTE) return authCache.value
    const value = await loadQzoneAuth(call)
    authCache = { at: now(), value }
    return value
  }
  function dropAuth() {
    authCache = { at: 0, value: null }
  }

  // ── 允许的目标 ────────────────────────────────────────────────────────────
  let friendSet = null
  async function refreshFriends() {
    try {
      const rows = await call('get_friend_list', {})
      const list = Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : []
      friendSet = new Set(list.map((row) => String(row?.user_id ?? row?.uin ?? '')).filter(Boolean))
    } catch (error) {
      logger?.warn?.(`空间好友列表读取失败：${error?.message ?? error}`)
      friendSet = new Set()
    }
  }
  function allowTarget(uin) {
    const target = String(uin ?? '')
    if (!/^\d{5,20}$/.test(target)) return false
    const s = getSettings()
    const self = String(authCache.value?.uin ?? '')
    if (target === self) return true
    if (s.qzoneAllowAllTargets === true) return true
    if ([...(s.whitelist || []), ...(s.ownerIds || [])].map(String).includes(target)) return true
    return friendSet ? friendSet.has(target) : false
  }

  // ── 频率保护 ──────────────────────────────────────────────────────────────
  //
  // 单独一个文件：qzone-service 自己缓存状态并整体写回，共用文件会把
  // 频率记录覆盖掉（离线测试里踩到过）。
  const usageFile = stateFile.replace(/\.json$/i, '-usage.json')
  function readUsage() {
    try {
      const raw = JSON.parse(readFileSync(usageFile, 'utf8'))
      return { writes: Array.isArray(raw?.writes) ? raw.writes : [], sign: raw?.sign && typeof raw.sign === 'object' ? raw.sign : {} }
    } catch {
      return { writes: [], sign: {} }
    }
  }
  function writeUsage(value) {
    mkdirSync(dirname(usageFile), { recursive: true })
    const tmp = `${usageFile}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf8')
    renameSync(tmp, usageFile)
  }
  function noteWrite(kind) {
    const value = readUsage()
    value.writes.push({ at: now(), kind })
    value.writes = value.writes.slice(-200)
    writeUsage(value)
  }
  function assertWriteAllowed(kind) {
    const s = getSettings()
    const value = readUsage()
    const gap = Math.max(10, Number(s.qzoneMinGapSec ?? 60)) * 1000
    const last = value.writes[value.writes.length - 1]
    if (last && now() - last.at < gap) {
      throw Error(`空间写操作太频繁：距离上次 ${Math.ceil((now() - last.at) / 1000)} 秒，至少间隔 ${gap / 1000} 秒`)
    }
    if (kind === 'sign') {
      const day = new Date(now()).toISOString().slice(0, 10)
      if (value.sign?.day === day) throw Error('今天已经改过一次签名，明天再改；本人明确要求也不绕过这一条')
    }
    if (kind === 'comment' || kind === 'reply') {
      const perHour = Math.max(1, Number(s.qzoneCommentPerHour ?? 10))
      const recent = value.writes.filter((row) => now() - row.at < HOUR).length
      if (recent >= perHour) throw Error(`一小时内的空间写操作已达 ${perHour} 条上限，先停一停`)
    }
  }
  function markSign() {
    const value = readUsage()
    value.sign = { day: new Date(now()).toISOString().slice(0, 10), at: now() }
    writeUsage(value)
  }
  /** 最近一次写操作的时间，给「先观察再决定」的工具参考。 */
  function usageSnapshot() {
    return readUsage()
  }

  // ── 服务实例 ──────────────────────────────────────────────────────────────
  const scope = { accountId: 'default', personaId: '' }
  const service = createQzoneService({
    storage,
    getAuth,
    loadImage: (source) => {
      const loaded = loadLocalImage(source)
      return { bytes: loaded.bytes, hash: loaded.hash, file: loaded.file, source: loaded.source, provenance: null }
    },
    authorize: () => true,
    allowTarget,
    onAuthFailure: () => dropAuth(),
    onRecord: (row) => {
      if (row?.stage === 'failed') logger?.warn?.(`空间操作失败：${row.error || row.kind}`)
    },
    now,
  })

  const ctx = () => ({ ...scope, signal: undefined })
  async function withAuth(fn) {
    try {
      return await fn(ctx())
    } catch (error) {
      if (String(error?.code || '').startsWith('QZONE_AUTH')) dropAuth()
      throw error
    }
  }

  async function feed({ uin = '', limit = 20 } = {}) {
    if (friendSet === null) await refreshFriends()
    await getAuth()
    return withAuth((c) => service.feed({ uin: uin || authCache.value?.uin, limit }, c))
  }
  async function comments({ tid, uin }) {
    await getAuth()
    return withAuth((c) => service.comments({ tid, uin }, c))
  }
  async function comment({ tid, uin, text }) {
    const s = getSettings()
    if (s.qzoneEnabled === false) throw Error('QQ 空间功能在设置里关着')
    assertWriteAllowed('comment')
    await getAuth()
    // 评论前必须实际浏览过这条动态；没浏览过就先读一遍动态流。
    const state = readState()
    const observed = state.posts?.some((p) => String(p.tid) === String(tid) && String(p.uin) === String(uin))
    if (!observed) await feed({ uin, limit: 20 })
    noteWrite('comment')
    return withAuth((c) => service.publish({ text, target: { tid, uin }, comment: true }, c))
  }
  async function reply({ tid, uin, commentId, commentUin, text }) {
    const s = getSettings()
    if (s.qzoneEnabled === false) throw Error('QQ 空间功能在设置里关着')
    assertWriteAllowed('reply')
    await getAuth()
    // 回复前必须实际读过这条评论；没读过就先读评论列表。
    const state = readState()
    const known = state.comments?.some(
      (row) => String(row.tid) === String(tid) && String(row.owner) === String(uin) && String(row.id) === String(commentId) && String(row.uin) === String(commentUin),
    )
    if (!known) await comments({ tid, uin })
    noteWrite('reply')
    return withAuth((c) => service.publish({ text, target: { tid, uin }, commentId, commentUin, comment: false }, c))
  }
  async function verify(id) {
    return withAuth((c) => service.verifyEntry(id, c))
  }
  async function status() {
    return service.status(ctx())
  }

  // ── 签名（NapCat 扩展 action，不经过空间 HTTP 接口）──────────────────────
  async function sign(text) {
    const s = getSettings()
    if (s.qzoneEnabled === false) throw Error('QQ 空间功能在设置里关着')
    const value = String(text ?? '').trim()
    if (!value) throw Error('签名是空的')
    if ([...value].length > 80) throw Error('签名太长：请控制在 80 字以内')
    assertWriteAllowed('sign')
    const result = await call('set_self_longnick', { longNick: value })
    markSign()
    return { ok: true, signature: value, result }
  }

  return { feed, comments, comment, reply, verify, status, sign, getAuth, refreshFriends, stateFile }
}

