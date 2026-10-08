/**
 * 离线自检：不需要装进 profile，也不需要真的起一个宿主。
 *
 * 覆盖三件事：
 *   1. frontmatter 解析器（YAML 子集）在真实工作流文件上的行为；
 *   2. `composeScript` 组装出来的脚本里，结构钩子确实存在且能产出可解析的消息；
 *   3. 宿主半边在桩上下文里 `apply()` 不抛错、路由表挂上了、`/info` 契约正确、
 *      卸载路径不抛错。
 *
 * 客户端半边能不能在真窗口里跑只能真机验证 —— 但上面这三件事一旦错了，
 * 真机调试会非常痛苦（症状全是「界面里什么都没有」）。
 *
 * 用法：node test/check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let passed = 0
let failed = 0
/**
 * 跑一项检查。
 *
 * **异步的 fn 必须被 await** —— 这个自检早期版本直接调用 `fn()` 就宣告通过，
 * 于是一个 `async () => { await import('../index.js') }` 的检查即使在 import 阶段
 * 抛错也显示 ✓（拒绝的 promise 没人接）。真实后果：一个写错 import 的 index.js
 * 一路绿灯通过自检，装进 profile 后插件静默不装载。所以这里显式处理 thenable。
 */
function check(label, fn) {
  const settle = (error) => {
    if (error === null) {
      passed += 1
      console.log(`  ✓ ${label}`)
      return
    }
    failed += 1
    console.log(`  ✗ ${label}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`)
  }
  try {
    const value = fn()
    if (value !== null && typeof value?.then === 'function') return value.then(() => settle(null), settle)
    settle(null)
  } catch (error) {
    settle(error)
  }
  return undefined
}

console.log('dsh-workflow-studio 自检\n')

//#region 1. frontmatter 解析

const { parseMiniYaml, splitFrontmatter, normalizeMeta } = await import('../host/library.mjs')

console.log('frontmatter 解析')

check('标量、引号、布尔、数字', () => {
  const value = parseMiniYaml(['name: demo', 'count: 3', 'ratio: 0.5', 'on: true', 'off: false', 'quoted: "a: b"'].join('\n'))
  assert.equal(value.name, 'demo')
  assert.equal(value.count, 3)
  assert.equal(value.ratio, 0.5)
  assert.equal(value.on, true)
  assert.equal(value.off, false)
  assert.equal(value.quoted, 'a: b')
})

check('映射列表（phases 的写法）', () => {
  const value = parseMiniYaml(
    ['phases:', '  - title: 扫描', '    detail: 列清单', '  - title: 审计', '    model: glm-5.3'].join('\n'),
  )
  assert.deepEqual(value.phases, [
    { title: '扫描', detail: '列清单' },
    { title: '审计', model: 'glm-5.3' },
  ])
})

check('嵌套映射里的映射列表（graph 的写法）', () => {
  const value = parseMiniYaml(
    [
      'graph:',
      '  nodes:',
      '    - id: scan',
      '      label: 扫描',
      '      deps: [root]',
      '    - id: audit',
      '      label: 审计',
      '      deps: [scan]',
      '  edges:',
      '    - from: scan',
      '      to: audit',
    ].join('\n'),
  )
  assert.equal(value.graph.nodes.length, 2)
  assert.deepEqual(value.graph.nodes[0], { id: 'scan', label: '扫描', deps: ['root'] })
  assert.deepEqual(value.graph.edges, [{ from: 'scan', to: 'audit' }])
})

check('行内数组与行尾注释', () => {
  const value = parseMiniYaml(['deps: [a, b, c] # 这是注释', 'name: x # 也是'].join('\n'))
  assert.deepEqual(value.deps, ['a', 'b', 'c'])
  assert.equal(value.name, 'x')
})

check('引号里的 # 不是注释', () => {
  const value = parseMiniYaml('title: "a # b"')
  assert.equal(value.title, 'a # b')
})

check('块标量', () => {
  const value = parseMiniYaml(['whenToUse: |', '  第一行', '  第二行'].join('\n'))
  assert.equal(value.whenToUse, '第一行\n第二行')
})

check('制表符缩进要报错而不是静默解析错', () => {
  assert.throws(() => parseMiniYaml('a:\n\tb: 1'), /制表符/)
})

check('splitFrontmatter 分离元数据与正文', () => {
  const { meta, body } = splitFrontmatter('---\nname: x\ndescription: y\n---\nreturn 1\n')
  assert.equal(meta.name, 'x')
  assert.equal(body.trim(), 'return 1')
})

check('没有 frontmatter 时 meta 为 null', () => {
  const { meta, body } = splitFrontmatter('return 42')
  assert.equal(meta, null)
  assert.equal(body, 'return 42')
})

check('normalizeMeta 拒绝非法名字', () => {
  assert.throws(() => normalizeMeta({ name: 'Bad Name' }, 'x'), /不合法/)
  assert.throws(() => normalizeMeta({ name: '../escape' }, 'x'), /不合法/)
})

check('normalizeMeta 丢掉空的 phases 与非法阶段', () => {
  const { meta } = normalizeMeta({ name: 'ok', phases: [{ title: '' }, { detail: '没有 title' }, { title: 'A' }] }, 'x')
  assert.deepEqual(meta.phases, [{ title: 'A' }])
  const { meta: bare } = normalizeMeta({ name: 'ok', phases: [] }, 'x')
  assert.equal(bare.phases, undefined)
})

//#endregion

//#region 2. 随包工作流文件真的能被解析

console.log('\n随包工作流')

const { listWorkflows, readWorkflow } = await import('../host/library.mjs')

check('随包工作流全部可解析，且带结构声明', () => {
  const { items, invalid } = listWorkflows()
  assert.deepEqual(invalid, [], `有解析失败的文件：${JSON.stringify(invalid)}`)
  const bundled = items.filter((item) => item.origin === 'bundled')
  assert.ok(bundled.length >= 2, `随包工作流应至少 2 个，实际 ${String(bundled.length)}`)
  for (const item of bundled) {
    assert.ok(item.script.trim().length > 0, `${item.meta.name} 脚本为空`)
    assert.ok(Array.isArray(item.meta.phases), `${item.meta.name} 缺 phases`)
    assert.ok(item.graph !== null, `${item.meta.name} 缺 graph 结构声明`)
  }
})

