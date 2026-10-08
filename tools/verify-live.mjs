/**
 * 端到端验证：在隔离的第二个 Host 实例上打插件自己的 HTTP 面。
 *
 * 验的是「真宿主里到底有没有这个东西」，而不是「逻辑对不对」（后者由 test/check.mjs 负责）：
 *   1. 宿主半边装载了没有（`/info` 是否 200 且 `plugin` 等于模块 id）；
 *   2. 工作流库扫到了没有（`/state` 的 `library.items`）；
 *   3. 单个工作流能不能取出来（`/library/item` 的 frontmatter 解析结果）；
 *   4. 事件队列在不在（`/events` 的 `seq`）；
 *   5. 客户端 bundle 有没有被宿主发出来，且仍是 `__ModuleLoader__.load` 形状；
 *   6. 诊断日志有没有落盘。
 *
 * 用法：node tools/verify-live.mjs [port]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PORT = process.argv[2] ?? '19399'
import { PLUGIN_ROOT, PROBE_HOME as PROBE_HOME_DIR, runtimeLayout } from './paths.mjs'

const LAYOUT = runtimeLayout()
const INSTALL = LAYOUT.install
const ASAR = LAYOUT.asar
const PROBE_HOME = PROBE_HOME_DIR
const PLUGIN_DIR = PLUGIN_ROOT
const HERE = `${PLUGIN_ROOT}/tools`

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${String(detail)}`}`)
  }
}

//#region 探针 profile

const profileDir = join(PROBE_HOME, 'profiles', 'desktop')
rmSync(PROBE_HOME, { recursive: true, force: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(join(profileDir, 'cordis.yml'), '# probe profile root\n[]\n', 'utf8')
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { 'dsh-workflow-studio': `file:${PLUGIN_DIR}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-workflow-studio'] } },
    },
    null,
    2,
  )}\n`,
  'utf8',
)
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# probe patch layer\n[]\n', 'utf8')
symlinkSync(PLUGIN_DIR, join(profileDir, 'node_modules', 'dsh-workflow-studio'), 'junction')

const hookPath = join(HERE, '_probe-port-hook.mjs')
writeFileSync(
  hookPath,
  `import { registerHooks } from 'node:module'
const port = process.env.DSH_PROBE_PORT
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.includes('dsh-desktop-host') && result?.source != null) {
      const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
      if (text.includes('"19387"')) return { ...result, source: text.split('"19387"').join('"' + port + '"') }
    }
    return result
  },
})
`,
  'utf8',
)

//#endregion

const child = spawn(
  `${INSTALL}/DeepSeek Harness.exe`,
  [
    '--expose-internals',
    '--import',
    pathToFileURL(hookPath).href,
    `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
    `${ASAR}/dsh`,
    profileDir,
    `${RESOURCES}/runtime/primary-runtime`,
    `${RESOURCES}/runtime/pnpm/bin/pnpm.cjs`,
    `${RESOURCES}/runtime/primary-runtime/dependencies/node/bin`,
  ],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: PROBE_HOME, DSH_PROBE_PORT: PORT },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  },
)

let done = false
function finish(code) {
  if (done) return
  done = true
  try {
    child.send({ type: 'shutdown' })
  } catch {
    // 忽略
  }
  setTimeout(() => {
    try {
      child.kill()
    } catch {
      // 忽略
    }
    console.log(`\n通过 ${String(passed)} 项，失败 ${String(failed)} 项`)
    process.exit(failed === 0 ? 0 : code)
  }, 1200)
}

child.on('message', async (message) => {
  if (message?.type === 'fatal') {
    console.error(`宿主致命错误：${message.message}`)
    finish(1)
    return
  }
  if (message?.type !== 'ready') return

  const base = new URL(message.url).origin
  console.log(`\n宿主就绪：${base}\n`)

  /*
   * 认证：根路径的 query token 只对 index 请求有效，用它换 cookie；
   * 其余路径都要 cookie。换法是 `redirect:'manual'` + 期待 303 + set-cookie。
   */
  let cookie = ''
  try {
    const response = await fetch(message.url, { redirect: 'manual' })
    const raw = response.headers.get('set-cookie') ?? ''
    cookie = raw.split(';')[0]
    check('用 launch token 换到了 cookie（303 + set-cookie）', response.status === 303 && cookie !== '', `status=${String(response.status)}`)
  } catch (error) {
    check('用 launch token 换到了 cookie', false, String(error.message))
  }

  const api = async (path) => {
    const response = await fetch(`${base}/dsh-workflow-studio/api${path}`, { headers: cookie === '' ? {} : { cookie } })
    const text = await response.text()
    try {
      return { status: response.status, payload: JSON.parse(text) }
    } catch {
      return { status: response.status, payload: null, text }
    }
  }

  console.log('\n宿主半边')

  const info = await api('/info')
  check('GET /info 返回 200', info.status === 200, `status=${String(info.status)}`)
  check(
    'GET /info 的 plugin 字段等于模块 id（客户端靠它认宿主）',
    info.payload?.data?.plugin === 'dsh-workflow-studio',
    JSON.stringify(info.payload).slice(0, 200),
  )
  /*
   * 引擎的可见性取决于组合：官方组合里它在根上下文，最小组合里它只在 agent preset 的组合里
   * （见 index.js 的 engineFor）。因此这里只断言「两个字段都被报出来了」，
   * 不断言具体值 —— 那是组合的属性，不是插件的属性。
   */
  check(
    '/info 同时报出根上下文与 agent 组合两条引擎可见性，并给出解析路径',
    typeof info.payload?.data?.hasEngine === 'boolean' &&
      'hasEngineForAgent' in info.payload.data &&
      typeof info.payload?.data?.engineVia === 'string',
    JSON.stringify(info.payload?.data),
  )
  console.log(`      （引擎解析路径：${String(info.payload?.data?.engineVia)}，根上下文 ${String(info.payload?.data?.hasEngine)}，活跃 agent ${String(info.payload?.data?.agentCount)}）`)

  const state = await api('/state?since=0')
  const items = state.payload?.data?.library?.items ?? []
  check('GET /state 返回工作流库', state.payload?.ok === true && Array.isArray(items), JSON.stringify(state.payload).slice(0, 200))
  check(
    '扫到了两个随包工作流',
    items.length >= 2 && items.some((item) => item.name === 'codebase-audit'),
    JSON.stringify(items.map((item) => item.name)),
  )
  check(
    '随包工作流的 phases 被解析出来',
    (items.find((item) => item.name === 'codebase-audit')?.phases ?? []).length === 3,
    JSON.stringify(items.find((item) => item.name === 'codebase-audit')?.phases),
  )

  const item = await api('/library/item?name=multi-angle-research')
  check('GET /library/item 取回脚本正文', (item.payload?.data?.script ?? '').includes('wfRun'), String(item.payload?.data?.script ?? '').slice(0, 80))
  check(
    'frontmatter 里的 graph 结构被解析出来',
    Array.isArray(item.payload?.data?.graph) && item.payload.data.graph.length === 4,
    JSON.stringify(item.payload?.data?.graph),
  )

  const events = await api('/events?since=0')
  check('GET /events 返回事件队列', typeof events.payload?.data?.seq === 'number', JSON.stringify(events.payload).slice(0, 160))

  const diagnose = await api('/diagnose')
  check(
    'GET /diagnose 报出每个活跃会话的引擎解析路径',
    diagnose.payload?.ok === true && Array.isArray(diagnose.payload?.data?.agents),
    JSON.stringify(diagnose.payload).slice(0, 200),
  )
  check(
    '/diagnose 报出「交给模型」那条路所需的 sessionController 可用',
    diagnose.payload?.data?.sessionControllerAvailable === true,
    `sessionControllerAvailable=${String(diagnose.payload?.data?.sessionControllerAvailable)}（/workflow <提示词> 靠它把任务注入会话）`,
  )

  const missing = await api('/nope')
  check('未知路由 404（没有被 SPA 兜底吃成 200）', missing.status === 404, `status=${String(missing.status)}`)

  const badRun = await api('/run?id=nope')
  check('业务失败是 200 + ok:false（不是 HTTP 错误码）', badRun.status === 200 && badRun.payload?.ok === false, JSON.stringify(badRun.payload).slice(0, 160))

  console.log('\n客户端半边')

  /*
   * index 必须**带 cookie** 取。根路径的 launch token 是单次使用的（换 cookie 用），
   * 拿同一个 token 再取一次只会被重定向 —— 早期版本就是这么误判成「插件没进 preload」的。
   */
  const indexResponse = await fetch(`${base}/`, { headers: cookie === '' ? {} : { cookie } })
  const indexHtml = await indexResponse.text()
  check('带 cookie 能取到 index HTML', indexResponse.status === 200 && indexHtml.length > 500, `status=${String(indexResponse.status)} len=${String(indexHtml.length)}`)

  /*
   * preload 的 href 里有 `&rev=<hash>`，**必须原样取出再请求** —— 手拼会 404。
   */
  const preloadMatch = /plugins\/\?\?[^"']*dsh-workflow-studio\/client\.js[^"']*/.exec(indexHtml)
  check('index 里出现了插件的 preload 链接', preloadMatch !== null, indexHtml.slice(0, 200))

  if (preloadMatch !== null) {
    const bundleUrl = new URL(preloadMatch[0].replace(/&amp;/g, '&'), `${base}/`).href
    const bundleResponse = await fetch(bundleUrl, { headers: cookie === '' ? {} : { cookie } })
    const bundleText = await bundleResponse.text()
    check(
      '客户端 bundle 可以按 index 给出的原样 URL 取到',
      bundleResponse.status === 200 && bundleText.length > 1000,
      `status=${String(bundleResponse.status)} len=${String(bundleText.length)} url=${bundleUrl.slice(0, 120)}`,
    )
    check(
      'bundle 仍是官方装载协议（window.__ModuleLoader__.load）',
      bundleText.includes('window.__ModuleLoader__.load') && bundleText.includes('dsh-workflow-studio'),
      bundleText.slice(0, 160),
    )
    check(
      'bundle 里注册了侧栏图标、主面板与输入框上方的常驻条三个槽位',
      bundleText.includes('sidebar.panellist') &&
        bundleText.includes('"main"') &&
        bundleText.includes('conversation.input.dock'),
      '',
    )
  }

  console.log('\n诊断')

  const logFile = `${PROBE_HOME}/plugin-data/logs/dsh-workflow-studio.log`
  check('插件日志已落盘', existsSync(logFile), logFile)
  if (existsSync(logFile)) {
    const logText = readFileSync(logFile, 'utf8')
    check('日志里有「已就绪」与路由条数', logText.includes('已就绪') && logText.includes('已挂载路由'), logText.slice(0, 300))
  }

  finish(0)
})

child.on('exit', (code) => {
  if (!done) {
    console.error(`宿主提前退出，code=${String(code)}`)
    finish(1)
  }
})

setTimeout(() => {
  if (!done) {
    console.error('超时：120 秒内没有收到 ready')
    finish(1)
  }
}, 120_000)
