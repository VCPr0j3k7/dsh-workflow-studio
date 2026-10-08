/**
 * 变异测试：把修好的那几处**改回坏的样子**，确认自检真的会红。
 *
 * 一个在修复前后都绿的测试等于没有测试 —— 它只会在你以为有覆盖的时候给你错误的安心。
 * 这里对每一处「修过的缺陷」做一次变异：改坏 → 跑自检 → 恢复 → 断言自检确实失败了。
 *
 * 用法：node tools/mutation-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import { PLUGIN_ROOT } from './paths.mjs'

const ROOT = PLUGIN_ROOT

/** 每一处：文件、正确写法、坏写法，以及这条变异想证明哪条断言还活着。 */
const MUTATIONS = [
  {
    label: 'sessionController.prompt 少传 signal',
    file: `${ROOT}/index.js`,
    good: '      abortSignal,\n    )',
    bad: '    )',
  },
  {
    label: 'inferEdges 的清理写在早退之后（死代码）',
    file: `${ROOT}/host/runs.mjs`,
    good:
      '    run.edges = run.edges.filter((edge) => edge.inferred !== true)\n    if (run.declaredNodes.size > 0) return',
    bad:
      '    if (run.declaredNodes.size > 0) return\n    run.edges = run.edges.filter((edge) => edge.inferred !== true)',
  },
  {
    label: 'PhaseLink 忽略 inferred（推断边被画成实线）',
    file: `${ROOT}/client.js`,
    good: 'const declared = state !== null && state.inferred !== true;',
    bad: 'const declared = state !== null;',
  },
  {
    label: '删掉命令的 input（参数入口消失、Tab 变直接发送）',
    file: `${ROOT}/index.js`,
    good: "      input: { hint: '要做什么，或已有工作流的名字' },\n",
    bad: '',
  },
]

function runSuite() {
  try {
    return { green: true, output: execFileSync(process.execPath, ['test/check.mjs'], { cwd: ROOT, encoding: 'utf8' }) }
  } catch (error) {
    return { green: false, output: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` }
  }
}

let allGood = true
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')
  if (!original.includes(mutation.good)) {
    allGood = false
    console.log(`✗ ${mutation.label}\n    找不到要变异的正确写法 —— 这个脚本自己失效了，必须更新`)
    continue
  }

  writeFileSync(mutation.file, original.replace(mutation.good, mutation.bad), 'utf8')
  const result = runSuite()
  writeFileSync(mutation.file, original, 'utf8')

  const summary = result.output.split('\n').filter((line) => line.includes('通过 ')).pop() ?? '(没有汇总行)'
  if (result.green) {
    allGood = false
    console.log(`✗ ${mutation.label}\n    改坏之后自检**仍然是绿的** —— 这条回归测试是假的\n    ${summary.trim()}`)
  } else {
    console.log(`✓ ${mutation.label}\n    改坏后自检变红：${summary.trim()}`)
  }
}

console.log(allGood ? '\n全部变异都被自检抓住 —— 这些回归测试是有效的' : '\n有变异没被抓住，必须补测试')
process.exit(allGood ? 0 : 1)