check('readWorkflow 对不存在的名字给的是人话', () => {
  assert.throws(() => readWorkflow('definitely-not-there'), /找不到工作流/)
})

//#endregion

//#region 3. 脚本组装

console.log('\n脚本组装')

const { composeScript, isStructureMessage, STRUCTURE_PREFIX } = await import('../host/script.mjs')

check('前置代码里有全部结构钩子', () => {
  const script = composeScript({ script: 'return 1' })
  for (const hook of ['wfNode', 'wfEdge', 'wfGroup', 'wfRun', '__wfs_send']) {
    assert.ok(script.includes(`const ${hook}`) || script.includes(`${hook} =`), `缺少 ${hook}`)
  }
  assert.ok(script.trimEnd().endsWith('return 1'))
})

check('结构消息前缀可被识别', () => {
  assert.equal(isStructureMessage(`${STRUCTURE_PREFIX}{"t":"node"}`), true)
  assert.equal(isStructureMessage('普通叙述'), false)
})

check('前置代码在真实 JS 里语法正确（用 Function 编译）', () => {
  const script = composeScript({ script: 'return 1', graph: [{ id: 'a', label: 'A', deps: [] }] })
  // 只验语法：把官方注入的六个钩子都摆上，编译一次
  // eslint-disable-next-line no-new-func
  new Function('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', script)
})

check('graph 被序列化进脚本', () => {
  const script = composeScript({ script: 'return 1', graph: [{ id: 'a', label: 'A' }] })
  assert.ok(script.includes("__wfs_send({ t: 'graph'"), '应有一条发送静态结构的语句')
  assert.ok(script.includes('[{"id":"a","label":"A"}]'), '结构应被原样序列化')
})

//#endregion

//#region 4. 运行登记处的纯逻辑

console.log('\n运行登记处')

/** 造一个只记录监听的桩 ctx。 */
function stubCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    fire(name, ...args) {
      for (const handler of listeners.get(name) ?? []) handler(...args)
    },
    logger: { info() {}, warn() {} },
  }
}

const { createRunRegistry } = await import('../host/runs.mjs')

check('从事件流折叠出运行、阶段、子智能体与结构', () => {
  const ctx = stubCtx()
  const emitted = []
  const registry = createRunRegistry({ ctx, emit: (payload) => emitted.push(payload), log: () => {} })

  ctx.fire('workflow/start', { id: 'run-1', meta: { name: 'demo', description: '演示' } })
  ctx.fire('workflow/log', { id: 'run-1' }, `${STRUCTURE_PREFIX}${JSON.stringify({ t: 'graph', graph: [{ id: 'a', label: 'A', phase: 'P1', deps: [] }, { id: 'b', label: 'B', phase: 'P2', deps: ['a'] }] })}`)
  ctx.fire('workflow/phase', { id: 'run-1' }, 'P1')
  ctx.fire('workflow/agent-start', { id: 'run-1' }, { seq: 1, label: 'A', phase: 'P1', childId: 'child-1' })
  ctx.fire('session/event', { id: 'child-1' }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '你好' }] } })
  ctx.fire('session/event', { id: 'child-1' }, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '在做了' }] } } })
  ctx.fire('session/event', { id: 'child-1' }, { type: 'tool/call', data: { name: 'read', arguments: '{"path":"a.ts"}' } })
  ctx.fire('session/event', { id: 'child-1' }, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '内容' }] } } })
  ctx.fire('workflow/agent-end', { id: 'run-1' }, { seq: 1, label: 'A', phase: 'P1', childId: 'child-1', outcome: 'completed' })
  ctx.fire('workflow/end', { id: 'run-1' }, { stopReason: 'completed', agentsStarted: 1 })

  const run = registry.getRun('run-1')
  assert.equal(run.name, 'demo')
  assert.equal(run.status, 'completed')
  assert.equal(run.nodes.length, 1)
  assert.equal(run.nodes[0].declaredId, 'a', '实例应绑定到声明节点 a')
  assert.deepEqual(run.edges, [{ from: 'a', to: 'b', kind: 'declared', inferred: false }])
  assert.deepEqual(
    run.nodes[0].transcript.map((entry) => entry.kind),
    ['prompt', 'text', 'tool-call', 'tool-result'],
  )
  assert.equal(run.declaredNodes.length, 2)
  assert.ok(emitted.length > 0, '应向客户端发过事件')
})

check('同一个工具调用只记一条（assistant/message 的 tool-call 块与 tool/call 事件去重）', () => {
  const ctx = stubCtx()
  const registry = createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/start', { id: 'run-dedup', meta: { name: 'dedup', description: '' } })
  ctx.fire('workflow/agent-start', { id: 'run-dedup' }, { seq: 1, label: 'A', childId: 'cd' })
  // 同一个调用从两条路到达：assistant/message 里的 tool-call 块，和专门的 tool/call 事件。
  // 真实运行里踩到过：界面上显示成「调用了一次，画了两条」。
  ctx.fire('session/event', { id: 'cd' }, {
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '我读一下' },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' },
        ],
      },
    },
  })
  ctx.fire('session/event', { id: 'cd' }, { type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' } })
  ctx.fire('session/event', { id: 'cd' }, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '内容' }], toolCallId: 'c1' } } })

  const kinds = registry.getRun('run-dedup').nodes[0].transcript.map((entry) => entry.kind)
  assert.deepEqual(kinds, ['text', 'tool-call', 'tool-result'], `实际：${JSON.stringify(kinds)}`)
})

