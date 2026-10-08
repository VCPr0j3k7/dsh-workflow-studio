/**
 * 脚本组装：把用户写的编排脚本包一层「结构声明」前置代码，再交给官方引擎。
 *
 * ## 为什么需要这一层
 *
 * 官方的 `workflowEngine.start({ script })` 只接受**一段脚本文本**，引擎解析它、
 * 在一个受限的脚本域里执行，并把 `agent() / pipeline() / parallel() / phase() / log() / args`
 * 六个钩子注入作用域。它没有「声明依赖关系」的入口 —— 引擎的事件里 agent 之间没有边。
 *
 * 但 `log(message)` 是**脚本域到宿主的通用文本通道**。于是：前置代码定义几个小函数，
 * 它们把结构信息序列化成一行带魔法前缀的 `log()`，宿主半边（`host/runs.mjs`）把它
 * 从普通叙述里摘出来，还原成节点与边。
 *
 * 这样做的三个好处：
 *   1. **不动官方引擎**：脚本仍然是标准脚本，去掉前置代码照样能跑；
 *   2. **不污染界面**：带前缀的日志被宿主消费掉，不会出现在叙述区；
 *   3. **可选**：作者不写结构声明时，宿主退化为阶段分组 + 时序推断（见 runs.mjs）。
 *
 * ## 脚本里可用的结构钩子
 *
 * ```js
 * wfRun(id, spec, prompt, opts?)   // 声明一个节点并立刻跑一个子智能体；最常用
 * wfNode(id, spec)                 // 只声明节点（自己调用 agent()）
 * wfEdge(from, to, kind?)          // 显式声明一条边
 * wfGroup(id, spec)                // 声明一个逻辑分组（如一批并行）
 * ```
 *
 * `spec` 支持：`label`（同时作为 agent 的 label）、`phase`、`deps`（上游节点 id 数组，
 * 自动生成边）、`group`、`kind`、`detail`、`provider`、`model`。
 */

/** 结构消息的魔法前缀。宿主靠它把结构日志与普通叙述分开。 */
export const STRUCTURE_PREFIX = '@@wfs:'

/**
 * 结构前置代码。
 *
 * 注意命名：全部带 `__wfs_` / `wf` 前缀，避免与用户脚本里的变量撞名
 * （撞名会让整段脚本 SyntaxError，报错信息还很难懂）。
 */
const PREAMBLE = `const __wfs_send = (payload) => { try { log(${JSON.stringify(STRUCTURE_PREFIX)} + JSON.stringify(payload)) } catch (e) {} };
const wfNode = (id, spec) => { const s = spec || {}; __wfs_send({ t: 'node', id: String(id), label: s.label, phase: s.phase, deps: s.deps, group: s.group, kind: s.kind, detail: s.detail }); return s; };
const wfEdge = (from, to, kind) => { __wfs_send({ t: 'edge', from: String(from), to: String(to), kind: kind || 'flow' }); };
const wfGroup = (id, spec) => { const s = spec || {}; __wfs_send({ t: 'group', id: String(id), label: s.label, kind: s.kind, nodes: s.nodes }); return s; };
const wfRun = (id, spec, prompt, opts) => {
  const s = wfNode(id, spec);
  const merged = Object.assign({}, opts || {});
  if (s.label !== undefined) merged.label = s.label;
  if (s.phase !== undefined) merged.phase = s.phase;
  if (s.provider !== undefined) merged.provider = s.provider;
  if (s.model !== undefined) merged.model = s.model;
  return agent(prompt, merged);
};`

/**
 * 组装最终交给引擎的脚本。
 *
 * @param {object} options
 * @param {string} options.script 用户脚本正文
 * @param {object|null} [options.graph] frontmatter 里声明的静态结构（原样透传给界面）
 * @returns {string}
 */
export function composeScript({ script, graph = null }) {
  const parts = [PREAMBLE]
  if (graph !== null && graph !== undefined) {
    // 静态结构先发一次，界面在第一个子智能体启动前就有图可画
    parts.push(`__wfs_send({ t: 'graph', graph: ${JSON.stringify(graph)} });`)
  }
  parts.push(script)
  return parts.join('\n')
}

/** 这条日志是不是结构消息。 */
export function isStructureMessage(message) {
  return typeof message === 'string' && message.startsWith(STRUCTURE_PREFIX)
}

/**
 * 把脚本包成「一个立即执行的异步函数」，让 `return` 有意义。
 *
 * 官方引擎的脚本正文里 `return <value>` 是顶层 return（引擎自己处理），
 * 因此这里**不做**包装 —— 保留这个函数是为了在需要时（例如注入额外的
 * 局部变量而不污染全局）有统一的落点，目前是恒等函数。
 *
 * @param {string} script
 * @returns {string}
 */
export function wrapBody(script) {
  return script
}
