---
name: codebase-audit
description: 把一批文件扇出给子智能体并行审计，再交叉验证结论
whenToUse: 当需要批量核对多个文件的实现与文档是否一致时
phases:
  - title: 扫描
    detail: 摸清目标清单与判断标准
  - title: 审计
    detail: 每个文件一个子智能体，互不依赖
  - title: 汇总
    detail: 交叉验证有争议的结论
graph:
  - id: scan
    label: 扫描目标
    phase: 扫描
  - id: audit
    label: 审计文件
    phase: 审计
    deps: [scan]
  - id: verify
    label: 交叉验证
    phase: 汇总
    deps: [audit]
---
/*
 * 入参：{ files: string[], criteria?: string }
 * 出参：{ total, audited, risky, findings, verified }
 *
 * 这是「随包示例」，用来演示三件事：
 *   1. 阶段推进（phase）与结构声明（wfRun 的 deps/graph）；
 *   2. 用 pipeline 把 N 个文件扇出成 N 个子智能体；
 *   3. 用一个额外的子智能体做对抗性验证 —— 它依赖全部审计结论，所以放在后面串行。
 */
const files = Array.isArray(args?.files) ? args.files : []
if (files.length === 0) {
  return { error: '缺少 files 参数。用法：/workflow codebase-audit {"files":["a.ts","b.ts"]}' }
}
const criteria = args?.criteria ?? '实现是否与注释、文档一致，有无明显缺陷'

phase('扫描')
const plan = await wfRun('scan', { label: '扫描目标', phase: '扫描' },
  `你是代码审计的协调者。待审计的文件：\n${files.map((file) => `- ${file}`).join('\n')}\n\n` +
  `判断标准：${criteria}\n\n` +
  '先用工具快速看一眼这些文件的规模与类型，然后给出：\n' +
  '1) 每个文件的审计要点（一句话）；\n' +
  '2) 判断标准需要补充的维度。\n直接输出结论。')

phase('审计')
const findings = await pipeline(files, async (file) =>
  wfRun('audit', { label: '审计文件', phase: '审计' },
    `审计文件 ${file}。判断标准：${criteria}\n协调者给出的要点：${plan}\n\n` +
    '请实际读文件、必要时读相关文件，然后输出三段：\n' +
    '- 结论：通过 / 有问题\n- 证据：具体到行号或片段\n- 建议：可执行的修改\n' +
    '不要复述文件内容。'))

const alive = findings.filter(Boolean)
log(`审计完成：${alive.length}/${files.length} 个文件给出了结论`)

phase('汇总')
const risky = alive.filter((text) => /有问题|不通过|缺陷|风险/.test(String(text)))
let verified = null
if (risky.length > 0) {
  verified = await wfRun('verify', { label: '交叉验证', phase: '汇总' },
    `下面是审计中判定「有问题」的结论：\n\n${risky.join('\n\n---\n\n')}\n\n` +
    '请对每一条做对抗性验证：证据真的成立吗？有没有误报？\n' +
    '输出一个 JSON 数组，每项 { file, claim, verdict: "确认" | "误报" | "存疑", reason }。')
}

return { total: files.length, audited: alive.length, risky: risky.length, findings: alive, verified }