check('第一条 user/message 是提示词，之后的注入上下文单独标类', () => {
  const ctx = stubCtx()
  const registry = createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/start', { id: 'run-ctx', meta: { name: 'ctx', description: '' } })
  ctx.fire('workflow/agent-start', { id: 'run-ctx' }, { seq: 1, label: 'A', childId: 'cc' })
  ctx.fire('session/event', { id: 'cc' }, { type: 'user/message', data: { content: [{ type: 'text', text: '真正的任务' }] } })
  ctx.fire('session/event', { id: 'cc' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. …' }] } })

  const node = registry.getRun('run-ctx').nodes[0]
  assert.deepEqual(
    node.transcript.map((entry) => entry.kind),
    ['prompt', 'context'],
  )
  // 节点上记的 prompt 必须是真正的任务，不能被后来的注入上下文覆盖
  assert.equal(node.prompt, '真正的任务')
})

check('晚声明的结构会**立刻**清掉早先推出来的时序边', () => {
  const ctx = stubCtx()
  const registry = createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/start', { id: 'run-late', meta: { name: 'late', description: '' } })

  // 先跑两个串行的 agent：这会推出一条 seq:1 → seq:2 的虚线
  ctx.fire('workflow/agent-start', { id: 'run-late' }, { seq: 1, label: 'A', childId: 'l1' })
  ctx.fire('workflow/agent-end', { id: 'run-late' }, { seq: 1, label: 'A', childId: 'l1', outcome: 'completed' })
  ctx.fire('workflow/agent-start', { id: 'run-late' }, { seq: 2, label: 'B', childId: 'l2' })
  const before = registry.getRun('run-late').edges
  assert.equal(before.length, 1, '先应推出一条时序边')
  assert.equal(before[0].inferred, true)

  /*
   * 结构晚到 —— `parallel()` 里很常见：第一个 agent-start 完全可能早于 `wfNode` 那条 log。
   * 若清理写在早退之后，这条虚线会永远留着，和声明的边长期共存。
   */
  ctx.fire('workflow/log', { id: 'run-late' }, `${STRUCTURE_PREFIX}${JSON.stringify({ t: 'node', id: 'a', label: 'A', phase: 'P', deps: [] })}`)
  ctx.fire('workflow/log', { id: 'run-late' }, `${STRUCTURE_PREFIX}${JSON.stringify({ t: 'node', id: 'b', label: 'B', phase: 'P', deps: ['a'] })}`)

  const after = registry.getRun('run-late').edges
  assert.equal(
    after.some((edge) => edge.inferred === true),
    false,
    `声明到达后不该还有推断边，实际：${JSON.stringify(after)}`,
  )
  assert.equal(
    after.some((edge) => edge.from === 'a' && edge.to === 'b'),
    true,
    '声明的边应保留',
  )
})

check('归属会话在两个投影里都给出（listRuns 与 getRun 不能一个有一个没有）', () => {
  const ctx = stubCtx()
  const registry = createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/start', { id: 'run-parent', meta: { name: 'parent', description: '' } })
  ctx.fire('workflow/agent-start', { id: 'run-parent' }, { seq: 1, label: 'A', childId: 'cp' })
  // 归属是从**子会话的 header** 反推出来的，不是启动时记的
  ctx.fire('session/event', { id: 'cp', header: { parentSession: 'session-owner' } }, { type: 'user/message', data: { content: [] } })

  assert.equal(registry.listRuns()[0].parentSessionId, 'session-owner', 'listRuns 应带归属会话')
  assert.equal(
    registry.getRun('run-parent').parentSessionId,
    'session-owner',
    'getRun 也应带 —— 早期这里漏了，于是 /state 有值而 /run 没有',
  )
})

check('一个逻辑节点可以绑住多个实例（pipeline 扇出）', () => {
  const ctx = stubCtx()
  const registry = createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/start', { id: 'run-2', meta: { name: 'fanout', description: '' } })
  ctx.fire('workflow/log', { id: 'run-2' }, `${STRUCTURE_PREFIX}${JSON.stringify({ t: 'node', id: 'audit', label: '审计文件', phase: '审计', deps: [] })}`)
  for (const seq of [1, 2, 3]) {
    ctx.fire('workflow/agent-start', { id: 'run-2' }, { seq, label: '审计文件', phase: '审计', childId: `c${String(seq)}` })
  }
  const run = registry.getRun('run-2')
  assert.deepEqual(
    run.nodes.map((node) => node.declaredId),
    ['audit', 'audit', 'audit'],
  )
})

check('没有声明时用时序推断，且推断边被标记', () => {
  const ctx = stubCtx()
  const registry = createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/start', { id: 'run-3', meta: { name: 'seq', description: '' } })
  ctx.fire('workflow/agent-start', { id: 'run-3' }, { seq: 1, label: 'A', childId: 'c1' })
  ctx.fire('workflow/agent-end', { id: 'run-3' }, { seq: 1, label: 'A', childId: 'c1', outcome: 'completed' })
  ctx.fire('workflow/agent-start', { id: 'run-3' }, { seq: 2, label: 'B', childId: 'c2' })
  const run = registry.getRun('run-3')
  assert.equal(run.edges.length, 1)
  assert.equal(run.edges[0].inferred, true)
  assert.equal(run.edges[0].kind, 'sequence')
})

check('未知运行的事件被安静忽略（不抛）', () => {
  const ctx = stubCtx()
  createRunRegistry({ ctx, emit: () => {}, log: () => {} })
  ctx.fire('workflow/phase', { id: 'nope' }, 'P')
  ctx.fire('workflow/agent-start', { id: 'nope' }, { seq: 1, label: 'X', childId: 'c' })
  ctx.fire('session/event', { id: 'unknown-child' }, { type: 'assistant/message', data: {} })
})

//#endregion

//#region 5. 宿主半边在桩上下文里装载

console.log('\n宿主半边装载')

await check('apply() 不抛错、挂上前缀路由、/info 契约正确、卸载不抛错', async () => {
  /*
   * 宿主半边在模块加载期就读 process.argv，所以必须在 import 之前摆好。
   * 槽位：[0] exe [1] 入口 [2] runtimeDir [3] profileDir [4] primaryRuntime [5] pnpm [6] nodeBin
   */
  process.argv = [
    process.execPath,
    'stub-host-entry.js',
    'D:/stub/runtime',
    'D:/stub/profile',
    'D:/stub/primary',
    'D:/stub/pnpm.cjs',
    'D:/stub/node',
  ]

  const registered = []
  const effects = []
  const commands = []
  const listeners = new Map()
  /** `sessionController.prompt` 收到的调用，用来断言「交给模型」那条路真的注入了什么。 */
  const prompts = []
  /** 注册过的系统提示词段落 —— 「怎么做」的说明必须在这里，不能在用户消息里。 */
  const sections = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, handler) {
      const list = listeners.get(name) ?? []
      list.push(handler)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return () => disposer?.()
    },
    get(key) {
      if (key === 'workflowEngine') {
        return {
          start(request) {
            assert.ok(request.script.includes('wfRun'), '交给引擎的脚本应带结构前置代码')
            return {
              id: 'stub-run',
              meta: request.meta,
              result: Promise.resolve({ value: null, stopReason: 'completed', agentsStarted: 0 }),
              cancel() {},
              dispose: () => Promise.resolve(),
            }
          },
        }
      }
      if (key === 'agents') return { get: () => null, roots: () => [] }
      if (key === 'systemPrompt') {
        return {
          section(definition) {
            sections.push(definition)
            return () => {}
          },
          getSectionOrder() {
            return 100
          },
        }
      }
      if (key === 'sessionController') {
        return {
          /*
           * 照抄官方 `@Remote('prompt')` 装饰器后的真实契约：**第二个参数是必传的 signal**，
           * 而且它会被无条件调用 `throwIfAborted()`。少传就复现那条线上报错
           * `Cannot read properties of undefined (reading 'throwIfAborted')`。
           * 这个桩刻意不宽容 —— 宽容的桩会让这类错误溜到真机上。
           */
          async prompt(request, signal) {
            signal.throwIfAborted()
            prompts.push({ request, signal })
            return { accepted: true }
          },
        }
      }
      return null
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
  }

  const mod = await import('../index.js')
  assert.equal(mod.name, 'dsh-workflow-studio')
  assert.deepEqual(mod.inject, ['webServer', 'commands'])

  mod.apply(ctx)

  assert.equal(registered.length, 1, '应只注册一条前缀路由')
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/dsh-workflow-studio/api')

  assert.equal(commands.length, 1, '应注册 /workflow 命令')
  assert.equal(commands[0].name, 'workflow')
  assert.equal(typeof commands[0].handler, 'function')

  /** 用假 req/res 打一条路由。 */
  const call = async (method, url) => {
    let status = 0
    let body = ''
    const req = { method, url, async *[Symbol.asyncIterator]() {} }
    const res = {
      writeHead(code) {
        status = code
      },
      end(chunk) {
        body += chunk ?? ''
      },
    }
    await registered[0].handler(req, res)
    return { status, payload: JSON.parse(body) }
  }

  const info = await call('GET', '/dsh-workflow-studio/api/info')
  assert.equal(info.status, 200)
  assert.equal(info.payload.ok, true)
  assert.equal(info.payload.data.plugin, 'dsh-workflow-studio', '/info 的 plugin 必须是模块 id（客户端靠它认宿主）')
  assert.equal(info.payload.data.hasEngine, true)

  const state = await call('GET', '/dsh-workflow-studio/api/state?since=0')
  assert.equal(state.payload.ok, true)
  assert.ok(Array.isArray(state.payload.data.runs))
  assert.ok(Array.isArray(state.payload.data.library.items))

  const diagnose = await call('GET', '/dsh-workflow-studio/api/diagnose')
  assert.equal(diagnose.payload.ok, true)
  assert.ok(Array.isArray(diagnose.payload.data.agents), '/diagnose 应报出每个活跃会话的引擎解析路径')
  // 没有 commands 服务时值是 null —— 但字段本身必须在，否则排障时不知道该看哪
  assert.ok('commandRegistered' in diagnose.payload.data, '/diagnose 应报出 /workflow 是否注册在册')

  const missing = await call('GET', '/dsh-workflow-studio/api/nope')
  assert.equal(missing.status, 404, '未知路由应 404（而不是被 SPA 兜底吃成 200）')

  const badRun = await call('GET', '/dsh-workflow-studio/api/run?id=nope')
  assert.equal(badRun.payload.ok, false, '业务失败应是 200 + ok:false')
  assert.equal(badRun.status, 200)

  const commandResult = await commands[0].handler({ rawInput: '', agent: { id: 's1' }, signal: new AbortController().signal })
  assert.equal(commandResult.kind, 'success')
  assert.ok(commandResult.text.includes('工作流'))

  /*
   * `/workflow <一句人话>` —— 应该走「交给模型」那条路：把设计指令注入会话，不启动引擎。
   * 这里盯住三件事：注入了、注入了原话、**signal 传了**（少了就是线上那个
   * `Cannot read properties of undefined (reading 'throwIfAborted')`）。
   */
  const before = prompts.length
  const askResult = await commands[0].handler({
    rawInput: '帮我审查一下今天的代码',
    agent: { id: 's1' },
    signal: new AbortController().signal,
  })
  assert.equal(askResult.kind, 'success', `交给模型应成功，实际：${JSON.stringify(askResult)}`)
  /*
   * **成功时不回任何文字。** 注入进去的那句话本身就是反馈，它会作为一条普通用户消息
   * 出现在对话里；再补一句「已把这句话原样交给模型：它会自己在思考里定拓扑……」只是
   * 把同一件事用更长的话说第二遍。这条断言盯的就是「别说第二遍」。
   */
  assert.equal(askResult.text, undefined, `交给模型成功时不该回文字，实际：${String(askResult.text)}`)
  assert.equal(prompts.length, before + 1, '应该恰好注入一次')
  const injected = prompts[prompts.length - 1]
  assert.equal(injected.request.sessionId, 's1')
  assert.equal(injected.request.mode, 'queue')
  /*
   * **逐字相等，不是 includes。** 注入的必须是用户原话，一个字都不加 ——
   * 早期版本在这里塞了一段「先想拓扑、再用 wfRun……」的模板，那是错的方向：
   * 那属于「我该怎么干活」的说明，它该待在系统提示词里。
   */
  assert.equal(
    injected.request.content[0].text,
    '帮我审查一下今天的代码',
    '注入的必须是用户的原话，不能有任何加工',
  )
  assert.ok(injected.signal !== undefined && injected.signal !== null, 'signal 必须传下去')
  assert.ok(typeof injected.request.requestId === 'string' && injected.request.requestId.length > 0)

  /* 「怎么做」的说明必须在系统提示词里，且要点名后台执行与结构声明 */
  assert.equal(sections.length, 1, '应注册恰好一段系统提示词')
  const section = sections[0]
  assert.equal(section.name, 'workflow-studio')
  assert.ok(typeof section.order === 'number')
  assert.ok(section.text.includes('run_in_background'), '必须要求后台执行（前台会占住整轮，用户没法对话）')
  assert.ok(section.text.includes('wfRun'), '必须说明用 wfRun 声明结构，否则工作台画不出图')
  assert.ok(section.text.includes('思考'), '必须说明拓扑在思考里定，不要写进回复')

  /*
   * `input` **必须留着** —— 它是「这个命令接受参数」的开关，不是装饰。
   *
   * 客户端里 `desc.input !== void 0` 决定命令认不认领输入行：有它才是 `/goal` 那种
   * 「选中后进参数输入态」；没有它就是 `/compact` 那种「选中即执行」，参数永远是空串，
   * 按 Tab 直接发出去。我删过一次，两条症状都踩到了，所以这条断言必须盯死。
   */
  assert.ok(commands[0].input !== undefined, '/workflow 必须声明 input，否则参数入口就没了')
  assert.equal(typeof commands[0].input.hint, 'string', 'hint 必须是字符串')
  assert.ok(commands[0].input.hint.trim().length > 0, 'hint 不能为空 —— 宿主会直接抛 input hint must not be empty')
  assert.ok(
    commands[0].input.hint.length <= 40,
    `hint 要保持 /goal 那种紧凑风格，实际 ${String(commands[0].input.hint.length)} 字`,
  )

  /* 连 signal 都没有的调用也要能用（自己兜一个永不中止的），而不是抛那条报错 */
  const bareResult = await commands[0].handler({ rawInput: '再帮我查一件事', agent: { id: 's1' } })
  assert.equal(bareResult.kind, 'success', '没有 signal 时也应自兜一个')

  /* 第一个词能对上已保存的工作流名时，走的是引擎那条路，不注入提示词 */
  const beforeSaved = prompts.length
  const savedResult = await commands[0].handler({
    rawInput: 'codebase-audit {"files":["a.ts"]}',
    agent: { id: 's1' },
    signal: new AbortController().signal,
  })
  assert.equal(savedResult.kind, 'success')
  assert.ok(savedResult.text.includes('已启动'), `应直接调起，实际：${String(savedResult.text).slice(0, 80)}`)
  assert.equal(prompts.length, beforeSaved, '走引擎那条路时不该注入提示词')

  // 卸载路径：每个 effect 的 disposer 都要能跑
  for (const fn of effects) {
    const disposer = fn()
    if (typeof disposer === 'function') disposer()
  }
})

//#endregion

//#region 6. 客户端半边

console.log('\n客户端半边')

/**
 * 在 Node 里把 `client.js` 跑起来。
 *
 * 它是给浏览器写的（模块作用域就引用 `window.__ModuleLoader__`），所以要先摆一个
 * 最小的宿主环境。这一步能验出：语法是否正确、`apply()` 是否注册了两个槽位、
 * 纯函数是否给出预期结果 —— 这些一旦错了，真机上的症状全是「界面里什么都没有」。
 */
async function loadClientBundle() {
  const vm = await import('node:vm')
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  let captured = null
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    fetch: () => Promise.reject(new Error('离线自检不联网')),
    ResizeObserver: undefined,
  }
  sandbox.window = {
    __ModuleLoader__: {
      load(entry) {
        captured = entry
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { href: 'http://localhost/', origin: 'http://localhost' },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  if (captured === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
  return captured
}

/**
 * 一个够用的 React 替身。
 *
 * 为什么不用真的 react：第三方插件不打包依赖，本机 profile 里的 `react` 是 pnpm 的
 * junction，指向一个可能不存在的目录 —— 让自检依赖它，自检就会在别人机器上随机跳过。
 * 这里只需要「单遍渲染」这一个能力：hooks 都退化成初值（`useEffect` 是空操作），
 * 于是组件函数跑一遍、产出元素树，再序列化成 HTML 片段供断言。
 *
 * 能验出：组件函数是否会抛、条件分支走对没有、文案与 `data-*` 标记在不在。
 * 验不出：真实的重新渲染与副作用 —— 那必须真机跑。
 */
function createReactStub() {
  let current = null;
  const hooks = {
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect() {
      return undefined;
    },
    useRef(initial) {
      if (current.refs.length === 0) current.refs.push({ current: initial });
      return current.refs[0];
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
  };
  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    Fragment: Symbol("Fragment"),
    /* hooks 直接挂在 react 上：client.js 是 `const useState = react.useState` 这样取的 */
    useState: hooks.useState,
    useEffect: hooks.useEffect,
    useRef: hooks.useRef,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    __enter() {
      current = { refs: [] };
    },
  };
  return react;
}

/** 把元素树序列化成 HTML 片段（只保留能断言的文本与属性）。 */
function renderToStaticMarkup(react, element) {
  const escape = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return "";
    if (typeof node === "string") return escape(node);
    if (typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    if (typeof node.type === "function") {
      react.__enter();
      return walk(node.type({ ...node.props }));
    }
    if (typeof node.type !== "string") return walk(node.props?.children);
    const attrs = Object.entries(node.props ?? {})
      .filter(([key, value]) => key !== "children" && value !== undefined && value !== null && value !== false)
      .filter(([, value]) => typeof value === "string" || typeof value === "number" || value === true)
      .map(([key, value]) => (value === true ? ` ${key}` : ` ${key}="${escape(value)}"`))
      .join("");
    return `<${node.type}${attrs}>${walk(node.props?.children)}</${node.type}>`;
  };

  return walk(element);
}

/*
 * CSS 整块是一个模板字符串，里面**出现任何一个反引号都会提前结束它**，
 * 让整个 client.js 语法错误 —— 而报错位置指向被截断处**之后**的地方，不是写错的那一行。
 * 这个坑踩过两次（第二次修完第一处又漏了第二处），所以单独立一条，给出人话诊断。
 */
check('CSS 模板字符串里没有反引号（有的话整个文件语法错误，且报错指向别处）', () => {
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  const marker = 'const CSS = `'
  const start = source.indexOf(marker)
  assert.ok(start >= 0, '找不到 CSS 模板字符串起点')
  const end = source.indexOf('\n`;', start + marker.length)
  assert.ok(end >= 0, '找不到 CSS 模板字符串终点')
  const offenders = source
    .slice(start + marker.length, end)
    .split('\n')
    .map((line, index) => ({ line, index }))
    .filter((item) => item.line.includes('`'))
  assert.equal(
    offenders.length,
    0,
    `CSS 块里有 ${String(offenders.length)} 行含反引号，第 ${offenders.map((item) => String(item.index + 1)).join('、')} 行`,
  )
})

const bundle = await loadClientBundle()
check('client.js 用包名装载（客户端靠它与宿主的 /info 对齐）', () => {
  assert.equal(bundle.id, 'dsh-workflow-studio')
  assert.equal(typeof bundle.factory, 'function')
})

const reactModule = createReactStub();
const clientExports = bundle.factory((name) => {
  if (name === "react") return reactModule;
  throw new Error(`离线自检里没有 ${name}`);
});

check('导出 apply / inject，且 inject 只声明 slots（软取 uiWorkspace）', () => {
  assert.equal(typeof clientExports.apply, 'function')
  assert.deepEqual(Array.from(clientExports.inject), ['slots'])
})

check('apply() 注册侧栏面板、主面板与输入框上方的常驻条', () => {
  const registered = []
  const injections = []
  const ctx = {
    slots: {
      inject(key, callback) {
        injections.push(key)
        callback()
      },
      register(definition, component) {
        registered.push({ definition, component })
      },
    },
  }
  clientExports.apply(ctx)
  assert.deepEqual(injections.sort(), ['conversation.input.dock', 'main', 'sidebar.panellist'])
  assert.equal(registered.length, 3)

  const panel = registered.find((item) => item.definition.name === 'sidebar.panellist')
  const page = registered.find((item) => item.definition.name === 'main')
  const dock = registered.find((item) => item.definition.name === 'conversation.input.dock')

  assert.equal(panel.definition.id, clientExports.__internals.PANEL_WORKFLOW)
  assert.equal(typeof panel.component, 'function')
  assert.equal(page.definition.key, clientExports.__internals.PANEL_WORKFLOW)
  assert.equal(typeof page.component, 'function')

  // 常驻条：inject 是**函数**（收 sessionId、返回 props），与 chat.node 的数组形式不同 —— 照官方 goal 面板的形状
  assert.equal(typeof dock.definition.inject, 'function')
  // 跨 realm 的对象不能 deepEqual，取值比
  assert.equal(dock.definition.inject('session-1').sessionId, 'session-1')
  assert.equal(typeof dock.component, 'function')

  // 侧栏图标要带 data-dshd-nav，折叠胶囊靠它反查容器
  const icon = renderToStaticMarkup(reactModule, reactModule.createElement(panel.component, { size: 16 }))
  assert.ok(icon.includes('data-dshd-nav'), '侧栏图标应带 data-dshd-nav 标记')
})
const {
  projectBoard,
  linkBetween,
  rollup,
  avatarIndex,
  avatarGlyph,
  openChildSession,
  Pill,
  GraphView,
  TimelineView,
  LogView,
  DetailPanel,
  WorkbenchPage,
  WorkflowDock,
} = clientExports.__internals

/** 一次合成运行：三个阶段，审计阶段扇出 3 个实例。 */
function makeNode(seq, label, phase, childId, status, startedAt, endedAt, declaredId, lastText) {
  return {
    seq,
    label,
    phase,
    childId,
    status,
    outcome: status === 'running' ? null : status,
    startedAt,
    endedAt,
    declaredId,
    deps: [],
    detail: null,
    provider: 'wb',
    model: 'deepseek-v4.1-flash',
    prompt: null,
    lastText,
    bytes: 10,
    entryCount: 2,
  }
}

const RUN = {
  id: 'run-x',
  name: 'demo',
  description: '合成运行',
  phases: [
    { title: '扫描', detail: '列清单' },
    { title: '审计', detail: '每个文件一个' },
    { title: '汇总' },
  ],
  declaredNodes: [
    { id: 'scan', label: '扫描目标', phase: '扫描', deps: [], detail: null, group: null, kind: null },
    { id: 'audit', label: '审计文件', phase: '审计', deps: ['scan'], detail: null, group: null, kind: null },
    { id: 'verify', label: '交叉验证', phase: '汇总', deps: ['audit'], detail: null, group: null, kind: null },
  ],
  edges: [
    { from: 'scan', to: 'audit', kind: 'declared', inferred: false },
    { from: 'audit', to: 'verify', kind: 'declared', inferred: false },
  ],
  status: 'running',
  stopReason: null,
  error: null,
  agentsStarted: 5,
  startedAt: 1000,
  endedAt: null,
  currentPhase: '审计',
  phaseHistory: [
    { title: '扫描', time: 1100 },
    { title: '审计', time: 1500 },
  ],
  log: [{ time: 1200, kind: 'log', text: '开始审计' }],
  revision: 9,
  parentSessionId: 'session-parent',
  nodes: [
    makeNode(1, '扫描目标', '扫描', 'c1', 'completed', 1000, 1400, 'scan', '扫描完成'),
    makeNode(2, '审计文件', '审计', 'c2', 'completed', 1500, 2000, 'audit', 'a.ts 通过'),
    makeNode(3, '审计文件', '审计', 'c3', 'running', 1500, null, 'audit', '正在读 b.ts'),
    makeNode(4, '审计文件', '审计', 'c4', 'running', 1520, null, 'audit', '正在读 c.ts'),
    makeNode(5, '交叉验证', '汇总', 'c5', 'cancelled', 2100, 2200, 'verify', ''),
  ],
}

check('projectBoard：阶段按声明序排成列，每个子智能体各占一枚 pill', () => {
  const board = projectBoard(RUN)
  /*
   * 注意 Array.from：这些数组来自 vm 里的另一个 realm，跨 realm 的数组原型不同，
   * assert.deepEqual 会因为「结构相同但引用不等」而失败。
   */
  assert.deepEqual(Array.from(board.phases, (phase) => phase.title), ['扫描', '审计', '汇总'])
  assert.equal(board.phases[0].pills.length, 1)
  // 关键差别：三个「审计文件」是**三枚 pill**，不是一张写着「3 个实例」的卡
  assert.equal(board.phases[1].pills.length, 3, '扇出的三个实例应各自占一枚 pill')
  assert.equal(board.phases[1].pills[0].duplicate, true, '同列重名应被标出（补 #seq 尾巴）')
  assert.equal(board.phases[1].status, 'running')
  assert.equal(board.total, 5)
  // #1 #2 #5 已结算，#3 #4 还在跑
  assert.equal(board.settled, 3)
})

check('projectBoard：完成度按阶段计（就是 ZCode 那个 12/12 的分数）', () => {
  const board = projectBoard(RUN)
  assert.equal(board.phases[0].observed, 1)
  assert.equal(board.phases[0].settled, 1)
  assert.equal(board.phases[1].observed, 3)
  assert.equal(board.phases[1].settled, 1, '审计阶段只有 #2 结算了')
  assert.equal(board.phases[2].observed, 1)
  assert.equal(board.phases[2].settled, 1)
})

check('projectBoard：节点级的边被商到阶段级，列内不画边', () => {
  const board = projectBoard(RUN)
  const pairs = Array.from(board.links, (link) => link.from + '->' + link.to)
  // 不排序比较：中文的默认 sort 按 UTF-16 码元，写死顺序只会让这个断言读起来莫名其妙
  assert.equal(pairs.length, 2)
  assert.ok(pairs.includes('扫描->审计'), '扫描 → 审计')
  assert.ok(pairs.includes('审计->汇总'), '审计 → 汇总')
  assert.equal(board.links.some((link) => link.back), false, '这里没有回边')
})

check('projectBoard：没有声明时只按阶段分组，不编造阶段之间的边', () => {
  const plain = {
    ...RUN,
    declaredNodes: [],
    edges: [],
    nodes: RUN.nodes.map((item) => ({ ...item, declaredId: null })),
  }
  const board = projectBoard(plain)
  assert.equal(board.phases[1].pills.length, 3)
  assert.equal(board.links.length, 0, '没有边就不该有线')
})

check('linkBetween：找得到相邻两列之间的声明边，找不到时返回 null', () => {
  const board = projectBoard(RUN)
  assert.ok(linkBetween(board, '扫描', '审计') !== null)
  assert.ok(linkBetween(board, '审计', '汇总') !== null)
  assert.equal(linkBetween(board, '扫描', '汇总'), null)
})

check('rollup：running 优先于 failed（读者最需要知道「还在动吗」）', () => {
  assert.equal(rollup([{ status: 'failed' }, { status: 'running' }]), 'running')
  assert.equal(rollup([{ status: 'failed' }, { status: 'completed' }]), 'failed')
  assert.equal(rollup([{ status: 'completed' }, { status: 'completed' }]), 'completed')
  assert.equal(rollup([]), 'pending')
})

check('阶段列渲染出阶段名、完成度与 pill —— 但**不**渲染阶段说明文字', () => {
  const html = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(GraphView, { run: RUN, onOpen: () => {} }),
  )
  assert.ok(html.includes('扫描'), '应出现阶段名「扫描」')
  /*
   * 阶段头一行「名字 + 1/3」已经把该说的说完了。`meta.phases[].detail` 仍然照收
   * （数据里留着），但板面上不画 —— 再垫一行小字只是噪音，还会把这列 pill 往下推。
   */
  assert.equal(html.includes('每个文件一个'), false, '阶段说明文字不该渲染到板面上')
  assert.equal(html.includes('wfs-board-detail'), false, '连那个容器都不该出现')
  assert.ok(html.includes('1/3'), '审计阶段应显示 1/3 的完成度')
  assert.ok(html.includes('交叉验证'), '应出现子智能体名')
  assert.ok(html.includes('wfs-pill'), '应画出 pill')
  assert.ok(html.includes('wfs-board-link'), '列与列之间应有连线')
  assert.ok(html.includes('data-edge="1"'), '有声明边的相邻列应画实线')
  assert.ok(html.includes('wfs-avatar'), 'pill 上应有头像方块')
  assert.ok(html.includes('deepseek-v4.1-flash'), '模型应出现在 pill 的 title 上')
})

check('一列超过 5 枚 pill 时折成「还有 N 个」，展开后全部渲染', () => {
  /* 审计列原本 3 枚，再加 5 枚 = 8 枚；PILL_PINS = 5，所以折起 3 枚 */
  const many = {
    ...RUN,
    nodes: [
      ...RUN.nodes,
      makeNode(6, '审计文件', '审计', 'c6', 'running', 1530, null, 'audit', 'e.ts'),
      makeNode(7, '审计文件', '审计', 'c7', 'running', 1540, null, 'audit', 'f.ts'),
      makeNode(8, '审计文件', '审计', 'c8', 'running', 1550, null, 'audit', 'g.ts'),
      makeNode(9, '审计文件', '审计', 'c9', 'running', 1560, null, 'audit', 'h.ts'),
      makeNode(10, '审计文件', '审计', 'c10', 'running', 1570, null, 'audit', 'i.ts'),
    ],
  }
  const collapsed = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(GraphView, { run: many, onOpen: () => {} }),
  )
  assert.ok(collapsed.includes('还有 3 个'), '审计列有 8 枚，应折起后 3 枚')
  assert.ok(collapsed.includes('wfs-stack'), '折起那一行应叠几张脸')

  const expanded = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(GraphView, {
      run: many,
      onOpen: () => {},
      expandedPhases: { 审计: true },
      onExpandPhase: () => {},
    }),
  )
  assert.equal(expanded.includes('还有 3 个'), false, '展开后不应再有「还有 N 个」')
  assert.ok((expanded.match(/wfs-avatar/g) ?? []).length >= 8, '展开后 8 枚 pill 都应渲染')
})

check('阶段列在没有子智能体时给的是人话，不是空白', () => {
  const html = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(GraphView, { run: { ...RUN, nodes: [], phases: [] }, onOpen: () => {} }),
  )
  assert.ok(html.includes('还没有派出任何子智能体'))
})

