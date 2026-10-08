/**
 * dsh-workflow-studio —— 宿主半边。
 *
 * ## 这个插件解决什么问题
 *
 * DSH 已经有很强的**工作流引擎**（`@deepseek-ai/dsh-workflow`，由 `workflow` 工具驱动）：
 * 脚本化的 fan-out、并发上限、取消、子智能体派生一应俱全。缺的是**人**的入口：
 *
 *   1. 工作流只能由模型现场写脚本触发，不能像 ZCode 那样 `/workflow` 直接调起；
 *   2. 工作流不能沉淀成可复用的文件（每次都要重新描述一遍）；
 *   3. 官方 UI（`dsh-client-ui-workflow-run`）只画「谁在跑、跑完没有」——
 *      阶段 → 成员两层的状态列表，**看不到每个子智能体在做什么**，
 *      也**看不到它们之间的结构关系**。
 *
 * 本插件补齐这三件事，且**不替换任何官方部件**：
 *
 *   - `/workflow` 注册进官方的 `ctx.commands`，因此在输入框的 `/` 菜单里就能看到；
 *   - 工作流存成 `<DSH_HOME>/workflows/*.js`，带 frontmatter 元数据；
 *   - 订阅 `workflow/*` 与 `session/event` 两条官方事件流，把运行投影成
 *     「阶段 → 子智能体 → 逐条工作内容 + 结构边」，通过 HTTP 交给客户端半边画图。
 *
 * ## 为什么用 `ctx.get` 而不是全部 inject
 *
 * `inject` 声明了但服务不在组合里时，插件会**一直等待、永不装载** —— 而且没有任何报错。
 * 因此只有「没有它这个插件就没有意义」的服务才 inject（webServer、commands），
 * 其余（workflowEngine、agents）在调用点用 `ctx.get()` 惰性取，取不到就给一句人话。
 */
import { createRouter } from './host/router.mjs'
import { appendLine, configureLogger, readLines } from './host/logger.mjs'
import { PLUGIN_ID, PROFILE_NAME, RUNTIME_DIR, dataDir, setHostContext, userWorkflowRoot } from './host/env.mjs'
import { composeScript } from './host/script.mjs'
import { createRunRegistry } from './host/runs.mjs'
import { deleteWorkflow, ensureWorkflowRoot, listWorkflows, readWorkflow, writeWorkflow } from './host/library.mjs'

/** Loader 身份。 */
export const name = PLUGIN_ID

/**
 * 只 inject 这两个。
 *
 * `webServer` 是 HTTP 门面；`commands` 是 `/workflow` 的落点。两者都在官方 base bundle 里，
 * 缺失时本插件确实无事可做 —— 这种「硬依赖」才配写进 inject。
 */
export const inject = ['webServer', 'commands']

const PREFIX = '/dsh-workflow-studio/api'
/** 事件环形队列长度。客户端每 300ms 轮询一次，600 条足以覆盖任一轮询间隔内的突发量。 */
const MAX_EVENTS = 600

