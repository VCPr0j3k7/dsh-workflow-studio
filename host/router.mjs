/**
 * 宿主半边的 HTTP 门面。
 *
 * ## 一个前缀，一张路由表
 *
 * 插件在 `ctx.webServer` 上只注册一条 `kind: 'prefix'` 路由（`/dsh-workflow-studio/api`），
 * 前缀内部的派发由这里完成。注册点只有一处，卸载时框架自动清理。
 *
 * ## 为什么统一返回 `{ok, data|error}` 而不是用 HTTP 状态码
 *
 * 客户端半边按这个形状解包。业务失败同样返回 200 —— 状态码留给「路由不存在」
 * 这类传输层事实。这样客户端只需要一套解包逻辑。
 *
 * ## 为什么用轮询而不是 SSE
 *
 * 外壳（`dsh-app://` 自定义 scheme）转发时是否会缓冲响应体无法确认；轮询没有这个
 * 未知数，代价只是 300ms 的粒度 —— 对进度类反馈完全够用。`?since=<seq>` 拉增量，
 * 与服务端环形队列配合，客户端断线重连后也不会丢事件。
 */
const MAX_BODY = 8 * 1024 * 1024
/** 事件环形队列保留的条数。客户端每 300ms 轮询一次，600 条足以覆盖任一轮询间隔内的突发量。 */
const MAX_EVENTS = 600

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error(`请求体超过 ${String(MAX_BODY)} 字节`)
    chunks.push(chunk)
  }
  if (size === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 建一个插件宿主半边。
 *
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx 宿主根上下文
 * @param {string} options.prefix 路由前缀
 * @param {string} options.id 本插件的模块 id（= 包名）。客户端靠 `data.plugin` 与它比对认宿主，
 *        给错值会让插件在界面上彻底静默（连不上宿主，也不报错）。
 * @param {Record<string, (input: {body: any, query: URLSearchParams, req: any}) => any>} options.routes
 * @param {(message: string) => void} [options.log]
 */
export function createRouter({ ctx, prefix, id, routes, log = () => {} }) {
  if (typeof id !== 'string' || id === '') throw new Error(`createRouter 缺少 id（客户端靠它认宿主）`)

  /** 事件环形队列。seq 单调递增，客户端用 `?since=` 拉增量。 */
  const events = []
  let seq = 0
  const emit = (payload) => {
    seq += 1
    events.push({ seq, payload })
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    return seq
  }

  const table = new Map()
  for (const [key, handler] of Object.entries(routes)) table.set(key, handler)

  const dispatch = async (req, res) => {
    let pathname = '/'
    let query = new URLSearchParams()
    try {
      /*
       * 用 `new URL(...).pathname` 取路径，不要字符串裁查询串。
       * 请求行若以 `//` 开头会被当成 network-path reference，裁出来的东西永远匹配不上。
       */
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      pathname = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname
      query = url.searchParams
    } catch {
      send(res, 400, { ok: false, error: '请求地址无法解析' })
      return
    }
    if (pathname === '') pathname = '/'

    const method = String(req.method ?? 'GET').toUpperCase()
    const handler = table.get(`${method} ${pathname}`)
    if (handler === undefined) {
      send(res, 404, { ok: false, error: `未知路由：${method} ${pathname}` })
      return
    }

    try {
      const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req)
      const data = await handler({ body, query, req })
      send(res, 200, { ok: true, data: data === undefined ? null : data })
    } catch (error) {
      const message = String(error?.message ?? error)
      log(`${method} ${pathname} 失败：${message}`)
      send(res, 200, { ok: false, error: message })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: prefix, handler: dispatch })
  log(`已挂载路由 ${prefix}（${String(table.size)} 条）`)

  return { emit, dispose, dispatch, table, eventCount: () => seq }
}