check('时间线每个实例一条泳道', () => {
  const html = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(TimelineView, { run: RUN, onOpen: () => {} }),
  )
  const lanes = html.match(/wfs-tl-row/g) ?? []
  assert.equal(lanes.length, 5, '应有 5 条泳道，实际 ' + String(lanes.length))
  assert.ok(html.includes('wfs-tl-bar'), '应画出时间条')
  assert.ok(html.includes('时间轴'))
})

check('叙述视图把 phase 与 log 按时间合并', () => {
  const html = renderToStaticMarkup(reactModule, reactModule.createElement(LogView, { run: RUN }))
  assert.ok(html.includes('扫描'))
  assert.ok(html.includes('开始审计'))
  assert.ok(html.indexOf('扫描') < html.indexOf('开始审计'), '阶段推进应排在它之后的叙述前面')
})

check('详情面板在没有选中时给运行概览，并解释怎么读这张图', () => {
  const html = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(DetailPanel, { run: RUN }),
  )
  assert.ok(html.includes('运行概览'))
  assert.ok(html.includes('实线是脚本声明的依赖'), '应解释实线与淡虚线的差别')
  assert.ok(html.includes('打开那个子智能体自己的会话窗口'), '应说明点 pill 会跳会话，而不是展开面板')
})

check('点一枚 pill 就是把整个 pill 交出去（childId 必须跟着走）', () => {
  const pill = {
    seq: 7,
    label: '审宿主半边',
    status: 'completed',
    childId: 'session-child-7',
    startedAt: 0,
    endedAt: 10,
    model: null,
    duplicate: false,
  }
  const opened = []
  // 直接调函数组件：离线渲染点不到 onClick，但元素上的 onClick 拿得到、也调得动
  const element = Pill({ pill, onOpen: (target) => opened.push(target) })
  assert.equal(typeof element.props.onClick, 'function')
  element.props.onClick()
  assert.equal(opened.length, 1, '点一次应该只回调一次')
  assert.equal(opened[0].childId, 'session-child-7', 'childId 必须随 pill 一起交出去 —— 少了它就没法打开会话')
})

