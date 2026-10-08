---
name: multi-angle-research
description: 对一个问题从多个角度并行调研，再做对抗性复核，最后综合
whenToUse: 当需要快速把一个陌生主题摸清、且不想被单一视角带偏时
phases:
  - title: 拆解
    detail: 把问题拆成互不重叠的调研角度
  - title: 调研
    detail: 每个角度一个子智能体
  - title: 复核
    detail: 挑出互相矛盾的结论
  - title: 综合
    detail: 给出带置信度的结论
graph:
  - id: split
    label: 拆解角度
    phase: 拆解
  - id: research
    label: 角度调研
    phase: 调研
    deps: [split]
  - id: challenge
    label: 对抗复核
    phase: 复核
    deps: [research]
  - id: synth
    label: 综合结论
    phase: 综合
    deps: [challenge]
---
/*
 * 入参：{ question: string, angles?: number }
 * 出参：{ question, angles, findings, challenges, answer }
 */
const question = String(args?.question ?? '').trim()
if (question === '') {
  return { error: '缺少 question 参数。用法：/workflow multi-angle-research {"question":"..."}' }
}
const wanted = Math.max(2, Math.min(6, Number(args?.angles ?? 3)))

phase('拆解')
const split = await wfRun('split', { label: '拆解角度', phase: '拆解' },
  `把下面这个问题拆成 ${wanted} 个**互不重叠**的调研角度。\n\n问题：${question}\n\n` +
  '每个角度输出一行，格式：`角度名 :: 一句话说明要查什么`。\n只输出这些行，不要编号之外的任何解释。')

const angles = String(split)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.includes('::'))
  .map((line) => {
    const [name, detail] = line.split('::')
    return { name: name.replace(/^[-*\d.\s]+/, '').trim(), detail: (detail ?? '').trim() }
  })
  .slice(0, wanted)

if (angles.length === 0) return { error: '拆解阶段没有产出可用的角度', raw: split }

phase('调研')
const findings = await pipeline(angles, async (angle) =>
  wfRun('research', { label: '角度调研', phase: '调研' },
    `调研角度：${angle.name}\n要查什么：${angle.detail}\n原始问题：${question}\n\n` +
    '请用可用的检索与阅读工具实际去查，然后输出：\n' +
    '- 关键事实（每条附来源）\n- 这个角度的结论\n- 你不确定的地方\n' +
    '不要编造来源；查不到就明确说查不到。'))

const gathered = findings.filter(Boolean)

phase('复核')
const challenge = await wfRun('challenge', { label: '对抗复核', phase: '复核' },
  `原始问题：${question}\n\n以下是各角度的调研结论：\n\n${gathered.join('\n\n---\n\n')}\n\n` +
  '请找出**互相矛盾**或**证据不足**的地方，逐条列出：哪两条冲突、冲突点是什么、' +
  '要判定谁对还需要什么证据。如果确实没有矛盾，就明说没有。')

phase('综合')
const answer = await wfRun('synth', { label: '综合结论', phase: '综合' },
  `原始问题：${question}\n\n调研结论：\n${gathered.join('\n\n---\n\n')}\n\n复核意见：\n${challenge}\n\n` +
  '请给出最终回答：\n' +
  '1) 直接回答（先给结论，不要铺垫）；\n' +
  '2) 支撑证据（附来源）；\n' +
  '3) 仍然存疑的地方，以及置信度（高/中/低）。')

return { question, angles: angles.map((angle) => angle.name), findings: gathered, challenges: challenge, answer }