export function apply(ctx) {
  setHostContext(ctx)
  configureLogger({ logFile: `${dataDir()}/logs/dsh-workflow-studio.log` })

  const log = (message) => {
    try {
      ctx.logger?.info?.(`[workflow-studio] ${message}`)
    } catch {
      // 忽略
    }
    appendLine(message, { source: 'workflow-studio' })
  }

  ensureWorkflowRoot()

  /** 运行号 → AbortController。`/workflow stop` 与界面上的「停止」都走它。 */
  const controllers = new Map()
  /** 运行号 → 发起它的会话 id。 */
  const parents = new Map()
  /** 运行号 → 发起会话的 Session 对象（用于把运行镜像进会话日志）。 */
  const recordSessions = new Map()

  //#region 事件队列

  /*
   * 客户端用 `?since=<seq>` 拉增量。队列独立于 HTTP 层存在，因为 run registry
   * 在 router 之前就要能往外发事件（registry 是 router 路由的数据源）。
   */
  const eventLog = []
  let eventSeq = 0
  const publish = (payload) => {
    eventSeq += 1
    eventLog.push({ seq: eventSeq, payload })
    if (eventLog.length > MAX_EVENTS) eventLog.splice(0, eventLog.length - MAX_EVENTS)
    return eventSeq
  }
  const drain = (since) => {
    const from = Number.isFinite(since) ? Math.max(0, Math.trunc(since)) : 0
    return { seq: eventSeq, events: eventLog.filter((entry) => entry.seq > from) }
  }

  //#endregion

  const registry = createRunRegistry({ ctx, emit: publish, log })

  //#region 服务访问

  /** 惰性取服务：`ctx.get` 是同步的，服务晚注册也没关系（每次调用点重新取）。 */
  const service = (key) => {
    try {
      return ctx.get?.(key) ?? null
    } catch {
      return null
    }
  }

  /**
   * 取工作流引擎。
   *
   * **不能只查根上下文。** `workflowEngine` 的提供方（`@deepseek-ai/dsh-workflow-ptc`）
   * 在官方组合里的行状态是 `inactive` —— 它**不活在根上下文**，而是随 agent preset
   * 挂载到会话自己的组合里。（实测：一个只有 base + web-app 的最小组合里，
   * 根上下文查不到；而官方桌面版的 base 里那一行同样标着 inactive。）
   *
   * 所以这里按「从宽到窄」试四条路，任何一条命中就用：
   *   1. 根上下文 —— 组合把引擎装在根上时的正常情况；
   *   2. `agentPresets.serviceFor(agent, …)` —— 官方为「服务在 agent 组合里」提供的**唯一**入口；
   *   3. `agent.ctx.get(…)` —— Agent 直接暴露自己上下文时；
   *   4. 沿 `agent.ctx` 的父链逐级 `get` —— 兜住 preset 的嵌套组合。
   *
   * 四条都不中就返回 null，让调用点给一句人话（而不是抛一个看不懂的错）。
   */
  function resolveEngine(agent) {
    const root = service('workflowEngine')
    if (root !== null) return { engine: root, via: 'root' }
    if (agent === undefined || agent === null) return { engine: null, via: 'no-agent' }

    // 2) preset 组合
    try {
      const viaPreset = service('agentPresets')?.serviceFor?.(agent, 'workflowEngine')
      if (viaPreset !== null && viaPreset !== undefined) return { engine: viaPreset, via: 'agentPresets.serviceFor' }
    } catch {
      // 继续试下一条
    }

    // 3) Agent 自己的上下文
    let agentCtx = null
    try {
      agentCtx = agent.ctx ?? null
    } catch {
      agentCtx = null
    }
    if (agentCtx !== null) {
      try {
        const direct = agentCtx.get?.('workflowEngine') ?? null
        if (direct !== null) return { engine: direct, via: 'agent.ctx' }
      } catch {
        // 继续
      }

      // 4) 父链
      let cursor = agentCtx
      for (let depth = 0; depth < 8 && cursor !== null && cursor !== undefined; depth += 1) {
        try {
          const found = cursor.get?.('workflowEngine') ?? null
          if (found !== null) return { engine: found, via: `agent.ctx.parent[${String(depth)}]` }
        } catch {
          // 继续往上
        }
        try {
          cursor = cursor.parent ?? null
        } catch {
          cursor = null
        }
      }
    }

    return { engine: null, via: 'unresolved' }
  }

  /** 取工作流引擎（只关心有没有）。 */
  const engineFor = (agent) => resolveEngine(agent).engine

  /** 根上下文里有没有引擎（`/info` 用；真正启动时走 engineFor）。 */
  const engine = () => service('workflowEngine')

  //#endregion

  //#region 把运行镜像进发起会话的持久日志

  /*
   * 用官方 `dsh-tool-workflow` 自己那套事件类型（`tool-workflow/run-start` 等），
   * 因此官方 `dsh-client-ui-workflow-run` 不需要任何改动，就会在会话里画出工作流卡片。
   *
   * 监听器在插件作用域注册**一次**，靠 recordSessions 过滤 —— 每次启动都新注册一对
   * 监听器会随运行数无限增长。
   */
  const appendToSession = (runId, type, data) => {
    const session = recordSessions.get(String(runId))
    if (session === undefined) return
    try {
      session.append(type, data)
    } catch (error) {
      log(`写入会话工作流记录失败（不影响运行）：${String(error?.message ?? error)}`)
      recordSessions.delete(String(runId))
    }
  }

  ctx.on('workflow/agent-start', (info, agent) => {
    appendToSession(info?.id, 'tool-workflow/agent-start', {
      runId: String(info?.id ?? ''),
      seq: agent.seq,
      label: agent.label,
      ...(agent.phase === undefined ? {} : { phase: agent.phase }),
      childId: String(agent.childId),
    })
  })
  ctx.on('workflow/agent-end', (info, agent) => {
    appendToSession(info?.id, 'tool-workflow/agent-end', {
      runId: String(info?.id ?? ''),
      seq: agent.seq,
      outcome: agent.outcome,
    })
  })
  ctx.on('workflow/end', (info, result) => {
    appendToSession(info?.id, 'tool-workflow/run-end', {
      runId: String(info?.id ?? ''),
      stopReason: String(result?.stopReason ?? 'error'),
    })
    recordSessions.delete(String(info?.id ?? ''))
  })

  //#endregion

  //#region 启动一个运行

  /**
   * 启动一个工作流。
   *
   * 关键点：**不与命令的 signal 绑定**。命令处理函数返回后，UI 那次请求的 signal 就废了，
   * 而工作流要跑几分钟。这里给每个运行一个自己的 AbortController，停止走 `/workflow stop`
   * 或界面按钮。
   */
  function startRun({ meta, script, graph = null, args, parent, parentSessionId = null }) {
    if (parent === undefined || parent === null) {
      throw new Error('启动工作流需要一个发起它的 agent（命令必须由某个会话发出）')
    }
    const workflowEngine = engineFor(parent)
    if (workflowEngine === null) {
      throw new Error(
        '找不到 workflowEngine 服务，无法启动工作流。它由 @deepseek-ai/dsh-workflow-ptc 提供，在官方组合里按 agent preset 挂载 —— 请确认当前会话使用的 preset 带工作流能力。',
      )
    }
    const controller = new AbortController()
    const run = workflowEngine.start({
      script: composeScript({ script, graph }),
      meta,
      ...(args === undefined ? {} : { args }),
      parent,
      signal: controller.signal,
    })
    const runId = String(run.id)
    controllers.set(runId, controller)
    if (parentSessionId !== null) parents.set(runId, String(parentSessionId))

    // 镜像进会话日志：拿不到 session 就静默跳过（这是增强，不是必需）
    const session = sessionFor(parent, parentSessionId)
    if (session !== null) {
      try {
        session.append('tool-workflow/run-start', { runId, name: meta.name })
        recordSessions.set(runId, session)
      } catch (error) {
        log(`写入会话工作流记录失败（不影响运行）：${String(error?.message ?? error)}`)
      }
    }

    void run.result
      .then((result) => {
        log(`运行 ${runId} 结算：${String(result?.stopReason)}`)
      })
      .catch((error) => {
        log(`运行 ${runId} 结果异常：${String(error?.message ?? error)}`)
      })
      .finally(() => {
        controllers.delete(runId)
        void run.dispose().catch(() => {})
      })
    return { runId, name: meta.name }
  }

  /**
   * 拿发起会话的 Session 对象。
   *
   * Agent 上有没有暴露 `session` 取决于服务投影的宽窄（官方 `Agent` 的最小契约只声明了 `id`），
   * 所以给两条路：先看 Agent 自己，再回落到 `agents.get(id)`。两条都不行就返回 null ——
   * 镜像进会话日志是增强，不是必需。
   */
  function sessionFor(parent, parentSessionId) {
    const direct = parent?.session ?? null
    if (direct !== null && typeof direct.append === 'function') return direct
    if (parentSessionId === null || parentSessionId === undefined) return null
    try {
      const found = service('agents')?.get?.(String(parentSessionId))?.session ?? null
      return found !== null && typeof found.append === 'function' ? found : null
    } catch {
      return null
    }
  }

  //#endregion

  //#region /workflow 命令

  const USAGE = [
    '用法：',
    '  /workflow <随便一句话>         把任务交给模型：它先想清楚拓扑，再用 workflow 工具启动',
    '  /workflow                     列出可用的工作流与在跑的运行',
    '  /workflow <已保存的名称> [JSON] 直接调起一个存好的工作流（后台跑，工作台里看进度）',
    '  /workflow prompt <文本>        强制走「交给模型」那条路（万一名字和你想说的话撞了）',
    '  /workflow show [运行号]        看某个运行的阶段与子智能体',
    '  /workflow stop <运行号>        取消一个运行',
    '  /workflow reload              重新扫描工作流目录',
    '',
    '两种发起的区别：',
    '  · 一句话  → 模型现场设计拓扑并写脚本，适合一次性的编排；',
    '  · 已保存名 → 直接跑你写好的那份，每次都一样，适合每周都要跑的固定流程。',
    '',
    `工作流放在 ${userWorkflowRoot()}`,
  ].join('\n')

  /**
   * 把一段提示词作为**普通用户消息**注入会话，让模型开始工作。
   *
   * 这是 ZCode `/workflow [提示词]` 的语义：命令本身不跑工作流，而是把任务交给模型，
   * 由模型设计拓扑、写脚本、再调用 `workflow` 工具启动。
   *
   * 走官方 `sessionController.prompt()` —— 它做完整准入（空内容、附件、忙闲、时区），
   * 内部落到 `agent.followup(message)`。比自己拼一个 UserMessage 塞进 inbox 安全得多：
   * 那条路要绕过全部准入检查，而准入检查里的每一条都是踩过坑才加的。
   *
   * ## 注入的是**用户的原话**，一个字都不改
   *
   * 早期版本往这里塞了一段「先想拓扑、再用 wfRun 声明结构……」的模板。那是错的：
   * 那属于**我该怎么干活**的说明，它该待在系统提示词里（见 WORKFLOW_SECTION），
   * 而不是伪装成用户说过的话。用户发什么，模型就该看到什么 —— 解读与分工发生在
   * 模型的思考里，不发生在消息内容的改写里。
   *
   * ## 第二个参数 `signal` 不是可选的
   *
   * `SessionController.prompt(request, signal)` 会**无条件**调 `signal.throwIfAborted()`
   * （源码里那句没有前置判断，文档注释也写着 `@param signal`）。只传 request 的后果是
   * `Cannot read properties of undefined (reading 'throwIfAborted')` ——
   * 一个从错误信息完全看不出「少传了个参数」的报错。（实测踩到。）
   *
   * 官方客户端也是这么调的：`this.remote.session.prompt({ … }, signal)`。
   *
   * @param {string} sessionId 目标会话
   * @param {string} text 用户的原话（逐字，不加工）
   * @param {AbortSignal} [signal] 命令那次 UI 请求的 signal；缺省时给一个永不中止的
   */
  async function injectPrompt(sessionId, text, signal) {
    const controller = service('sessionController')
    if (controller === null || typeof controller.prompt !== 'function') {
      throw new Error('当前组合里没有 sessionController，无法把任务交给模型')
    }
    const abortSignal =
      signal !== null && signal !== undefined && typeof signal.throwIfAborted === 'function'
        ? signal
        : new AbortController().signal
    await controller.prompt(
      {
        sessionId: String(sessionId),
        requestId: `workflow-studio:${String(Date.now())}:${Math.random().toString(36).slice(2, 10)}`,
        content: [{ type: 'text', text }],
        mode: 'queue',
      },
      abortSignal,
    )
  }

  /**
   * 系统提示词里那一段：**「怎么做」的全部说明都在这儿**。
   *
   * 内容是三件事，都刻意不写进用户消息：
   *   1. 收到编排请求时，拓扑要在思考里定下来，不要当成铺垫写进回复；
   *   2. 脚本用 `wfRun` / `phase` 声明结构，工作台才画得出图；
   *   3. **默认 `run_in_background: true`** —— 前台调用会占住整轮，
   *      用户在它跑完之前打不了字。工作流本来就是后台跑的东西。
   */
  const WORKFLOW_SECTION = [
    '用户可以用 `/workflow <任务>` 直接要求你把一件事编排成工作流交给多个子智能体去做。',
    '',
    '收到这类请求时：',
    '- 先在**思考里**把拓扑定下来：要几个子智能体、哪些该并行、谁依赖谁、每个各自返回什么。',
    '  这段推导不要当成开场白写进回复 —— 用户要的是结果，不是你的设计过程。',
    '- 然后用 `workflow` 工具启动它。脚本里用 `wfRun(id, spec, prompt)` 声明节点与依赖、',
    '  `phase(title)` 推进阶段，这样「工作流工作台」里才画得出结构图。',
    '- **默认加 `run_in_background: true`。** 前台调用会占住整轮，用户在它跑完之前没法继续对话；',
    '  工作流本来就是后台跑的东西，进度在输入框上方的常驻条里看。只有用户明确说「等我看到结果」时才前台跑。',
    '- 不要用普通 subagent 调用替代 —— 那退化成一次次串行委派，失去了扇出的意义。',
  ].join('\n')

  function renderLibrary() {
    const { items, invalid } = listWorkflows()
    const lines = []
    if (items.length === 0) {
      lines.push(
        `还没有任何工作流。在 ${userWorkflowRoot()} 里放一个 .js 文件即可（YAML frontmatter + 脚本正文）。`,
      )
    } else {
      lines.push(`可用工作流（${String(items.length)}）：`)
      for (const item of items) {
        lines.push(`  ${item.meta.name}${item.origin === 'bundled' ? '［随包］' : ''} —— ${item.meta.description}`)
      }
    }
    const runs = registry.listRuns().slice(0, 6)
    if (runs.length > 0) {
      lines.push('', `最近的运行（${String(runs.length)}）：`)
      for (const run of runs) {
        const when = new Date(run.startedAt).toLocaleTimeString()
        lines.push(
          `  ${run.id.slice(0, 8)} ${run.name} · ${run.status}${run.currentPhase === null ? '' : ` · ${run.currentPhase}`} · ${String(run.agentsStarted)} 个子智能体 · ${when}`,
        )
      }
    }
    if (invalid.length > 0) {
      lines.push('', `被忽略的文件（${String(invalid.length)}）：`)
      for (const item of invalid) lines.push(`  ${item.path} —— ${item.reason}`)
    }
    return lines.join('\n')
  }

  function renderRun(runId) {
    const target = runId === undefined ? registry.listRuns()[0]?.id : runId
    if (target === undefined) return '还没有任何运行记录。'
    const run = registry.getRun(target, { includeContent: false })
    if (run === null) return `找不到运行 ${String(target)}。`
    const lines = [
      `${run.name}（${run.id}）`,
      run.description,
      `状态：${run.status}${run.error === null ? '' : ` —— ${run.error}`}`,
      `子智能体：${String(run.agentsStarted)} 个，用时 ${String(Math.round(Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt) / 1000))}s`,
      '',
    ]
    if (run.nodes.length === 0) {
      lines.push('（还没有子智能体启动）')
    } else {
      const byPhase = new Map()
      for (const node of run.nodes) {
        const key = node.phase ?? '(未分阶段)'
        const list = byPhase.get(key) ?? []
        list.push(node)
        byPhase.set(key, list)
      }
      for (const [phase, list] of byPhase) {
        lines.push(`▸ ${phase}`)
        for (const node of list) {
          const mark =
            node.status === 'completed' ? '✓' : node.status === 'running' ? '…' : node.status === 'cancelled' ? '⊘' : '✗'
          lines.push(`   ${mark} #${String(node.seq)} ${node.label}${node.model === null ? '' : ` [${node.model}]`}`)
        }
      }
    }
    lines.push('', '完整内容（每个子智能体的正文、工具调用、结构图）在「工作流工作台」面板里看。')
    return lines.join('\n')
  }

  async function handleCommand(invocation) {
    const raw = String(invocation.rawInput ?? '').trim()
    if (raw === '' || raw === 'list' || raw === 'ls') {
      return { kind: 'success', text: renderLibrary() }
    }
    const [head, ...rest] = raw.split(/\s+/)

    if (head === 'help' || head === '-h' || head === '--help') {
      return { kind: 'success', text: USAGE }
    }
    if (head === 'reload') {
      const { items } = listWorkflows()
      return { kind: 'success', text: `已重新扫描，当前 ${String(items.length)} 个工作流。` }
    }
    if (head === 'show') {
      return { kind: 'success', text: renderRun(rest[0]) }
    }
    if (head === 'stop') {
      const target = rest[0]
      if (target === undefined) return { kind: 'error', text: '要停哪个？用法：/workflow stop <运行号>' }
      const run = registry.getRun(target, { includeContent: false })
      if (run === null) return { kind: 'error', text: `找不到运行 ${target}` }
      const controller = controllers.get(run.id)
      if (controller === undefined) {
        return { kind: 'error', text: `运行 ${run.id.slice(0, 8)} 已经结算或不是本插件启动的，无法从这里取消。` }
      }
      controller.abort('用户从 /workflow stop 取消')
      return { kind: 'success', text: `已请求取消运行 ${run.id.slice(0, 8)}（${run.name}）。` }
    }

    /*
     * 分支规则：第一个词能对上**已保存的工作流名**就直接跑；否则整段当作提示词，
     * 交给模型去设计并启动 —— 这是 ZCode `/workflow [提示词]` 的语义。
     *
     * 用「先看名字是否合法、再看是否存在」两步判断，而不是直接 try：
     * `readWorkflow('帮我审一下代码')` 会抛「名字不合法」，那不是错误，
     * 那只是用户在说一句人话。
     */
    const forcedPrompt = head === 'prompt'
    const candidate = forcedPrompt ? undefined : head
    let definition = null
    if (typeof candidate === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(candidate)) {
      try {
        definition = readWorkflow(candidate)
      } catch {
        definition = null
      }
    }

    if (definition === null) {
      const request = (forcedPrompt ? rest.join(' ') : raw).trim()
      if (request === '') {
        return { kind: 'error', text: `要做什么？直接写一句话就行：/workflow <任务描述>\n\n${USAGE}` }
      }
      try {
        /*
         * 注入用户的原话，一个字都不加。
         * 「收到编排请求该怎么做」写在 WORKFLOW_SECTION 里，由系统提示词承担 ——
         * 解读与分工发生在模型的思考里，不发生在消息内容的改写里。
         */
        await injectPrompt(invocation.agent?.id, request, invocation.signal)
      } catch (error) {
        return { kind: 'error', text: `交给模型失败：${String(error?.message ?? error)}` }
      }
      /*
       * **成功时不回任何文字。**
       *
       * 注入进去的那句话本身就是全部反馈 —— 它会作为一条普通用户消息出现在对话里，
       * 模型接着就开工。再补一句「已把这句话原样交给模型：它会自己在思考里定拓扑……」
       * 只是把同一件事用更长的话说第二遍，还占了对话的地方。
       * 错误路径保留文字（那里是真的需要说明）。
       */
      return { kind: 'success' }
    }

    // 命中已保存的工作流：直接跑，参数按 JSON 解析
    const jsonPart = rest.join(' ').trim()
    let args
    if (jsonPart !== '') {
      try {
        args = JSON.parse(jsonPart)
      } catch (error) {
        return { kind: 'error', text: `参数不是合法 JSON：${String(error?.message ?? error)}` }
      }
    }
    try {
      const started = startRun({
        meta: definition.meta,
        script: definition.script,
        graph: definition.graph,
        args,
        parent: invocation.agent,
        parentSessionId: invocation.agent?.id ?? null,
      })
      return {
        kind: 'success',
        /* 只留「什么在跑、怎么停」。描述与用法都在别处，这里不重复。 */
        text: `${started.name} 已启动（${started.runId.slice(0, 8)}）　停止：/workflow stop ${started.runId.slice(0, 8)}`,
      }
    } catch (error) {
      return { kind: 'error', text: `启动失败：${String(error?.message ?? error)}` }
    }
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: 'workflow',
      /*
       * 描述是**给人看的一句话**，不是实现说明。
       * 早先写的是「把一件事交给多个子智能体并行去做：先定拓扑，再用 workflow 工具在后台启动」——
       * 前半句有用，后半句（先定拓扑、用哪个工具、前台还是后台）是实现细节，
       * 对点这个命令的人没有任何帮助。菜单里每行就那么点地方，只留有用的那半句。
       */
      description: '把一件事拆给多个子智能体并行去做',
      /*
       * ## `input` 不是「提示文案」，是「这个命令接受参数」的开关
       *
       * 客户端里 `desc.input !== void 0` 决定这个命令**认不认领输入行**：
       *   - 有 `input` → 从菜单选中后进入参数输入态（`/goal` 就是这种），
       *     提交时 `line + args` 一起给到 execute；
       *   - 没有 `input` → 它是「立即执行」型（`/compact` 那种）：选中或按 Tab 就直接发出去，
       *     参数永远是空串，用户接着打的那整行只能当普通消息发走。
       *
       * 我一度把它整个删掉（嫌那串用法说明糊在输入框上），结果把参数入口一起删了。
       * 实测症状两条：`command/run` 的 args 全是空串；按 Tab 直接发送而不是补全。
       * 宿主还硬性要求 hint 非空（`input hint must not be empty`），所以「留白」也不是选项。
       *
       * 结论：`input` 必须留着。hint 按官方风格写紧凑一点（对照 `/goal` 的
       * `[<objective>|clear|edit <objective>|pause|resume]`），只交代有哪两种写法。
       */
      /*
       * hint 是参数框里的那段提示。写成**人话**，不写符号语法。
       * `input` 本身是「本命令接受参数」的开关（见下），这个字符串只是它的文案 ——
       * 早先写的 `<一句话>|<名称> [JSON]` 是在把内部语法摊给用户看，
       * 而用户真正需要知道的只有一件事：这儿可以填什么。
       */
      input: { hint: '要做什么，或已有工作流的名字' },
      handler: handleCommand,
    }),
  )

  /*
   * 系统提示词那一段：把「收到编排请求该怎么做」放在这里，而不是塞进用户消息。
   * 没有 systemPrompt 服务时静默跳过 —— 命令与面板照常工作，只是模型少了这条指引。
   */
  ctx.effect(() => {
    const prompt = service('systemPrompt')
    if (prompt === null || typeof prompt.section !== 'function') return () => {}
    let order = 500
    try {
      order = prompt.getSectionOrder('TOOL_WORKFLOW')
    } catch {
      // 拿不到官方顺序就落一个中间值，不必较真
    }
    return prompt.section({ name: 'workflow-studio', order, text: WORKFLOW_SECTION })
  })

  //#endregion

  //#region HTTP 路由

  const libraryView = () => {
    const { items, invalid, userRoot, bundledRoot } = listWorkflows()
    return {
      items: items.map((item) => ({
        name: item.meta.name,
        description: item.meta.description,
        whenToUse: item.meta.whenToUse ?? null,
        phases: item.meta.phases ?? [],
        origin: item.origin,
        path: item.path,
        bytes: item.bytes,
      })),
      invalid,
      userRoot,
      bundledRoot,
    }
  }

  const routes = {
    'GET /info': () => {
      /*
       * 引擎可能在根上下文，也可能在某个 agent preset 的组合里（见 engineFor 的说明）。
       * 这里把两种情况分开报，界面与排障脚本才能区分「没装」与「装在别处」。
       */
      const agents = service('agents')
      let sampleAgent = null
      try {
        sampleAgent = agents?.roots?.()[0] ?? null
      } catch {
        sampleAgent = null
      }
      const resolved = resolveEngine(sampleAgent)
      return {
        plugin: PLUGIN_ID,
        version: '0.1.0',
        profile: PROFILE_NAME,
        runtimeDir: RUNTIME_DIR,
        dshHome: dataDir(),
        workflowRoot: userWorkflowRoot(),
        hasEngine: engine() !== null,
        hasEngineForAgent: sampleAgent === null ? null : resolved.engine !== null,
        /* 引擎是从哪条路解析到的 —— 排障时这一个字段就能定位「为什么启动不了工作流」 */
        engineVia: resolved.via,
        agentCount: (() => {
          try {
            return agents?.list?.().length ?? 0
          } catch {
            return 0
          }
        })(),
        running: controllers.size,
        platform: process.platform,
      }
    },

    /** 一次轮询拿全：增量事件 + 运行列表 + 工作流库。界面主循环只用这一条。 */
    'GET /state': ({ query }) => {
      const since = Number.parseInt(query.get('since') ?? '0', 10)
      return {
        ...drain(Number.isNaN(since) ? 0 : since),
        runs: registry.listRuns(),
        library: libraryView(),
      }
    },

    'GET /events': ({ query }) => {
      const since = Number.parseInt(query.get('since') ?? '0', 10)
      return drain(Number.isNaN(since) ? 0 : since)
    },

    'GET /run': ({ query }) => {
      const id = query.get('id') ?? ''
      const run = registry.getRun(id, { includeContent: query.get('content') !== '0' })
      if (run === null) throw new Error(`找不到运行 ${id}`)
      return {
        ...run,
        /* 优先用运行自己记的（从子会话 header 推的，工具起的运行也有），再回落到启动时记的 */
        parentSessionId: run.parentSessionId ?? parents.get(run.id) ?? null,
        canCancel: controllers.has(run.id),
      }
    },

    'GET /node': ({ query }) => {
      const node = registry.getNodeContent(query.get('run') ?? '', Number.parseInt(query.get('seq') ?? '0', 10))
      if (node === null) throw new Error(`找不到节点 ${query.get('run') ?? ''}#${query.get('seq') ?? ''}`)
      return node
    },

    /*
     * 引擎可见性自检。
     *
     * 这个路由存在的理由：官方组合里 `workflow-ptc` / `tool-workflow` 这两行在**根上下文是
     * disabled 的**（`plugin_manager` 里能看到 `enabled:false, fiberPhase:null`），它们随
     * agent preset 挂载。所以「插件装好了但 /workflow 说找不到引擎」是一个真实可能的状态，
     * 而它的原因不在插件里 —— 这一条路由把「引擎从哪条路解析到、每个活跃会话各自解析到没有」
     * 直接摆出来，省掉一轮猜。
     */
    'GET /diagnose': () => {
      const agents = service('agents')
      let list = []
      try {
        list = agents?.list?.() ?? []
      } catch {
        list = []
      }
      return {
        engineViaRoot: engine() === null ? null : 'root',
        agentPresetsAvailable: service('agentPresets') !== null,
        /*
         * `/workflow <提示词>` 靠它把任务注入会话（走官方 prompt 准入，落到 agent.followup）。
         * 单独报出来：这条不通时，「交给模型」那条路会失败，而 `/workflow <已保存名>`
         * 仍然照常工作 —— 症状很容易被误读成「插件坏了」。
         */
        sessionControllerAvailable: (() => {
          try {
            return typeof service('sessionController')?.prompt === 'function'
          } catch {
            return false
          }
        })(),
        /*
         * `/workflow` 这个名字**现在**在命令注册表里能不能查到。
         *
         * 单独报出来的理由：菜单里看得到 `/workflow` 只证明 `commands.list` 认得它；
         * 而「输入框里敲 `/workflow ...` 提交后到底走不走命令」取决于客户端提交时的匹配。
         * 这两件事会分叉 —— 实测遇到过「菜单里有、提交后却当普通文本发出去」。
         * 有了这个字段就能把「宿主没注册」与「客户端没匹配上」当场分开。
         */
        commandRegistered: (() => {
          const commands = service('commands')
          if (commands === null || typeof commands.find !== 'function') return null
          if (list.length === 0) return null
          try {
            return commands.find(list[0], 'workflow') !== undefined
          } catch {
            return null
          }
        })(),
        agents: list.map((agent) => {
          const resolved = resolveEngine(agent)
          return {
            sessionId: String(agent?.id ?? ''),
            via: resolved.via,
            hasEngine: resolved.engine !== null,
          }
        }),
        workflowRoot: userWorkflowRoot(),
        running: [...controllers.keys()],
      }
    },

    'GET /library': () => libraryView(),

    'GET /library/item': ({ query }) => {
      const item = readWorkflow(query.get('name') ?? '')
      return { name: item.meta.name, meta: item.meta, graph: item.graph, script: item.script, origin: item.origin, path: item.path }
    },

    'POST /library/save': ({ body }) => {
      const saved = writeWorkflow(String(body?.name ?? ''), {
        meta: body?.meta ?? {},
        script: String(body?.script ?? ''),
      })
      log(`已保存工作流 ${saved.meta.name} → ${saved.path}`)
      return saved
    },

    'POST /library/delete': ({ body }) => {
      const removed = deleteWorkflow(String(body?.name ?? ''))
      log(`已删除工作流 ${String(body?.name ?? '')}`)
      return removed
    },

    'POST /run': ({ body }) => {
      const definition = readWorkflow(String(body?.name ?? ''))
      const agents = service('agents')
      /*
       * 从界面调起时没有「发起命令的 agent」，引擎却必须要一个 parent。
       * 优先用界面给的会话；否则退到任一活跃 agent —— 引擎只用它来定位子智能体的归属。
       */
      const requested = body?.parentSessionId === undefined ? null : agents?.get?.(String(body.parentSessionId))
      const parent = requested ?? agents?.roots?.()[0] ?? null
      if (parent === null) throw new Error('宿主里没有活跃的 agent，无法启动工作流（先开一个会话）')
      return startRun({
        meta: definition.meta,
        script: definition.script,
        graph: definition.graph,
        args: body?.args === undefined ? undefined : body.args,
        parent,
        parentSessionId: parent?.id ?? null,
      })
    },

    'POST /cancel': ({ body }) => {
      const id = String(body?.runId ?? '')
      const controller = controllers.get(id)
      if (controller === undefined) throw new Error(`运行 ${id} 不在运行中，或不是本插件启动的`)
      controller.abort('用户从工作台取消')
      return { runId: id, cancelled: true }
    },

    'POST /forget': ({ body }) => {
      const id = String(body?.runId ?? '')
      return { runId: id, forgotten: registry.forget(id) }
    },

    'GET /logs': ({ query }) => {
      const limit = Number.parseInt(query.get('limit') ?? '300', 10)
      return { lines: readLines({ limit: Number.isNaN(limit) ? 300 : limit }) }
    },
  }

  const router = createRouter({ ctx, prefix: PREFIX, id: PLUGIN_ID, log, routes })

  //#endregion

  ctx.effect(() => router.dispose)
  ctx.effect(() => () => {
    for (const controller of controllers.values()) controller.abort('插件卸载')
    controllers.clear()
    recordSessions.clear()
  })

  log(
    `已就绪（profile=${PROFILE_NAME}，工作流目录=${userWorkflowRoot()}，引擎=${engine() === null ? '不在根上下文（启动时按 agent preset 解析）' : '根上下文可用'}）`,
  )
}