check('openChildSession：用 childId 调 uiWorkspace.openSession；取不到服务时返回 false 而不是假装成功', () => {
  const opened = []
  const hostCtx = {
    get(name) {
      return name === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : null
    },
  }
  assert.equal(openChildSession(hostCtx, 'session-child-9'), true)
  assert.deepEqual(opened, ['session-child-9'])

  // 没有 uiWorkspace：如实返回 false，让调用方去提示，而不是静默什么都不发生
  assert.equal(openChildSession({ get: () => null }, 'x'), false)
  assert.equal(openChildSession(null, 'x'), false)
  assert.equal(openChildSession(hostCtx, ''), false, '空 childId 不该触发导航')

  // get 抛异常也不能把界面带崩
  assert.equal(
    openChildSession(
      {
        get() {
          throw new Error('boom')
        },
      },
      'x',
    ),
    false,
  )
})

check('阶段连线的虚实：只有**声明**的依赖才是实线，推断出来的画淡虚线', () => {
  /*
   * 断言必须精确到**同一条连线上的两个属性连在一起**。
   * 早期版本写的是 `includes('data-edge="0"')` —— 那个字符串是另一条连线
   * （审计→汇总，本来就没有依赖）贡献的，所以无论推断边怎么画它都成立。
   * 变异测试当场戳穿了这条假断言：把 PhaseLink 改回「不判 inferred」，自检依然是绿的。
   */
  const declared = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(GraphView, { run: RUN, onOpen: () => {} }),
  )
  assert.ok(declared.includes('data-edge="1" data-inferred="0"'), '声明边应是实线，且不被标成推断')

  /*
   * 一个**纯推断**的运行：没有任何声明，只有时序推出来的 seq: 边。
   * 节点 seq:1 在「扫描」、seq:2 在「审计」，于是 扫描→审计 这条连线就是推断出来的。
   * 它如果被画成实线，就等于把「猜的」说成「作者声明的」。
   */
  const inferredRun = {
    ...RUN,
    declaredNodes: [],
    edges: [{ from: 'seq:1', to: 'seq:2', kind: 'sequence', inferred: true }],
    nodes: RUN.nodes.map((item) => ({ ...item, declaredId: null })),
  }
  const inferred = renderToStaticMarkup(
    reactModule,
    reactModule.createElement(GraphView, { run: inferredRun, onOpen: () => {} }),
  )
  assert.ok(inferred.includes('data-edge="0" data-inferred="1"'), '推断边必须是淡虚线，且被标出来')
})

