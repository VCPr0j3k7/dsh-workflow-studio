/**
 * 工作流运行登记处：把引擎的 `workflow/*` 事件与子智能体会话的 `session/event`
 * 折叠成一份「可视图」，供客户端半边渲染。
 *
 * ## 数据从哪来
 *
 * 两条官方事件流，都是全树广播的，因此**无论工作流是模型用 `workflow` 工具起的，
 * 还是人用 `/workflow` 起的**，本插件都看得见：
 *
 *   1. `workflow/start | phase | log | agent-start | agent-end | end`
 *      —— 运行的身份、阶段、叙述、子智能体的启停。
 *   2. `session/event` —— 每个子智能体**自己的**会话日志（正文、推理、工具调用、工具结果）。
 *      `workflow/agent-start` 给出的 `childId` 就是它的 SessionId，两条流靠它对接。
 *
 * 第 2 条是「展示各子智能体工作内容」的全部秘密：官方 UI 只画了「谁在跑、跑完没有」，
 * 因为那只需要第 1 条；要把**内容**显示出来，就必须订阅子会话自己的日志。
 *
 * ## 结构关系从哪来
 *
 * 引擎的事件里**没有** agent 之间的依赖关系（`WorkflowAgentInfo` 只有 seq/label/phase/childId）。
 * 因此本插件提供三个层次的答案，优先级从高到低：
 *
 *   1. **声明式**：脚本用 `wfNode(id, { deps })` / `wfEdge()` 显式声明（见 `host/script.mjs`）。
 *   2. **阶段归属**：`phase` 字段给出的分组（官方也用它）。
 *   3. **时序推断**：同一阶段内，执行区间重叠的判为并行，前一个结束后才开始的判为串行依赖。
 *      推断出来的边会打上 `inferred: true`，界面上用虚线画 —— 不把推断当事实。
 */
import { STRUCTURE_PREFIX } from './script.mjs'

/** 每个节点的正文上限。超过就丢最早的，保留一条截断标记。 */
const MAX_TRANSCRIPT_ENTRIES = 500
/** 单个文本块的字符上限（工具结果可能极大）。 */
const MAX_BLOCK_CHARS = 6000
/** 保留的运行数。 */
const MAX_RUNS = 60

function now() {
  return Date.now()
}

function clampText(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= MAX_BLOCK_CHARS) return value
  return `${value.slice(0, MAX_BLOCK_CHARS)}\n…（已截断 ${String(value.length - MAX_BLOCK_CHARS)} 字）`
}

/** 从一条消息里抽出可展示的内容块。官方 ContentBlock 是判别联合，这里只认已知类型。 */
function blocksOf(message) {
  if (message === null || typeof message !== 'object') return []
  const content = Array.isArray(message.content) ? message.content : []
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        out.push({ kind: 'text', text: clampText(block.text) })
        break
      case 'reasoning':
        out.push({ kind: 'reasoning', text: clampText(block.text) })
        break
      case 'tool-call':
        out.push({ kind: 'tool-call', name: String(block.name ?? '?'), args: clampText(block.arguments) })
        break
      case 'image':
        out.push({ kind: 'image', text: '[图片]' })
        break
      case 'file':
        out.push({ kind: 'file', text: `[文件 ${String(block.attachment?.name ?? '')}]` })
        break
      default:
        break
    }
  }
  return out
}

