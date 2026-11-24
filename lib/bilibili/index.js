// B 站运行时适配层（service/login/images/qr 移植自 dsh-im-bridge 1.62.128，MIT）。
//
// 只负责把「固定单账号」的上下文喂给原服务：源插件按 accountId/personaId 隔离，
// 本插件只有一个 QQ 桥接账号，所以用固定值即可。登录态与阅读历史落在 stateDir。
import { createBilibiliService } from './service.js'
import { createQrDataUrl } from './qr.js'

export function createBilibiliRuntime({ stateDir, logger, now = Date.now } = {}) {
  if (!stateDir) throw Error('B站运行时缺少状态目录')
  const service = createBilibiliService({
    directory: stateDir,
    makeQr: (value) => createQrDataUrl(value),
    now,
    // 本插件没有多账号/多人设的权限模型：桥接账号即唯一主体。
    authorize: () => true,
  })
  const context = { accountId: 'default', personaId: 'default' }
  async function act(args = {}) {
    try {
      return await service.act(args, context)
    } catch (error) {
      logger?.warn?.(`B站操作失败（${args.action || '?'}）：${error?.message ?? error}`)
      throw error
    }
  }
  return {
    act,
    stateDir,
    close: () => {
      try {
        service.close()
      } catch {
        /* 忽略关闭异常 */
      }
    },
  }
}