check('常驻条在本会话还没有运行时不渲染任何东西（而不是渲染一个空壳）', () => {
  const html = renderToStaticMarkup(reactModule, reactModule.createElement(WorkflowDock, { sessionId: 'session-parent', hostCtx: null }))
  assert.equal(html, '', '没有运行时整条不该出现')
})

check('主页面在「还没有任何数据」时不抛错', () => {
  const html = renderToStaticMarkup(reactModule, reactModule.createElement(WorkbenchPage, { hostCtx: null }))
  assert.ok(html.includes('工作流工作台'))
  assert.ok(html.includes('结构图') && html.includes('时间线') && html.includes('工作流库'))
})

check('avatarIndex / avatarGlyph 稳定，且不把 emoji 切成半个', () => {
  assert.equal(avatarIndex(0), 0)
  assert.equal(avatarIndex(9), 0)
  assert.equal(avatarIndex(12), 3)
  assert.equal(avatarGlyph({ seq: 3, label: '审计文件' }), '审')
  assert.equal(avatarGlyph({ seq: 3, label: '' }), '#3')
  assert.equal(avatarGlyph({ seq: 3, label: '🔍 搜索' }), '🔍')
})
console.log(`\n通过 ${String(passed)} 项，失败 ${String(failed)} 项`)
process.exit(failed === 0 ? 0 : 1)
