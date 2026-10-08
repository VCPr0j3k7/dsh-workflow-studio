/**
 * 校验 profile 的两个配置文件在本次安装改动后仍然可解析。
 * 用法（宿主自带的 Electron-as-Node 或任意 node 均可）：
 *   node tools/verify-profile.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { PROFILE_DIR } from './paths.mjs'

/* profile 目录从环境推导（DSH_PROFILE_DIR → DSH_HOME/profiles/<DSH_PROFILE>），不写死本机路径。 */
const dir = PROFILE_DIR

/*
 * `yaml` 是官方 web-app 的依赖，装在 profile 自己的 node_modules 里（不是共享 hoisted 层），
 * 所以用 createRequire 从 profile 目录解析 —— 直接拼 dist/index.js 会在版本变化时失效。
 */
const requireFromProfile = createRequire(pathToFileURL(`${dir}/package.json`).href)
let yaml = null
try {
  yaml = await import(pathToFileURL(requireFromProfile.resolve('yaml')).href)
} catch (error) {
  console.log(`（跳过 YAML 结构校验：profile 里解析不到 yaml —— ${String(error.message)}）`)
}

let failed = 0

const patch = readFileSync(`${dir}/cordis.patch.yml`, 'utf8')
const mentions = patch.split('\n').filter((line) => line.includes('dsh-workflow-studio')).length
if (yaml === null) {
  console.log(`cordis.patch.yml  跳过结构校验；提及 dsh-workflow-studio 的行数：${String(mentions)}`)
} else {
  try {
    const value = yaml.parse(patch)
    const isArray = Array.isArray(value)
    console.log(`cordis.patch.yml  OK —— 顶层${isArray ? `数组，${String(value.length)} 项` : ` ${typeof value}`}`)
    if (isArray) {
      const ids = value.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert.map((row) => row.id) : []))
      console.log(`  其中 insert 行：${ids.length === 0 ? '（无）' : ids.join(', ')}`)
    }
    console.log(`  提及 dsh-workflow-studio 的行数：${String(mentions)}（bundle 路由下应为 0）`)
  } catch (error) {
    failed += 1
    console.log(`cordis.patch.yml  解析失败：${String(error.message)}`)
  }
}

const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
console.log(`package.json      OK —— bundles: ${JSON.stringify(pkg.dsh.profile.bundles)}`)
console.log(`  dependencies.dsh-workflow-studio = ${String(pkg.dependencies['dsh-workflow-studio'])}`)

process.exit(failed === 0 ? 0 : 1)