/** 一条消息的纯文本投影（用于列表摘要）。 */
function textOf(blocks) {
  return blocks
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function createNode(info, agent) {
  return {
    seq: agent.seq,
    label: agent.label,
    phase: typeof agent.phase === 'string' ? agent.phase : null,
    childId: String(agent.childId),
    status: 'running',
    outcome: null,
    startedAt: now(),
    endedAt: null,
    declaredId: null,
    deps: [],
    detail: null,
    provider: null,
    model: null,
    transcript: [],
    bytes: 0,
    lastText: '',
  }
}

function pushEntry(node, entry) {
  node.transcript.push({ time: now(), ...entry })
  if (typeof entry.text === 'string') node.bytes += entry.text.length
  if (node.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
    const dropped = node.transcript.splice(0, node.transcript.length - MAX_TRANSCRIPT_ENTRIES)
    for (const item of dropped) if (typeof item.text === 'string') node.bytes -= item.text.length
    node.transcript.unshift({ time: now(), kind: 'notice', text: '（更早的内容已因长度上限被丢弃）' })
  }
}

/**
 * 建运行登记处。
 *
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx 宿主上下文
 * @param {(payload: any) => void} options.emit 推给客户端的事件出口
 * @param {(message: string) => void} options.log 日志
 */
export function createRunRegistry({ ctx, emit, log }) {
  /** runId -> run */
  const runs = new Map()
  /** childId -> runId，把子会话的事件路由回它所属的运行 */
  const childToRun = new Map()

  function touch(run, payload) {
    emit({ type: 'run', runId: run.id, revision: run.revision, ...payload })
  }

  function bump(run) {
    run.revision += 1
  }

  function runOf(runId) {
    return runs.get(String(runId)) ?? null
  }

  function trimRuns() {
    if (runs.size <= MAX_RUNS) return
    const ordered = [...runs.values()].sort((left, right) => left.startedAt - right.startedAt)
    for (const run of ordered.slice(0, runs.size - MAX_RUNS)) {
      if (run.status === 'running') continue
      for (const node of run.nodes) childToRun.delete(node.childId)
      runs.delete(run.id)
    }
  }

  //#region 声明式结构

  /** 处理脚本通过 `log()` 发上来的结构声明。返回 true 表示这条日志已被消费。 */
  function consumeStructure(run, message) {
    if (message.startsWith(STRUCTURE_PREFIX) === false) return false
    let payload = null
    try {
      payload = JSON.parse(message.slice(STRUCTURE_PREFIX.length))
    } catch {
      return true
    }
    if (payload === null || typeof payload !== 'object') return true
    switch (payload.t) {
      case 'graph': {
        run.declaredGraph = payload.graph ?? null
        /*
         * 静态结构（frontmatter 里的 `graph`）与动态声明走同一条绑定通道：
         * 它同样提供 id / label / phase / deps，因此脚本里即使一个 `wfNode` 都不写，
         * 只要 frontmatter 声明过结构，实例也能绑上去。
         *
         * 两种写法都收：节点数组，或 `{ nodes: [...], edges: [...] }`。
         */
        const graph = payload.graph
        const nodes = Array.isArray(graph) ? graph : Array.isArray(graph?.nodes) ? graph.nodes : []
        for (const entry of nodes) {
          if (entry === null || typeof entry !== 'object') continue
          const id = String(entry.id ?? '')
          if (id === '' || run.declaredNodes.has(id)) continue
          run.declaredNodes.set(id, {
            id,
            label: typeof entry.label === 'string' ? entry.label : null,
            phase: typeof entry.phase === 'string' ? entry.phase : null,
            deps: Array.isArray(entry.deps) ? entry.deps.map(String) : [],
            group: typeof entry.group === 'string' ? entry.group : null,
            kind: typeof entry.kind === 'string' ? entry.kind : null,
            detail: typeof entry.detail === 'string' ? entry.detail : null,
          })
          for (const dep of Array.isArray(entry.deps) ? entry.deps : []) {
            run.edges.push({ from: String(dep), to: id, kind: 'declared', inferred: false })
          }
        }
        if (Array.isArray(graph?.edges)) {
          for (const edge of graph.edges) {
            if (edge === null || typeof edge !== 'object') continue
            run.edges.push({
              from: String(edge.from ?? ''),
              to: String(edge.to ?? ''),
              kind: typeof edge.kind === 'string' ? edge.kind : 'flow',
              inferred: false,
            })
          }
        }
        for (const node of run.nodes) {
          if (node.declaredId === null) bindDeclaration(run, node)
        }
        /* 声明一到就重算一次：把此前推出来的时序虚线立刻清掉，不等下一次 agent 事件 */
        inferEdges(run)
        bump(run)
        touch(run, { kind: 'graph' })
        return true
      }
      case 'node': {
        const id = String(payload.id ?? '')
        if (id === '') return true
        const spec = {
          id,
          label: typeof payload.label === 'string' ? payload.label : null,
          phase: typeof payload.phase === 'string' ? payload.phase : null,
          deps: Array.isArray(payload.deps) ? payload.deps.map(String) : [],
          group: typeof payload.group === 'string' ? payload.group : null,
          kind: typeof payload.kind === 'string' ? payload.kind : null,
          detail: typeof payload.detail === 'string' ? payload.detail : null,
        }
        if (run.declaredNodes.has(id)) return true
        run.declaredNodes.set(id, spec)
        for (const dep of spec.deps) {
          run.edges.push({ from: dep, to: id, kind: 'declared', inferred: false })
        }
        /*
         * 声明可能晚于实例（`parallel()` 里脚本先声明再各自 await，但事件到达顺序不保证），
         * 因此每次新增声明都回头补绑一次已经启动、还没绑上的实例。
         */
        for (const node of run.nodes) {
          if (node.declaredId === null) bindDeclaration(run, node)
        }
        /* 声明一到就重算一次：把此前推出来的时序虚线立刻清掉，不等下一次 agent 事件 */
        inferEdges(run)
        bump(run)
        touch(run, { kind: 'graph' })
        return true
      }
      case 'edge': {
        run.edges.push({
          from: String(payload.from ?? ''),
          to: String(payload.to ?? ''),
          kind: typeof payload.kind === 'string' ? payload.kind : 'flow',
          inferred: false,
        })
        bump(run)
        touch(run, { kind: 'graph' })
        return true
      }
      case 'group': {
        run.groups.push({
          id: String(payload.id ?? ''),
          label: typeof payload.label === 'string' ? payload.label : null,
          kind: typeof payload.kind === 'string' ? payload.kind : 'group',
          nodes: Array.isArray(payload.nodes) ? payload.nodes.map(String) : [],
        })
        bump(run)
        touch(run, { kind: 'graph' })
        return true
      }
      default:
        return true
    }
  }

  /**
   * 把一个 agent 实例绑定到它所属的**逻辑节点**。
   *
   * 这是「结构关系」的关键一步：`pipeline(items, ...)` 会把同一个逻辑步骤跑 N 遍
   * （每个 item 一个子智能体），所以一个声明节点对应**多个**实例 —— 绑定是
   * 多对一的，不是一对一的。因此这里只按 (label, phase) 查找，不消费声明。
   *
   * 匹配优先级：
   *   1. label 与 phase 都相等 —— 最精确；
   *   2. 只有 label 相等 —— 作者通常只写 label，phase 由 `phase()` 动态推进；
   *   3. 都没命中就留空，界面按阶段归组显示（推断路径，见 inferEdges）。
   *
   * 之所以不用「声明顺序」兜底：`parallel()` 里谁先上报是不确定的，
   * 按顺序绑会在并发下随机错配，那比不绑更糟。
   */
  function bindDeclaration(run, node) {
    if (run.declaredNodes.size === 0) return
    const specs = [...run.declaredNodes.values()]
    const exact = specs.find(
      (spec) => spec.label !== null && spec.label === node.label && spec.phase !== null && spec.phase === node.phase,
    )
    const byLabel = exact ?? specs.find((spec) => spec.label !== null && spec.label === node.label)
    if (byLabel === undefined) return
    node.declaredId = byLabel.id
    node.deps = byLabel.deps
    node.detail = byLabel.detail
  }

  //#endregion

  //#region 时序推断

  /**
   * 同阶段内推断串行依赖：B 的开始时间晚于 A 的结束时间，且中间没有第三个节点，
   * 就认为 B 依赖 A。推断边一律标 `inferred: true`。
   *
   * 只在没有声明式结构时才做 —— 作者已经说清楚了，就不该再猜。
   *
   * ## 清理必须在早退**之前**
   *
   * `consumeStructure` 支持「脚本先跑、结构稍后才声明」的顺序（parallel 里第一个
   * agent-start 完全可能早于 `wfNode` 那条 log）。那种情况下早先推出来的 `seq:` 边
   * 已经写进了 `run.edges`，此时若因为「已经有声明了」直接 return，
   * 那些虚线就会**永远留在图里**，和作者声明的边长期共存 —— 正好违反「不再猜」的约定。
   *
   * 这个顺序错误在真实运行里不会报错、不会崩，只会让图多出几条不该有的线，
   * 所以它活过了好几轮自检，最后是被这个插件自己的工作流审出来的。
   */
  function inferEdges(run) {
    run.edges = run.edges.filter((edge) => edge.inferred !== true)
    if (run.declaredNodes.size > 0) return
    const byPhase = new Map()
    for (const node of run.nodes) {
      const key = node.phase ?? ''
      const list = byPhase.get(key) ?? []
      list.push(node)
      byPhase.set(key, list)
    }
    for (const list of byPhase.values()) {
      const ordered = [...list].sort((left, right) => left.startedAt - right.startedAt)
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]
        const current = ordered[index]
        /*
         * 只有「前一个彻底结束后才开始」才判为串行。
         *
         * 注意 current 不需要已经结束 —— 依赖边应该在 B **刚开始**时就画出来，
         * 否则用户在整个 B 的执行期间都看不到它从哪来。
         */
        if (previous.endedAt !== null && current.startedAt >= previous.endedAt) {
          run.edges.push({
            from: `seq:${String(previous.seq)}`,
            to: `seq:${String(current.seq)}`,
            kind: 'sequence',
            inferred: true,
          })
        }
      }
    }
  }

  //#endregion

  //#region 事件接线

  ctx.on('workflow/start', (info) => {
    const meta = info?.meta ?? {}
    const run = {
      id: String(info?.id ?? ''),
      name: typeof meta.name === 'string' ? meta.name : '(未命名)',
      description: typeof meta.description === 'string' ? meta.description : '',
      whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : null,
      phases: Array.isArray(meta.phases) ? meta.phases : [],
      declaredGraph: null,
      declaredNodes: new Map(),
      groups: [],
      edges: [],
      status: 'running',
      stopReason: null,
      error: null,
      agentsStarted: 0,
      startedAt: now(),
      endedAt: null,
      currentPhase: null,
      phaseHistory: [],
      log: [],
      nodes: [],
      revision: 1,
      parentSessionId: null,
    }
    runs.set(run.id, run)
    trimRuns()
    log(`运行开始：${run.name}（${run.id}）`)
    touch(run, { kind: 'start' })
  })

  ctx.on('workflow/phase', (info, title) => {
    const run = runOf(info?.id)
    if (run === null) return
    run.currentPhase = String(title)
    run.phaseHistory.push({ title: String(title), time: now() })
    run.log.push({ time: now(), kind: 'phase', text: String(title) })
    bump(run)
    touch(run, { kind: 'phase' })
  })

  ctx.on('workflow/log', (info, message) => {
    const run = runOf(info?.id)
    if (run === null) return
    if (consumeStructure(run, String(message))) return
    run.log.push({ time: now(), kind: 'log', text: String(message) })
    bump(run)
    touch(run, { kind: 'log' })
  })

  ctx.on('workflow/agent-start', (info, agent) => {
    const run = runOf(info?.id)
    if (run === null) return
    const node = createNode(info, agent)
    bindDeclaration(run, node)
    run.nodes.push(node)
    run.agentsStarted += 1
    childToRun.set(node.childId, run.id)
    inferEdges(run)
    bump(run)
    touch(run, { kind: 'agent-start', seq: node.seq })
  })

  ctx.on('workflow/agent-end', (info, agent) => {
    const run = runOf(info?.id)
    if (run === null) return
    const node = run.nodes.find((item) => item.seq === agent.seq)
    if (node === undefined) return
    node.outcome = String(agent.outcome)
    node.status = agent.outcome === 'completed' ? 'completed' : agent.outcome === 'cancelled' ? 'cancelled' : 'failed'
    node.endedAt = now()
    inferEdges(run)
    bump(run)
    touch(run, { kind: 'agent-end', seq: node.seq })
  })

  ctx.on('workflow/end', (info, result) => {
    const run = runOf(info?.id)
    if (run === null) return
    run.stopReason = String(result?.stopReason ?? 'error')
    run.status =
      run.stopReason === 'completed' ? 'completed' : run.stopReason === 'cancelled' ? 'cancelled' : 'failed'
    run.error = typeof result?.error === 'string' ? result.error : null
    if (typeof result?.agentsStarted === 'number') run.agentsStarted = result.agentsStarted
    run.endedAt = now()
    run.currentPhase = null
    for (const node of run.nodes) {
      if (node.status === 'running') {
        node.status = 'cancelled'
        node.outcome = 'cancelled'
        node.endedAt = run.endedAt
      }
    }
    inferEdges(run)
    bump(run)
    log(`运行结束：${run.name} → ${run.status}（${String(run.agentsStarted)} 个子智能体）`)
    touch(run, { kind: 'end' })
  })

  /**
   * 子智能体的工作内容。
   *
   * 这条监听挂在插件根上下文上（不是 agent 作用域），因此能看到**所有**会话的事件；
   * 用 `childToRun` 过滤，只留下属于某个工作流运行的子会话。
   */
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session?.id ?? '')
    const runId = childToRun.get(sessionId)
    if (runId === undefined) return
    const run = runs.get(runId)
    if (run === undefined) return
    const node = run.nodes.find((item) => item.childId === sessionId)
    if (node === undefined) return

    /*
     * 从子会话的 header 反推发起会话。
     *
     * 这是把「运行」归到「哪个会话发起的」的**唯一可靠来源**，而且对**所有**运行都成立 ——
     * 包括模型用 `workflow` 工具起的那些：那种情况我们拿不到命令的 `invocation.agent`，
     * 但每个子会话的 header 里都记着 `parentSession`。
     * 界面靠这个字段决定「这个运行该不该显示在当前会话的常驻面板里」。
     */
    if (run.parentSessionId === null) {
      const parent = session?.header?.parentSession
      if (typeof parent === 'string' && parent !== '') {
        run.parentSessionId = parent
        bump(run)
        touch(run, { kind: 'parent' })
      }
    }

    const type = String(event?.type ?? '')
    const data = event?.data ?? {}
    let dirty = false

    switch (type) {
      case 'user/message': {
        const blocks = blocksOf(data)
        const text = textOf(blocks)
        if (text !== '') {
          /*
           * 第一条 user/message 是**任务提示词**；之后到达的是宿主注入的运行时上下文
           * （「Current runtime context. …」）与会话中途的追加指令。两者都如实保留
           * ——它们确实进了子智能体的输入——但分开标类，界面上把后者画淡，
           * 免得每次点开一个子智能体先看到一屏模板文字。
           */
          const kind = node.prompt === undefined ? 'prompt' : 'context'
          pushEntry(node, { kind, text })
          if (kind === 'prompt') node.prompt = text
          dirty = true
        }
        break
      }
      case 'assistant/message': {
        for (const block of blocksOf(data.message)) {
          /*
           * **跳过 tool-call 块。** 同一个工具调用还会以专门的 `tool/call` 事件到达
           * （带 callId 与原始 arguments 字符串）。两处都收，界面上就会显示成
           * 「调用了一次，画了两条」—— 在真实运行里实测踩到过。
           * 保留 `tool/call` 那条：它的载荷更完整，而且与 `tool/result` 同源。
           */
          if (block.kind === 'tool-call') continue
          pushEntry(node, block)
          if (block.kind === 'text') node.lastText = block.text
        }
        dirty = true
        break
      }
      case 'tool/call': {
        pushEntry(node, {
          kind: 'tool-call',
          name: String(data.name ?? '?'),
          args: clampText(data.arguments),
          callId: String(data.callId ?? ''),
        })
        dirty = true
        break
      }
      case 'tool/result': {
        const blocks = blocksOf(data.message)
        pushEntry(node, {
          kind: 'tool-result',
          text: textOf(blocks),
          isError: data.message?.isError === true || data.error !== undefined,
          callId: String(data.message?.toolCallId ?? ''),
        })
        dirty = true
        break
      }
      case 'request/header': {
        const config = data.header?.config
        if (config !== undefined && config !== null) {
          node.provider = typeof config.provider === 'string' ? config.provider : node.provider
          node.model = typeof config.model === 'string' ? config.model : node.model
          dirty = true
        }
        break
      }
      default:
        break
    }

    if (dirty) {
      bump(run)
      touch(run, { kind: 'agent-content', seq: node.seq })
    }
  })

  //#endregion

  //#region 对外投影

  /** 列出运行（不含正文，供列表渲染）。 */
  function listRuns() {
    return [...runs.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((run) => ({
        id: run.id,
        name: run.name,
        description: run.description,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        agentsStarted: run.agentsStarted,
        currentPhase: run.currentPhase,
        revision: run.revision,
        nodeCount: run.nodes.length,
        /* 常驻面板靠它过滤出「属于当前会话」的运行 */
        parentSessionId: run.parentSessionId,
      }))
  }

  /** 一个运行的完整视图。`includeContent: false` 时省略各节点的正文。 */
  function getRun(runId, { includeContent = true } = {}) {
    const run = runOf(runId)
    if (run === null) return null
    return {
      id: run.id,
      name: run.name,
      description: run.description,
      whenToUse: run.whenToUse,
      phases: run.phases,
      declaredGraph: run.declaredGraph,
      declaredNodes: [...run.declaredNodes.values()],
      groups: run.groups,
      edges: run.edges,
      status: run.status,
      stopReason: run.stopReason,
      error: run.error,
      agentsStarted: run.agentsStarted,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      /*
       * 归属会话必须在**两个投影里都**给出。
       * 早期只有 listRuns() 带这个字段，getRun() 漏了 —— 于是 `/state` 有值、`/run` 没有，
       * 而 `/run` 的回退是 `parents.get()`（只覆盖插件自己启动的运行），
       * 结果是「工具起的运行在 /run 里看不到归属」。两个投影不一致本身就是 bug。
       */
      parentSessionId: run.parentSessionId,
      currentPhase: run.currentPhase,
      phaseHistory: run.phaseHistory,
      log: run.log.slice(-400),
      revision: run.revision,
      nodes: run.nodes.map((node) => ({
        seq: node.seq,
        label: node.label,
        phase: node.phase,
        childId: node.childId,
        status: node.status,
        outcome: node.outcome,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        declaredId: node.declaredId,
        deps: node.deps,
        detail: node.detail,
        provider: node.provider,
        model: node.model,
        prompt: node.prompt ?? null,
        lastText: node.lastText,
        bytes: node.bytes,
        entryCount: node.transcript.length,
        ...(includeContent ? { transcript: node.transcript } : {}),
      })),
    }
  }

  /** 单个子智能体的正文。界面点开一个节点时按需拉取。 */
  function getNodeContent(runId, seq) {
    const run = runOf(runId)
    if (run === null) return null
    const node = run.nodes.find((item) => item.seq === Number(seq))
    if (node === undefined) return null
    return {
      runId: run.id,
      seq: node.seq,
      label: node.label,
      phase: node.phase,
      childId: node.childId,
      status: node.status,
      provider: node.provider,
      model: node.model,
      prompt: node.prompt ?? null,
      transcript: node.transcript,
    }
  }

  function forget(runId) {
    const run = runOf(runId)
    if (run === null) return false
    for (const node of run.nodes) childToRun.delete(node.childId)
    runs.delete(run.id)
    return true
  }

  return { listRuns, getRun, getNodeContent, forget, runOf, count: () => runs.size }
}

//#endregion
