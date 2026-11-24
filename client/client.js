/**
 * dsh-qq-bridge —— 浏览器半（client half）
 *
 * 作用：在 **设置 → 插件 → 插件配置** 里放一张名为“QQ 桥接”的卡片，
 * 用来改昵称、白名单、唤醒概率、目标会话这些设置 —— 也就是用户要的那个界面。
 *
 * 为什么这里的东西长得不像源码：
 *   DSH 的官方文档明确说，本仓库之外没有现成的 client 打包预设
 *   （`packages/client/tsdown.client.ts` 不发布），外部插件得自己复刻产物格式。
 *   好在格式很简单：`window.__ModuleLoader__.load({ id, factory })`，
 *   `factory(require)` 返回一个带 `apply` / `inject` 的 Cordis 插件。
 *   这里就是**手写**这个格式，不引入任何构建步骤。
 *   参考实现：第三方插件 `dshmarket` 的 `client/client.js`（同样是手写/预构建产物）。
 *
 * 与宿主半的约定：
 *   - `id` 必须等于包名 `dsh-qq-bridge`；
 *   - 卡片注册进 `settings.plugin.item`，**key 必须等于宿主注册的 settings 命名空间** `qq-bridge`，
 *     否则配置页那一栏里什么都不会出现（它按命名空间派发）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react 是模块表里的 baseline 依赖，不用在 package.json 里声明 external。
    const react = require('react')
    const h = react.createElement

    /** settings 命名空间，必须与 index.js 里的 NS 一致。 */
    const NS = 'qq-bridge'

    // ── 表单描述 ──────────────────────────────────────────────────────────────
    // 加一个设置项 = 在这里加一行。kind: text | list | number | boolean | select
    const FIELDS = [
      {
        key: 'targetSessionId',
        label: '目标会话',
        kind: 'session',
        hint: '要接管哪个会话 —— 按名字选就行，不用记 id。',
      },
      {
        key: 'nicknames',
        label: '昵称',
        kind: 'list',
        hint: '被叫到这些名字必然唤醒；逗号分隔，例如：244, 小助手。',
      },
      {
        key: 'wakeProbability',
        label: '唤醒概率',
        kind: 'number',
        step: '0.01',
        hint: '既没被 @ 也没叫名字时的唤醒概率（0–1）。默认 0.05 = 5%；嫌耗 token 就调小。',
      },
      {
        key: 'whitelist',
        label: '私聊白名单',
        kind: 'list',
        hint: '允许唤醒的私聊 QQ 号；**空 = 谁都不能唤醒**。',
      },
      {
        key: 'groupWhitelist',
        label: '群白名单',
        kind: 'list',
        hint: '允许唤醒的群号；**空 = 任何群都不唤醒**。',
      },
      {
        key: 'atOnlyInGroup',
        label: '群里只认 @',
        kind: 'boolean',
        hint: '开启后，群里没被 @ 就完全不处理（比概率唤醒更严）。',
      },
      {
        key: 'replyMode',
        label: '出站方式',
        kind: 'select',
        options: [
          ['marker', '标记块（默认）'],
          ['tool', '工具调用'],
          ['always', '整轮都发'],
        ],
        hint: '标记块 = 只发块里的内容；工具调用 = 关掉标记块、改用 qq_bridge_send 发送（每轮多一次模型调用，但发不出去时有明确反馈）；整轮都发 = 技术内容也会进群，慎用。',
      },
      {
        key: 'delivery',
        label: '投递方式',
        kind: 'select',
        options: [
          ['auto', '自动（忙时插话）'],
          ['followup', '排队'],
          ['steer', '总是插话'],
        ],
        hint: 'QQ 消息怎么进目标会话：自动 = 目标正忙就插话（在下一个 step 边界塞进去）、空闲时排队；排队 = 永远排成独立一轮（更稳）；总是插话 = 无论忙闲都插。',
      },
      { key: 'replyWithQuote', label: '引用原消息', kind: 'boolean', hint: '回复时引用触发的那条消息。' },
      { key: 'stripMarkdown', label: '去掉 Markdown', kind: 'boolean', hint: '出站前去掉 Markdown 标记（QQ 不渲染）。' },
      {
        key: 'replyMaxChars',
        label: '出站字数上限',
        kind: 'number',
        hint: '出站文本的字数上限；超过就不发送，请缩短后重发。',
      },
      {
        key: 'onebotUrl',
        label: 'OneBot 地址',
        kind: 'text',
        hint: 'NapCat 的正向 WS 地址，如 ws://127.0.0.1:3001；留空 = 完全不启用传输。',
      },
      {
        key: 'accessTokenEnv',
        label: 'OneBot Token 凭据名',
        kind: 'text',
        hint: '指 **NapCat / OneBot 的 access_token** 存在哪个环境变量里 —— 填「变量名」（如 NAPCAT_TOKEN），不是 token 本身；NapCat 没开 token 校验就留空。⚠️ 不是模型 API key（DeepSeek 等），两者无关，别填错。',
        check: (v) => {
          const s = String(v ?? '').trim()
          if (s === '') return null
          if (/^(sk-|Bearer\s)/i.test(s) || s.length > 64 || /[.\s]/.test(s)) {
            return '这看起来像一串 token —— 这一栏要填的是「存它的环境变量名」（如 NAPCAT_TOKEN），不是 token 本身。'
          }
          return null
        },
      },
      { key: 'selfId', label: '机器人 QQ', kind: 'text', hint: '留空 = 连上后自动获取。' },
      // ↓ 这些键以前只在 Schema 里、卡片上没做输入框，等于“设了也改不了”（用户报的正是这个）
      {
        key: 'visionModel',
        label: '识图模型',
        kind: 'text',
        hint: '给图片写描述的多模态模型，形如 provider/model（如 deepseek-official/deepseek-v4-flash-vision-exp）；留空 = 自动找（优先名字带 vision 的）。',
      },
      {
        key: 'agentPreset',
        label: 'Agent Preset',
        kind: 'text',
        hint: '恢复目标会话时挂载哪个 preset（决定它的人设/人格）；留空 = 沿用会话自己记着的那个。',
      },
      { key: 'attachRecentChat', label: '附带未唤醒记录', kind: 'boolean', hint: '唤醒时是否把"未唤醒期间"的聊天记录一并附上。' },
      { key: 'recentChatLimit', label: '附带条数', kind: 'number', hint: '上面那段摘要最多带最近几条（0–200）。' },
      { key: 'napcatInstallDir', label: 'NapCat 目录', kind: 'text', hint: 'NapCat 安装目录；留空 = $DSH_HOME/napcat。' },
      { key: 'napcatVersion', label: 'NapCat 版本', kind: 'text', hint: '要下载的版本 tag（如 v4.18.28）；留空 = 最新。' },
      { key: 'downloadProxy', label: '下载代理', kind: 'text', hint: '下载 NapCat 用的 HTTP 代理（如 http://127.0.0.1:7890）；留空 = 读环境变量。' },
      { key: 'onebotPort', label: 'OneBot 端口', kind: 'number', hint: '写进 NapCat 配置、并用来连的正向 WS 端口。' },
      { key: 'qqNumber', label: '快速登录 QQ', kind: 'text', hint: '快速登录用的 QQ 号（需先成功登录过一次）。' },
      // ↓ 以下这些键以前只在 Schema 里、卡片上没做控件，等于“设了也改不了”
      { key: 'ownerIds', label: '主人 QQ', kind: 'list', hint: '主人号：从这些号私聊发来的消息一律唤醒，不抽概率。每行一个。' },
      { key: 'alwaysWakeIds', label: '必唤醒的私聊', kind: 'list', hint: '这些人私聊发来消息直接唤醒，但不是主人。每行一个。' },
      { key: 'alwaysWakeGroups', label: '必唤醒的群', kind: 'list', hint: '这些群里每条消息都唤醒。每行一个群号。' },
      { key: 'nicknameWakeGroups', label: '叫名字算数的群', kind: 'list', hint: '这些群里叫名字也能唤醒；别处只认 @。每行一个群号。' },
      { key: 'groupThrottleExemptGroups', label: '不限频的群', kind: 'list', hint: '这些群不做回复间隔和每小时次数限制。每行一个群号。' },
      { key: 'listenIdleMinutes', label: '跟随窗（分钟）', kind: 'number', hint: '被叫起来后自动跟随的时长，0 = 不跟随。' },
      { key: 'groupReplyMinGapSec', label: '群回复间隔（秒）', kind: 'number', hint: '同一个群两次唤醒之间至少隔多少秒。' },
      { key: 'groupReplyPerHour', label: '群回复每小时上限', kind: 'number', hint: '同一个群每小时最多唤醒多少次。' },
      { key: 'outboundConfirm', label: '出站二次确认', kind: 'boolean', hint: '从 DSH 界面发起的那一轮，第一次调 qq_bridge_send 先问一句「确认要发吗」。' },
      // ↓ 语音（旧卡片也漏了这两项，等于设了改不了）
      { key: 'voiceId', label: 'Breeze 音色 ID', kind: 'text', hint: 'Breeze 音色 id（voc_ 开头）；留空 = 不能发语音。' },
      { key: 'voiceEnvFile', label: '语音密钥文件', kind: 'text', hint: '存 BREEZE_API_KEY 的 .env 文件路径；留空 = 不启用语音。' },
      // ↓ QQ 空间（移植自 dsh-im-bridge 1.62.128）
      { key: 'qzoneEnabled', label: 'QQ 空间', kind: 'boolean', hint: '读动态、评论、回复、改签名；关掉后空间工具一律拒绝。' },
      {
        key: 'qzoneAllowAllTargets',
        label: '允许任意好友空间',
        kind: 'boolean',
        hint: '关着时只允许自己、白名单和主人号；打开后可以读写任意好友的空间（评论仍有频率限制）。',
      },
      {
        key: 'qzoneMinGapSec',
        label: '空间写入间隔（秒）',
        kind: 'number',
        hint: '两次空间写操作（评论/回复/签名）之间至少隔多少秒，默认 60。',
      },
      {
        key: 'qzoneCommentPerHour',
        label: '空间写入每小时上限',
        kind: 'number',
        hint: '每小时最多评论/回复几条，默认 10；签名另有每天 1 次的硬限制。',
      },
      // ↓ 上网与内容（第 7 块）
      {
        key: 'webEnabled',
        label: '网页阅读与搜索',
        kind: 'boolean',
        hint: '读网页正文、用搜索引擎找链接；关掉后 qq_bridge_read / qq_bridge_search 一律拒绝。',
      },
      {
        key: 'bilibiliEnabled',
        label: 'B 站',
        kind: 'boolean',
        hint: '登录、搜索、推荐、视频信息、字幕、评论草稿。',
      },
    ]

    // 分类页签：一个分类一块，横着排。顺序即显示顺序；每个分类有自己的强调色。
    // 字段按 key 归组（FIELDS 里的顺序不变，只是为了复用同一份定义）。
    const GROUPS = [
      {
        id: 'connect',
        label: '连接',
        accent: 'var(--dsw-alias-brand-primary)',
        fields: [
          'onebotUrl',
          'accessTokenEnv',
          'selfId',
          'onebotPort',
          'qqNumber',
          'targetSessionId',
          'napcatInstallDir',
          'napcatVersion',
          'downloadProxy',
        ],
      },
      {
        id: 'wake',
        label: '唤醒',
        accent: '#2fb36f',
        fields: [
          'nicknames',
          'wakeProbability',
          'atOnlyInGroup',
          'alwaysWakeIds',
          'alwaysWakeGroups',
          'nicknameWakeGroups',
          'listenIdleMinutes',
        ],
      },
      {
        id: 'access',
        label: '权限',
        accent: '#e09a1a',
        fields: [
          'whitelist',
          'groupWhitelist',
          'ownerIds',
          'groupReplyMinGapSec',
          'groupReplyPerHour',
          'groupThrottleExemptGroups',
        ],
      },
      {
        id: 'outbound',
        label: '出站',
        accent: '#8b6cf0',
        fields: [
          'replyMode',
          'delivery',
          'outboundConfirm',
          'replyWithQuote',
          'stripMarkdown',
          'replyMaxChars',
        ],
      },
      {
        id: 'voice',
        label: '语音',
        accent: '#e0629b',
        fields: ['voiceId', 'voiceEnvFile'],
      },
      {
        id: 'qzone',
        label: '空间',
        accent: '#12a8a0',
        fields: ['qzoneEnabled', 'qzoneAllowAllTargets', 'qzoneMinGapSec', 'qzoneCommentPerHour'],
      },
      {
        id: 'context',
        label: '上下文',
        accent: '#5b7fa6',
        fields: ['visionModel', 'agentPreset', 'attachRecentChat', 'recentChatLimit'],
      },
      {
        id: 'web',
        label: '上网',
        accent: '#3d8fd1',
        fields: ['webEnabled', 'bilibiliEnabled'],
      },
    ]

    function format(field, raw) {
      // 列表显示成一行一个（textarea），保存时仍是数组，顺序不变。
      if (field.kind === 'list') return Array.isArray(raw) ? raw.join('\n') : raw == null ? '' : String(raw)
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') return raw == null || raw === '' ? '' : String(raw)
      return raw == null ? '' : String(raw)
    }

    /** 表单值 → 要写进设置的 JSON；数字不合法返回 undefined（拦住保存）。 */
    function parse(field, raw) {
      if (field.kind === 'list') {
        // 换行为主，兼容逗号/空格分隔的旧输入。
        return String(raw == null ? '' : raw)
          .split(/[\n,，]+/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
      }
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const n = Number(raw)
        return Number.isFinite(n) ? n : undefined
      }
      return String(raw == null ? '' : raw).trim()
    }

    function draftFrom(value) {
      const v = value && typeof value === 'object' ? value : {}
      const draft = {}
      for (const f of FIELDS) draft[f.key] = format(f, v[f.key])
      return draft
    }

    function same(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /**
     * 会话下拉的选项：真实的会话列表 + “不驱动”+ 一个兜底项。
     *
     * **归档的会话不列出来**（用户报的 bug：下拉里混进了一堆早就归档的会话）——
     * 归档集在 workspace 域：`ctx.workspaces.list.getSnapshot().archivedSessionIds`。
     *
     * ⚠️ **TODO（下次修）：子代理会话也会被列进来。**
     * `SessionSummary` 上有 `origin?: 'subagent'` 与 `parentId?: SessionId`
     * （见 `@deepseek-ai/dsh-api-session-controller` 的 `SessionSummary`），据此可以剔除。
     * 剔除之后同样要给**当前选中项**兜底，规则与下面的归档处理一致 ——
     * 否则子代理会话是当前目标时，一保存就把目标会话清空。
     * 退化做法也可接受：把它们折叠进一个“显示子代理会话”的展开项，别一次铺开一长串。
     *
     * 两个兜底项都是必要的：
     * - 配置里那个 id 可能**不在**列表里（别的工作区、宿主还没加载完）；
     * - 也可能**正好是归档的**（用户刚把它归档了）。
     * 两种都必须保留成选项，否则用户一保存就把目标会话清空了。
     */
    function sessionOptions(state, current, archivedIds) {
      const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map((id) => String(id)))
      const out = [{ value: '', label: '（不驱动任何会话）' }]
      const ids = Array.isArray(state?.ids) ? state.ids : []
      const byId = state && typeof state.byId === 'object' && state.byId ? state.byId : {}
      const cur = String(current ?? '')
      const seen = new Set([''])
      for (const id of ids) {
        const key = String(id)
        const isArchived = archived.has(key)
        // 归档的一律不显示 —— 除非它就是当前选中的那个（不显示的话就没法保留/换掉了）
        if (isArchived && key !== cur) continue
        seen.add(key)
        const row = byId[id] ?? {}
        const title = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : key
        out.push({
          value: key,
          label: `${title}${row.running ? '（运行中）' : ''}${isArchived ? '（已归档）' : ''}`,
        })
      }
      if (cur !== '' && !seen.has(cur)) {
        out.push({ value: cur, label: `${cur}（${archived.has(cur) ? '已归档' : '不在会话列表里'}）` })
      }
      return out
    }

    /** 没有 sessions / workspaces 服务（或它们还没就绪）时用的稳定空快照 —— 必须稳定，否则 useSyncExternalStore 会死循环。 */
    const EMPTY_SESSION_LIST = { ids: [], byId: {} }
    const EMPTY_WORKSPACES = { archivedSessionIds: [] }

    // ── 样式（内联，跟随主题文字色） ──────────────────────────────────────────
    const BORDER = '1px solid rgba(127,127,127,0.35)'
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px' },
      head: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '14px', fontWeight: 600 },
      sub: { fontSize: '13px', opacity: 0.65, lineHeight: 1.5 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(120px, 180px) 1fr', gap: '8px 13px', alignItems: 'start' },
      label: { fontSize: '14px', paddingTop: '5px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '14px',
      },
      hint: { fontSize: '12px', opacity: 0.55, marginTop: '3px', lineHeight: 1.5 },
      area: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '14px',
        lineHeight: 1.7,
        resize: 'vertical',
        minHeight: '86px',
      },
      // 分类页签：横向一排，激活项用各自强调色描边 + 淡底。
      tabs: { display: 'flex', flexWrap: 'wrap', gap: '6px', borderBottom: BORDER, paddingBottom: '8px' },
      tab: {
        padding: '5px 13px',
        borderRadius: '999px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.7,
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '14px',
        // 点过之后浏览器会给按钮一个默认 focus 轮廓，切到别的页签时旧按钮还留着灰框。
        outline: 'none',
        // 不给 border-color 做过渡：从彩色渐变回透明时中间那一下会发灰。
        transition: 'background .18s, color .18s',
      },
      tabOn: { opacity: 1, fontWeight: 600 },
      strip: { height: '3px', borderRadius: '2px', margin: '2px 0 10px' },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', paddingTop: '4px' },
      foot: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      btn: {
        padding: '5px 14px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '14px',
      },
      primary: { background: 'rgba(127,127,127,0.18)', fontWeight: 600 },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        width: '100%',
        padding: '8px 10px',
        borderRadius: '6px',
        border: BORDER,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
      },
      chevron: { marginLeft: 'auto', opacity: 0.6 },
      note: { fontSize: '13px', opacity: 0.7 },
      err: { fontSize: '13px', color: '#e5534b' },
      overridden: { fontSize: '12px', opacity: 0.5, marginLeft: '4px' },
      // “撤销覆盖”：与“·已覆盖”并排的小按钮。文案本身就是动作，不加图标。
      link: {
        marginLeft: '4px',
        padding: '0 4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.75,
        textDecoration: 'underline',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
      },
      ops: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    }

    function disabled(btn, off) {
      return off ? { ...btn, opacity: 0.5, cursor: 'default' } : btn
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function Card(props) {
      const scope = props.scope
      const subscribe = react.useCallback((cb) => scope.subscribe(cb), [scope])
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)

      const [draft, setDraft] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')
      // 折叠块：设置页里默认展开（分类页签要一眼能看到）
      const [open, setOpen] = react.useState(true)
      // 分类页签（连接 / 唤醒 / 权限 / 出站 / 语音 / 空间 / 上下文）
      const [tab, setTab] = react.useState('connect')
      // NapCat 的三个操作按钮：展开时拉一次接口；拿不到就保持 null（按钮禁用）。
      const [napcat, setNapcat] = react.useState(null)
      const [napcatBusy, setNapcatBusy] = react.useState('')

      const current = react.useMemo(() => draftFrom(snap.value), [snap.value])
      const shown = draft ?? current
      const dirty = draft !== null && !same(draft, current)
      const user = snap.user && typeof snap.user === 'object' ? snap.user : {}

      // ── 目标会话的下拉数据源 ──────────────────────────────────────────────
      // ctx.sessions.list 是客户端 SDK 暴露的会话列表快照（ObservableSnapshot）。
      // 取不到（这个部署没装 sessions 服务、或它还没就绪）就退回“只有兜底项”，
      // 卡片本身照常渲染 —— 宁可少一个下拉，也不要整张卡片消失。
      const sessions = props.sessionsOf ? props.sessionsOf() : undefined
      const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list : undefined
      const listSubscribe = react.useCallback((cb) => (listStore ? listStore.subscribe(cb) : () => {}), [listStore])
      const listGetSnapshot = react.useCallback(
        () => (listStore ? listStore.getSnapshot() : EMPTY_SESSION_LIST),
        [listStore],
      )
      const sessionList = react.useSyncExternalStore(listSubscribe, listGetSnapshot)
      react.useEffect(() => {
        // 进卡片时拉一次，免得显示的是很久以前的标题
        if (sessions && typeof sessions.refresh === 'function') Promise.resolve(sessions.refresh()).catch(() => {})
      }, [sessions])

      // 归档集在 workspace 域：ctx.workspaces.list 的快照里有 archivedSessionIds
      //（“Complete registry-global archive set”）。取不到就当作“没有归档的会话”——
      // 宁可多列几个，也别把用户能选的会话藏掉。
      const workspaces = props.workspacesOf ? props.workspacesOf() : undefined
      const wsStore =
        workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : undefined
      const wsSubscribe = react.useCallback((cb) => (wsStore && typeof wsStore.subscribe === 'function' ? wsStore.subscribe(cb) : () => {}), [wsStore])
      const wsGetSnapshot = react.useCallback(() => {
        if (!wsStore) return EMPTY_WORKSPACES
        try {
          return wsStore.getSnapshot() ?? EMPTY_WORKSPACES
        } catch {
          return EMPTY_WORKSPACES
        }
      }, [wsStore])
      const workspaceSnapshot = react.useSyncExternalStore(wsSubscribe, wsGetSnapshot)

      /**
       * 拉一次 NapCat 状态（WebUI 地址 + 是否在运行）。
       * 没有 fetch 或响应不是 ok:true 时返回 undefined，调用方保持上一次的状态。
       */
      async function fetchNapcat() {
        if (typeof fetch !== 'function') return undefined
        const res = await fetch(NAPCAT_API, { headers: { accept: 'application/json' } })
        const body = await res.json().catch(() => ({}))
        return body && body.ok === true ? body : undefined
      }

      // 展开卡片时读一次 NapCat 状态，之后每 5 秒轮询一次。
      // 轮询用于识别外部启动：用户在别处手动跑了 bat 时，只有重新拉取才能把按钮改成“已在运行”。
      // 卡片收起或组件卸载时清掉定时器，不让它在后台一直跑。
      react.useEffect(() => {
        if (tab !== 'connect') return undefined
        let alive = true
        const pull = () => {
          fetchNapcat()
            .then((body) => {
              if (alive && body !== undefined) setNapcat(body)
            })
            .catch(() => {
              // 单次失败保留上一次的状态：轮询会再试，不给按钮闪一下禁用。
            })
        }
        pull()
        const timer = setInterval(pull, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [tab])

      /** 两个 POST 按钮共用：动作没成（ok:false）也把宿主的 error 原文显示出来。 */
      async function postNapcat(action, okNote) {
        setNapcatBusy(action)
        setError('')
        setNote('')
        try {
          if (typeof fetch !== 'function') throw new Error('这个环境没有 fetch')
          // 显式声明 JSON：宿主接口对**带请求体**的 POST 只认 application/json。
          // 这两个动作本身没有请求体，服务端也放行无体的 POST —— 那条是给还没刷新的旧 bundle 兜底。
          const res = await fetch(`${NAPCAT_API}/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(String(body?.error || `HTTP ${res.status}`))
          setNote(String(body?.message || okNote))
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setNapcatBusy('')
          // 成功或失败都重拉一次：启动成功后按钮要立刻变“已在运行”，
          // 被宿主拒绝（例如已在运行）时也要把真实状态显示出来。
          try {
            const fresh = await fetchNapcat()
            if (fresh !== undefined) setNapcat(fresh)
          } catch {
            // 拉取失败时保留上一次的状态
          }
        }
      }

      function change(key) {
        return (event) => {
          const next = { ...shown }
          next[key] = event.target.type === 'checkbox' ? event.target.checked : event.target.value
          setDraft(next)
          setNote('')
          setError('')
        }
      }

      async function save() {
        setBusy(true)
        setError('')
        setNote('')
        try {
          const writes = []
          for (const f of FIELDS) {
            if (same(current[f.key], shown[f.key])) continue
            const next = parse(f, shown[f.key])
            if (next === undefined) throw new Error(`「${f.label}」不是合法数字`)
            writes.push([f.key, next])
          }
          for (const [key, value] of writes) await scope.set(key, value)
          setDraft(null)
          setNote(writes.length === 0 ? '没有改动' : `已保存 ${writes.length} 项`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      /**
       * 撤销一个字段的本机覆盖。
       *
       * 设置读取优先级是“设置文件 > composition config”。卡片只发 set 时，
       * 用户从插件配置页改的值会被设置文件里的旧值盖住，且没有地方撤销。
       * 这里走设置源的 unset：清掉那一项，该键回落到 composition config 的值，
       * 刷新后“·已覆盖”标记消失。
       */
      async function unsetOverride(key) {
        const field = FIELDS.find((f) => f.key === key)
        setBusy(true)
        setError('')
        setNote('')
        try {
          if (typeof scope.unset !== 'function') throw new Error('这个设置源不支持撤销覆盖')
          await scope.unset(key)
          setDraft(null)
          setNote(`已撤销「${field ? field.label : key}」的本机覆盖`)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      if (snap.status === 'loading') {
        return h('div', { style: S.wrap }, h('div', { style: S.sub }, '载入设置中…'))
      }
      if (snap.status === 'unavailable') {
        return h(
          'div',
          { style: S.wrap },
          h('div', { style: S.title }, 'QQ 桥接'),
          h(
            'div',
            { style: S.sub },
            '这个部署没有为 qq-bridge 提供可写的设置服务（settings 提供者没挂载，或连接处于内存模式）。',
          ),
          h(
            'div',
            { style: S.hint },
            '宿主的两条设置通道都没拿到：插件配置表单（DSH 0.2.0 的 #677 迁移未完成）与本插件的本机设置接口。',
          ),
          h(
            'div',
            { style: S.hint },
            '先看诊断里「本机接口」那项：若宿主没有 webServer 服务，接口挂不上（此时仍可点右上角「打开配置文件」，改 profile 的 cordis.patch.yml 里 `- id: qq-bridge` 的 config 后重启）。',
          ),
          h(
            'div',
            { style: S.hint },
            `诊断：${typeof scope.detail === 'function' ? scope.detail() : '（无诊断信息）'}`,
          ),
        )
      }

      const group = GROUPS.find((item) => item.id === tab) || GROUPS[0]
      const rows = []
      for (const key of group.fields) {
        const f = FIELDS.find((item) => item.key === key)
        if (!f) continue
        const value = shown[f.key]
        const overridden = Object.prototype.hasOwnProperty.call(user, f.key)
        let control
        if (f.kind === 'boolean') {
          control = h(
            'label',
            { style: S.check },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              disabled: !snap.writable || busy,
              onChange: change(f.key),
            }),
            h('span', null, f.hint || ''),
          )
        } else if (f.kind === 'select') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            (f.options || []).map(([v, text]) => h('option', { key: v, value: v }, text)),
          )
        } else if (f.kind === 'session') {
          control = h(
            'select',
            { style: S.input, value: String(value), disabled: !snap.writable || busy, onChange: change(f.key) },
            sessionOptions(sessionList, value, workspaceSnapshot?.archivedSessionIds).map((o) =>
              h('option', { key: o.value || '(none)', value: o.value }, o.label),
            ),
          )
        } else if (f.kind === 'list') {
          // 列表类字段一律「一行一个」：显示成多行，保存时仍是数组，顺序不变。
          control = h('textarea', {
            style: S.area,
            rows: 4,
            value: Array.isArray(value) ? value.join('\n') : String(value ?? ''),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
            placeholder: '一行一个',
          })
        } else {
          control = h('input', {
            type: f.kind === 'number' ? 'number' : 'text',
            ...(f.step ? { step: f.step } : {}),
            style: S.input,
            value: String(value),
            disabled: !snap.writable || busy,
            onChange: change(f.key),
            spellCheck: false,
          })
        }
        rows.push(
          h(
            'div',
            { key: f.key, style: S.label },
            f.label,
            overridden ? h('span', { style: S.overridden }, '·已覆盖') : null,
            // 每个字段都有自己的标签格，所以逐字段放按钮对所有类型都成立 —— 不必只给一个统一按钮。
            overridden
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: disabled(S.link, busy || !snap.writable),
                    disabled: busy || !snap.writable,
                    title: '清掉设置文件里的这一项，回落到 composition config 的值',
                    onClick: () => unsetOverride(f.key),
                  },
                  '撤销覆盖',
                )
              : null,
          ),
        )
        rows.push(
          h(
            'div',
            { key: `${f.key}-ctl` },
            control,
            f.kind !== 'boolean' && f.hint
              ? h(
                  'div',
                  { style: S.hint },
                  // 会话下拉额外把真实 id 显示出来：看着名字选，但真要手抄/核对时 id 就在旁边
                  (f.kind === 'session' && String(value) !== '' ? `${f.hint}当前：${value}` : f.hint) +
                    (typeof f.check === 'function' && f.check(value) ? `\n⚠️ ${f.check(value)}` : ''),
                )
              : null,
          ),
        )
      }

      // “打开 WebUI”只在真读到 webui.json 时可点 —— 地址里带着 token，不给猜的余地。
      const webuiUrl = napcat && typeof napcat.webuiUrl === 'string' ? napcat.webuiUrl : ''
      // 宿主报的 running 是权威判据（含外部启动的 NapCat）。拿不到状态时按未运行处理。
      const napcatRunning = napcat !== null && napcat.running === true
      const napcatOps = h(
        'div',
        { style: S.ops },
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, webuiUrl === '' || napcatBusy !== ''),
            disabled: webuiUrl === '' || napcatBusy !== '',
            onClick: () => {
              if (webuiUrl !== '') window.open(webuiUrl, '_blank', 'noopener')
            },
          },
          '打开 WebUI',
        ),
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, napcatRunning || napcatBusy !== ''),
            disabled: napcatRunning || napcatBusy !== '',
            onClick: () => postNapcat('launch', '已启动 NapCat'),
          },
          napcatRunning ? '已在运行' : napcatBusy === 'launch' ? '启动中…' : '启动 NapCat',
        ),
        h(
          'button',
          {
            type: 'button',
            style: disabled(S.btn, napcatBusy !== ''),
            disabled: napcatBusy !== '',
            onClick: () =>
              postNapcat('reveal', napcat && napcat.installDir ? `已打开文件夹：${napcat.installDir}` : '已打开文件夹'),
          },
          napcatBusy === 'reveal' ? '打开中…' : '打开文件夹',
        ),
        webuiUrl === '' ? h('span', { style: S.hint }, '没读到 webui.json') : null,
      )

      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
        h('span', { style: { ...S.title, fontSize: '17px', letterSpacing: '0.04em' } }, 'QQ 桥接'),
        h('span', { style: S.sub }, dirty ? '有未保存的改动' : '把固定的 DSH 会话接到 QQ'),
        h(
          'span',
          {
            style: {
              marginLeft: 'auto',
              fontSize: '13px',
              color: 'var(--dsw-alias-state-success-primary)',
            },
          },
          '● 设置已载入',
        ),
      )

      // 横向分类页签：一个分类一块，激活项用该分类的强调色。
      const tabsNav = h(
        'div',
        { style: S.tabs },
        GROUPS.map((item) =>
          h(
            'button',
            {
              key: item.id,
              type: 'button',
              style:
                item.id === group.id
                  ? {
                      ...S.tab,
                      ...S.tabOn,
                      color: item.accent,
                      borderColor: item.accent,
                      background: `color-mix(in srgb, ${item.accent} 12%, transparent)`,
                    }
                  : { ...S.tab, borderColor: 'transparent', background: 'transparent' },
              onClick: () => setTab(item.id),
            },
            item.label,
          ),
        ),
      )

      return h(
        'div',
        { style: S.wrap },
        header,
        tabsNav,
        h('div', { style: { ...S.strip, background: group.accent } }),
        h('div', { style: S.grid }, rows),
        group.id === 'connect' ? napcatOps : null,
        h(
          'div',
          { style: S.foot },
          h(
            'button',
            {
              type: 'button',
              style: disabled({ ...S.btn, ...S.primary }, !dirty || busy || !snap.writable),
              disabled: !dirty || busy || !snap.writable,
              onClick: save,
            },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            {
              type: 'button',
              style: disabled(S.btn, !dirty || busy),
              disabled: !dirty || busy,
              onClick: () => {
                setDraft(null)
                setError('')
                setNote('')
              },
            },
            '放弃修改',
          ),
          !snap.writable ? h('span', { style: S.note }, '（只读：这个连接不改宿主文档）') : null,
          error ? h('span', { style: S.err }, error) : null,
          !error && note ? h('span', { style: S.note }, note) : null,
        ),
      )
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    /** 需要的浏览器服务：slots（注册卡片）；settingsScope 在 apply 里等它出现。 */
    const inject = ['slots']

    // TODO(0.2.0): 平台把第三方插件的设置桥接上之后（web-all / DSH 修完 #677 的迁移），
    // 可以砍掉多余候选 key 与卡片上那行“诊断”；`namespaces` / `detail()` 建议保留（排障用）。
    // 详见 docs/dsh-0.2.0-migration.md 的 TODO 节。
    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑，谁 ready 用谁**。
     */
    /** 0.2.0 的兜底数据源：宿主自己挂的本机接口（见宿主半的 handleSettingsRequest）。 */
    const API_PATH = '/api/qq-bridge/settings'
    /** NapCat 操作接口（宿主半不受 legacy 门控，两代宿主都挂）。 */
    const NAPCAT_API = '/api/qq-bridge/napcat'
    /** 稳定引用：useSyncExternalStore 的 getSnapshot 每次返回新对象会死循环。 */
    const LOADING_SNAPSHOT = { status: 'loading' }
    const UNAVAILABLE_SNAPSHOT = { status: 'unavailable' }

    /**
     * 走宿主本机接口的设置域（0.2.0 用）。
     *
     * 为什么需要它：0.2.0 的 `webUiSettings` 桥对第三方插件永远返回 `unavailable`
     * （证据见 docs/dsh-0.2.0-migration.md）。范本：皮肤中心
     * `@linxin666/dsh-client-ui-skin-center` 就是自己 `inject: ["webServer"]` 挂
     * `/api/skin-center/...`，浏览器半直接 fetch 它，全程不碰宿主 settings 服务。
     *
     * 小 store：fetch 一次 → 缓存 snapshot → 通知订阅者；`set` 走 POST 再刷新。
     * 快照形状与宿主 scope 对齐（`status` / `value` / `user` / `writable`），卡片不用改。
     */
    function createApiScope() {
      const listeners = new Set()
      let snapshot = { status: 'idle' }
      let started = false
      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 一个订阅者抛错不该影响别人
          }
        }
      }
      const accept = (body) => {
        const overridden = Array.isArray(body?.overridden) ? body.overridden : []
        publish({
          status: 'ready',
          value: body?.values && typeof body.values === 'object' ? body.values : {},
          user: Object.fromEntries(overridden.map((key) => [key, true])),
          writable: true,
        })
      }
      const load = async () => {
        if (typeof fetch !== 'function') {
          publish({ status: 'unavailable', reason: 'no-fetch' })
          return
        }
        publish({ status: 'loading' })
        try {
          const res = await fetch(API_PATH, { headers: { accept: 'application/json' } })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        } catch (error) {
          publish({ status: 'unavailable', reason: `api: ${error?.message ?? error}` })
        }
      }
      return {
        kind: 'api',
        getSnapshot: () => snapshot,
        start: () => {
          if (started) return
          started = true
          load()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: async (field, value) => {
          const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ set: { [field]: value } }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
        /** 撤销一个字段的本机覆盖：接口本来就支持 `unset`，这里只是把它暴露给卡片。 */
        unset: async (field) => {
          if (typeof fetch !== 'function') throw new Error('qq-bridge: 这个环境没有 fetch')
          const res = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unset: [field] }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body?.ok !== true) throw new Error(body?.error || `HTTP ${res.status}`)
          accept(body)
        },
      }
    }

    /**
     * 绑一个**可写的**设置域。导出（经 __test）以便离线测试。
     *
     * 两代 DSH 对“这个插件的设置”用的 key 不一样：
     *   0.1.5-rc.3：settings 命名空间 —— `qq-bridge`（宿主半 register 出来的）；
     *   0.2.0     ：profile **entry id** —— `include:qq-bridge`（由插件自己的 Config 投影而来）。
     * 只绑前者的话，0.2.0 上永远拿到 `unavailable`，用户看到的就是“这个部署没有为 qq-bridge
     * 提供可写的设置服务”（2026-10-01 桌面端真机）。所以**两个都绑、谁 ready 用谁**；
     * **全都不 ready** 时再退到宿主自己的本机接口（0.2.0 的兜底，见 createApiScope）。
     */
    function bindSettings(service) {
      const unavailable = UNAVAILABLE_SNAPSHOT
      const candidates = []
      // 0.2.0 的表单 key 到底叫什么，源码里能看到的写法**全试一遍**（谁 ready 用谁）：
      // settings 命名空间 / profile entry id / 包名，以及带 include: 前缀的两种。
      for (const namespace of [NS, `include:${NS}`, 'dsh-qq-bridge', 'include:dsh-qq-bridge']) {
        try {
          const scope = service.bind({ namespace })
          if (scope && typeof scope === 'object') candidates.push({ namespace, scope })
        } catch (error) {
          // 某个候选绑不上不影响另一个。
          console?.debug?.(`qq-bridge: bind(${namespace}) 失败：${error?.message ?? error}`)
        }
      }
      const snapshotOf = (candidate) => {
        try {
          return candidate.scope.getSnapshot?.() ?? unavailable
        } catch {
          return unavailable
        }
      }
      const readyScope = () => candidates.find((candidate) => snapshotOf(candidate).status === 'ready')
      const anyLoading = () => candidates.some((candidate) => snapshotOf(candidate).status === 'loading')
      const api = createApiScope()
      return {
        // 供排障/测试看：这次到底绑到了哪些 key
        namespaces: candidates.map((candidate) => candidate.namespace),
        /** 这次数据从哪来（排障/测试用）：'scope' | 'api' | 'none'。 */
        via: () => {
          if (readyScope()) return 'scope'
          return api.getSnapshot().status === 'ready' ? 'api' : 'none'
        },
        /**
         * 每个候选的当前状态。直接显示在卡片上 —— 0.2.0 的 key 叫什么，
         * 与其猜，不如让它自己报（2026-10-01 真机就是靠这个收敛的）。
         */
        detail: () => {
          const scopes =
            candidates.length === 0
              ? '一个候选都没绑上（webUiSettings.bind 全部抛错）'
              : candidates.map((candidate) => `${candidate.namespace}=${snapshotOf(candidate).status}`).join('、')
          const apiSnap = api.getSnapshot()
          return `${scopes}；本机接口=${apiSnap.status}${apiSnap.reason ? `（${apiSnap.reason}）` : ''}`
        },
        getSnapshot: () => {
          const candidate = readyScope()
          if (candidate) return snapshotOf(candidate)
          // scope 全不可用 → 退到宿主本机接口；第一次问就把它跑起来。
          if (!anyLoading()) api.start()
          const apiSnap = api.getSnapshot()
          if (apiSnap.status === 'ready') return apiSnap
          if (apiSnap.status === 'loading' || apiSnap.status === 'idle') return LOADING_SNAPSHOT
          return unavailable
        },
        subscribe: (listener) => {
          const offs = []
          for (const candidate of candidates) {
            try {
              const off = candidate.scope.subscribe?.(listener)
              if (typeof off === 'function') offs.push(off)
            } catch {
              // 订阅失败不影响其它候选
            }
          }
          offs.push(api.subscribe(listener))
          if (!readyScope() && !anyLoading()) api.start()
          return () => {
            for (const off of offs) off()
          }
        },
        set: (field, value) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.set === 'function') return candidate.scope.set(field, value)
          if (api.getSnapshot().status === 'ready') return api.set(field, value)
          throw new Error('qq-bridge: 没有可写的设置源')
        },
        /**
         * 撤销一个字段的本机覆盖。
         *
         * 优先用设置域自己的 `unset`（DSH 的 SettingsScope 有这个能力）；
         * 设置域没有它时走本机接口的 `unset`（宿主半的 handleSettingsRequest 本来就支持）。
         */
        unset: (field) => {
          const candidate = readyScope()
          if (candidate && typeof candidate.scope.unset === 'function') return candidate.scope.unset(field)
          return api.unset(field)
        },
      }
    }

    function apply(ctx) {
      // ⚠️ DSH 两代之间**两处都换了名字**（2026-10-01 用户指出第二处）：
      //   ① 客户端**设置服务**：0.1.5-rc.3（web-all 0.3.x）叫 `settingsScope`，
      //      0.2.0（web-all 0.4.x）叫 `webUiSettings`；
      //   ② 插件配置页的**挂载 slot**：0.1.5-rc.3 是 `settings.plugin.item`（按 settings 命名空间派发），
      //      0.2.0 是 `settings.plugins.tab`（插件自己是一个 tab）。
      // 只 inject 旧服务名 = 0.2.0 上回调永远不跑（Cordis 的 inject 是响应式的，等不到就一直等），
      // slot 再双注册也没用 —— 所以**服务门和 slot 都要各敲两遍**。
      let registered = false
      const setup = (service, scoped) => {
        // 万一某个版本两个服务都在：只注册一次，别把卡片注册成两份。
        if (registered) return
        if (!service || typeof service.bind !== 'function') return
        registered = true
        // 两个 key 都绑，谁 ready 用谁（0.1.5 的命名空间 vs 0.2.0 的 entry id）。
        const scope = bindSettings(service)
        // sessionsOf 用“取的时候再解析”而不是现在取一次：
        // sessions 服务可能比本插件晚出现，也可能这个部署根本没装 —— 那时卡片照常渲染，
        // 只是目标会话那一栏只有一个兜底项，而不是整张卡片消失。
        const card = () =>
          h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') })

        // slot 也各注册一遍：`slots.inject(slot, factory)` 只在那个 slot 存在时才跑 factory，
        // 所以多注入一个是安全的；外面再包一层 try，兜住“slot 不存在就直接抛错”的实现。
        const registerCard = (slot, options) => {
          try {
            scoped.slots.inject(slot, () => scoped.slots.register({ ...options, name: slot }, card))
          } catch (error) {
            // 这个版本的 DSH 没有这个 slot —— 忽略，另一个会生效。
            console?.debug?.(`qq-bridge: slot ${slot} unavailable (${error?.message ?? error})`)
          }
        }
        registerCard('settings.plugin.item', { key: NS })
        registerCard('settings.plugins.tab', { id: NS, order: 100, label: () => 'QQ 桥接' })
      }
      // 每扇门里再互相兜一下（社区插件 `@linxin666/*` 的写法是 `ctx.get('webUiSettings') ?? ctx.settingsScope`）：
      // 万一某版本两个服务都在、或名字以后又微调，两条路都拿得到；`registered` 闸门保证只注册一次。
      // 两个服务的 **API 一致**：`bind({ namespace })` 之后同样是 `getSnapshot() / set() / subscribe()`
      // （本卡片只用这三个），活参考见 `@linxin666/dsh-pet/lib/client.js`。
      ctx.inject(['settingsScope'], (scoped) => setup(scoped.settingsScope ?? scoped.get?.('webUiSettings'), scoped))
      ctx.inject(['webUiSettings'], (scoped) => setup(scoped.webUiSettings ?? scoped.get?.('settingsScope'), scoped))

      // ── DSH 44.x：两个设置服务都没有 ────────────────────────────────────────
      //
      // 2026-11-24 实测（clients Service 目录只有 layout/locale/sessions/slots/theme/timer/
      // uiWorkspace/workspaces）：`settingsScope` 和 `webUiSettings` 都不存在，上面两条
      // `ctx.inject` 的回调永远不跑，卡片也就永远不出现。但 `settings.plugins.tab` 这个
      // slot 还在（插件管理 WC 自己占了 `all`），而宿主半的 `/api/qq-bridge/settings`
      // 本来就可用 —— 所以直接用本机接口当数据源，自己注册一个 tab。
      //
      // 用 setTimeout 推一拍：旧版 DSH 上让原生服务先注册，避免这里抢先；新版没有原生服务，
      // 推一拍也不会错过什么。
      const setupApi = (scoped) => {
        if (registered) return
        if (ctx.get?.('settingsScope') || ctx.get?.('webUiSettings')) return
        if (!scoped?.slots?.register) return
        registered = true
        const api = createApiScope()
        api.start()
        const scope = {
          namespaces: [],
          via: () => 'api',
          detail: () => '本机接口 /api/qq-bridge/settings',
          getSnapshot: () => api.getSnapshot(),
          subscribe: (listener) => api.subscribe(listener),
          set: (field, value) => api.set(field, value),
          unset: (field) => api.unset(field),
        }
        const card = () =>
          h(Card, { scope, sessionsOf: () => ctx.get('sessions'), workspacesOf: () => ctx.get('workspaces') })
        // 两个挂载点都试：
        //   ① settings.section —— 设置页左侧直接多一项「QQ 桥接」（世界控制台、皮肤就是这么挂的）；
        //   ② settings.plugins.tab —— 设置 → 插件 里的页签（有些部署把插件 section 隐藏了，光靠它不显示）。
        const registerCard = (slot, options) => {
          try {
            scoped.slots.inject(slot, () =>
              scoped.slots.register({ ...options, name: slot }, card),
            )
          } catch (error) {
            console?.debug?.(`qq-bridge: slot ${slot} unavailable (${error?.message ?? error})`)
          }
        }
        registerCard('settings.section', { id: 'qq-bridge', order: 30, label: () => 'QQ 桥接' })
        registerCard('settings.plugins.tab', { id: NS, order: 100, label: () => 'QQ 桥接' })
      }
      ctx.inject(['slots'], (scoped) => {
        setTimeout(() => {
          try {
            setupApi(scoped)
          } catch (error) {
            console?.debug?.(`qq-bridge: api 设置卡片注册失败 (${error?.message ?? error})`)
          }
        }, 0)
      })
    }

    exports.apply = apply
    exports.inject = inject
    // 导出 name：Cordis 用它做插件标识，Slots inspect 里的 registrant 会显示成它
    // （不导的话那边显示的是产物里的 fallback 短名，排障时认不出是谁注册的卡片）。
    exports.name = 'dsh-qq-bridge'
    // 纯函数给离线测试用（test-smoke.mjs 会在假 ctx 里真跑这个 bundle）。
    // Cordis 只认 apply / inject / name / Config，多余的导出它不管。
    exports.__test = { sessionOptions, draftFrom, parse, fields: FIELDS, bindSettings }
    return module.exports
  },
})
