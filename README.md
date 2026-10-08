# dsh-workflow-studio

> 给 DeepSeek Harness 补上「人」的工作流入口：用 `/workflow` 调起工作流，并用图形化界面
> 展示**每个子智能体在做什么**以及**它们之间的结构关系**。

---

## 目录

- [问题背景](#问题背景)
- [它做了什么](#它做了什么)
- [界面](#界面)
- [安装](#安装)
- [卸载](#卸载)
- [写一个工作流](#写一个工作流)
- [结构声明](#结构声明)
- [命令参考](#命令参考)
- [工作原理](#工作原理)
- [启用条件](#启用条件)
- [测试](#测试)
- [已知限制](#已知限制)
- [致谢](#致谢)
- [许可](#许可)

---

## 问题背景

DSH 已经有一个**很强的工作流引擎**：`@deepseek-ai/dsh-workflow-ptc` 提供 `ctx.workflowEngine`，
`workflow` 工具让模型写一段 JavaScript 把任务扇出给几十个子智能体，并发上限、取消、
子智能体派生、结果校验一应俱全。缺的不是引擎，是**人的入口**：

| 缺口 | 表现 |
|---|---|
| 入口不对 | 只有模型能触发工作流。想让工作流干活，得先跟模型解释一遍「这件事该怎么拆」——而没有一个人能直接说 `/workflow 帮我审一下今天的代码` |
| 不能沉淀 | 工作流是模型每次现写的，没法存成「我每周都跑这个」 |
| 看不见内容 | 官方会话内卡片（`dsh-client-ui-workflow-run`）只有「阶段 → 成员」两层的**状态列表**：谁在跑、跑完没有。**看不到每个子智能体在写什么** |
| 看不见结构 | 引擎事件里 agent 之间没有边。哪些是并行的、哪个依赖哪个，界面上完全没有 |
| 位置不对 | 进度只在会话流里出现一次就滚上去了。人打字的时候看不到「现在跑到哪了」 |

本插件补这五件事，且**不替换任何官方部件** —— 引擎、事件、会话、会话内卡片全部照旧。

## 它做了什么

1. **`/workflow <随便一句话>`** —— 把这句话**原样**交给模型，由它在思考里定拓扑、写脚本，
   再调用 `workflow` 工具在**后台**启动。命令本身不跑工作流。
2. **`/workflow <已保存的名称>`** —— 直接跑一份你写好的工作流，适合「每周都跑同样的流程」。
   两种发起方式共用一个命令，靠「第一个词是不是已保存的工作流名」分流。
3. **工作流库**：`<DSH_HOME>/workflows/*.js`，YAML frontmatter + 脚本正文。
   可复用、可版本化、可随包分发。
4. **输入框上方的常驻条** —— 像目标/任务列表那样挂在输入框上方，可折叠可展开。
   展开后是阶段列 + 子智能体 pill；**点任意一枚 pill 直接跳到那个子智能体自己的会话窗口**
   （与 DSH 顶部的子智能体下拉菜单点进去是同一个落点）。
5. **完整工作台面板**（侧栏）—— 常驻条放不下的东西都在这里，三种视图：
   - **结构图** —— 阶段列 + 子智能体 pill + 列间的「在它之后运行」连线
   - **时间线** —— 每个子智能体一条泳道，横轴是真实时间（唯一能验证「到底是不是真并行」的地方）
   - **叙述** —— 脚本 `phase()` / `log()` 出来的进度
6. **结构声明**：脚本可以用 `wfNode` / `wfRun` / `wfEdge` / `wfGroup` 显式声明依赖。
   声明过的依赖会被「商掉」到阶段级，画成列与列之间的实线。

### 两条刻意的边界

**一、「怎么做」不进用户消息。** `/workflow <一句话>` 注入的就是那句话本身，一个字都不加。
「收到编排请求时先在心里定拓扑、脚本里用 `wfRun` 声明结构、默认后台执行」——
这些属于**我该怎么干活**的说明，由插件注册的一段系统提示词承担（见[工作原理](#工作原理)）。
用户发什么，模型就该看到什么；解读与分工发生在模型的思考里，不发生在消息内容的改写里。

**二、不镜像转录。** 插件**不**自己渲染子智能体的转录。点 pill 走官方的会话导航，
落到官方原生的会话窗口 —— 完整的 markdown、工具卡片、图片、流式追加与冷恢复全是现成的。
自己再镜像一份，等于同一份内容维护两遍，而镜像那份永远是残缺的。

## 界面

### 输入框上方的常驻条（主入口）

```
┌ ● 工作流已完成  DS 代码对抗性审查        2 个阶段 · 13 个子代理   ⌄ ┐
│                                                                    │
│  ● 四路并行对抗…  12/12  ──  ● 汇总发现并产出…  1/1                │
│  ┌──────────────────────┐   ┌──────────────────────┐              │
│  │ 🟩 回退完整性审计员  ✓ │   │ 🟪 评审汇总员       ✓ │              │
│  │ 🟧 路线A代码评审员   ✓ │   └──────────────────────┘              │
│  │ 🟦 评测链评审员      ✓ │                                        │
│  │ 🟪 幻觉与死引用扫…   ✓ │                                        │
│  │ 🟦 复核员-scan-1     ✓ │                                        │
│  │ 🟥🟪🟩 还有 7 个      ↗ │                                        │
│  └──────────────────────┘                                        │
└────────────────────────────────────────────────────────────────────┘
```

- 左边状态点 + 「工作流已完成 / 进行中 / 失败 / 已取消」+ 工作流名，右边是规模与折叠箭头。
- **运行中默认展开**（这时候人最关心），结算后默认折叠成一行。
- **点任意一枚 pill → 打开那个子智能体自己的会话窗口。** 面板里不展开转录、不弹下拉 ——
  原生会话视图比这里能给的完整得多。pill 尾巴上的 `↗` 就是这个意思。
- 本会话没有工作流时，整条不出现（不占地方）。

#### 宽度必须自己算 —— 槽位不会替你算

`conversation.input.dock` 是**全宽槽位**：每个条目要自己把 composer 的 clearance / inset
减掉，才能和输入框左右对齐。官方 goal bar 就是这么做的，`dsh-client-ui-conversation` 里
每一个 dock 条目也都是同一个公式：

```css
width: calc(100%
  - var(--dsh-composer-side-clearance) * 2
  - var(--dsh-composer-dock-inset) * 4);
max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
margin: 0 auto;
```

实测这几个变量在官方组合里是有定义的（`--dsh-composer-side-clearance:16px`、
`--dsh-composer-dock-inset:8px`、`--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px)`）。
**本插件最初什么都没减**，于是这条比输入框宽出两圈 —— 那就是「宽度不对」的全部原因。
现在两处都用同一个公式，宽度与 goal bar、输入框严丝合缝。

排查手法记一下：`tools/find-css-var.mjs` 对 121MB 的 `app.asar` 做一次字节级搜索，
把「定义处」和「引用处」分开报（后面紧跟冒号的才算定义）——
比逐个包 `cat` 又快又不会漏，也能立刻看出某个变量到底有没有被定义。

#### 折叠箭头的方向

**收起时朝上、展开时朝下。** 这条挂在输入框上方，内容是从头部**往下**铺到输入框那侧的，
所以「朝下」表示已经铺开了、「朝上」表示折着。

官方两种约定都存在（`ui-jobs` 的 `.triggerOpen{rotate(180deg)}` 与
`.sectionChevron{-90deg → none}`），这里按实际观感选的后者。

### 工作台面板（侧栏，看细节与历史）

```
┌─ 工作流工作台 ──────────────────────────────────────────────────────┐
│ [运行列表 ▾]  codebase-audit · 运行中 · 5 个子智能体 · 12.3s  [停止]  │
├─────────────────────────────────────────────────────────────────────┤
│ 结构图 │ 时间线 │ 叙述 │ 工作流库                    ┌─────────────┐ │
├──────────────────────────────────────────────────────┤ 运行概览     │ │
│  ● 扫描  1/1 ── ● 审计  1/3 ── ● 汇总  1/1           │ 名称 …      │ │
│  ┌────────────┐  ┌────────────┐                      │ 状态 …      │ │
│  │🟦 扫描目标✓│  │🟩 审计文件✓│                      │ 用时 …      │ │
│  └────────────┘  │🟧 审计文件…│                      │ 子智能体 …  │ │
│                  │🟪 审计文件…│                      │ 怎么读这张图 │ │
│                  └────────────┘                      └─────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**怎么读这张图**（也写在面板里）：

- **一列是一个阶段，一枚 pill 是一个子智能体。** `pipeline(items, …)` 派出 12 个子智能体
  就是 12 枚 pill —— 不是一张写着「12 个实例」的卡。看工作流的人第一眼想知道的是
  「这一阶段到底派了哪些人」，而不是「这里有一坨东西，点开看看是谁」。
- 阶段头右边的 **`12/12`** 是「已结算 / 已观测」：这一列收工了几个，一眼看到。
- **列与列之间的线**表示「在它之后运行」：脚本声明过的画实线，只是相邻（或按时序推出来的）
  画淡虚线 —— 不把「挨着」或「猜的」说成「有依赖」。列内不画线，同一列的人本来就并排站着。
- **一列超过 5 枚就折起来**，最后一行「还有 N 个」叠三张脸，点开全部展开。
- **头像是为了区分实例，不是为了表达状态**：同名的实例各占一个色相，重名的还会补一个
  `#3` 尾巴（否则一列五枚 pill 长得一模一样，点开哪一个全靠猜）。状态看 pill 尾部的记号
  （`…` 运行 / `✓` 完成 / `✕` 失败 / `⊘` 取消）和阶段头上的圆点。
- 右侧概览栏按容器比例伸缩（26%，夹在 240–360px），不写死像素宽度。

## 安装

本插件是一个标准的 DSH bundle（`package.json` 里声明了 `dsh.bundle.patch`），
所以安装就是把它装进 profile 并登记进 bundle 列表：

```bash
git clone https://github.com/VCPr0j3k7/dsh-workflow-studio
dsh plugin --profile desktop add file:<克隆下来的目录>
```

**然后重启 DSH。** 宿主半边是宿主启动时加载的一部分，装完必须重启才生效
（见[已知限制](#已知限制)）。

### 装不动的时候：手工等价安装

如果 `dsh plugin add` 因为**与插件无关的原因**失败（本机就遇到过：profile 里另一条
`file:` 依赖指向了一个已经删掉的目录，pnpm 解析直接 `ENOENT`，于是任何 `pnpm add` 都失败），
可以手工做 pnpm 本来会做的三件事：

1. 在 `<profile>/node_modules/` 下给插件目录建一个 **junction**（Windows）或符号链接；
2. `<profile>/package.json` 的 `dependencies` 里加 `"dsh-workflow-studio": "file:<插件目录>"`；
3. 同一个文件的 `dsh.profile.bundles` 里追加 `"dsh-workflow-studio"`。

**不要动 `cordis.patch.yml`** —— insert 行由插件自带的 `cordis.patch.yml` 提供，
在 profile patch 里再插一遍会重复。

校验 profile 现在的状态：

```bash
node tools/verify-profile.mjs
```

它同时验两件事：`cordis.patch.yml` 还解析得动（顶层是数组、没有残留的 insert），
以及 `package.json` 里插件确实登记在 `dsh.profile.bundles` 里。

## 卸载

```bash
dsh plugin --profile desktop rm dsh-workflow-studio
```

手工安装的话，反向做三步：删掉 `node_modules/dsh-workflow-studio`、
从 `dependencies` 与 `dsh.profile.bundles` 里删掉对应行。工作流文件
（`<DSH_HOME>/workflows/`）不会被卸载动到。

## 写一个工作流

放在 `<DSH_HOME>/workflows/<名字>.js`。名字只允许小写字母、数字、点、下划线、短横线。

```js
---
name: audit-docs
description: 审计 docs/ 下每个文件的准确性
whenToUse: 当需要批量核对文档时
phases:
  - title: 扫描
    detail: 列出待审计文件
  - title: 审计
    detail: 每个文件一个子智能体
graph:
  - id: scan
    label: 扫描目标
    phase: 扫描
  - id: audit
    label: 审计文件
    phase: 审计
    deps: [scan]
---
const files = args?.files ?? []
if (files.length === 0) return { error: '缺少 files 参数' }

phase('扫描')
const plan = await wfRun('scan', { label: '扫描目标', phase: '扫描' },
  `待审计的文件：\n${files.join('\n')}\n先给出每个文件的审计要点。`)

phase('审计')
const findings = await pipeline(files, async (file) =>
  wfRun('audit', { label: '审计文件', phase: '审计' },
    `审计 ${file}。协调者的要点：${plan}\n输出三段：结论 / 证据 / 建议。`))

return { total: files.length, findings: findings.filter(Boolean) }
```

### 脚本里能用的东西

官方引擎注入的六个钩子照旧可用：

| 钩子 | 作用 |
|---|---|
| `agent(prompt, opts?)` | 跑一个子智能体，返回它的最终文本（带 `opts.schema` 则返回校验过的对象；失败返回 `null`） |
| `pipeline(items, ...stages)` | 每个 item 独立走完所有 stage，**stage 之间没有栅栏** |
| `parallel(thunks)` | 并发跑一组零参函数并等齐（栅栏） |
| `phase(title)` | 推进阶段（纯展示，不改变执行） |
| `log(message)` | 一行叙述 |
| `args` | 调起时传的 JSON 参数 |

本插件额外注入四个**结构钩子**（只用 `log()` 通道上报，去掉也不影响脚本运行）：

| 钩子 | 作用 |
|---|---|
| `wfRun(id, spec, prompt, opts?)` | 声明一个节点并立刻跑一个子智能体；**最常用** |
| `wfNode(id, spec)` | 只声明节点（自己调 `agent()`） |
| `wfEdge(from, to, kind?)` | 显式声明一条边 |
| `wfGroup(id, spec)` | 声明一个逻辑分组 |

`spec` 支持：`label`（同时作为 agent 的 `label`，也是实例与声明节点的**绑定键**）、
`phase`、`deps`（上游节点 id 数组，自动生成边）、`group`、`kind`、`detail`、
`provider`、`model`。

> **`detail` 现在只进数据、不进画面。** 阶段下方那行说明文字已经去掉 ——
> 阶段头一行「名字 + 12/12」已经把该说的说完了，再垫一行小字只是噪音，
> 还会把这列的 pill 往下推。写在工作流里的 `detail` 仍然会被解析出来（`/run` 里看得到），
> 只是板面上不画。

> **绑定是按 label 的。** 一个逻辑节点可以有多个实例（`pipeline` 扇出）—— 绑定是多对一，
> 所以 `wfRun` 的 `spec.label` 要和同一个逻辑步骤的其它实例保持一致。
> 不写 `wfNode` / `wfRun` 也完全可以：宿主退化成「按阶段分组 + 时序推断」。

## 结构声明

结构可以写在 frontmatter 里（静态，界面在第一个子智能体启动前就有图可画），
也可以写在脚本里（动态），两者共用同一条绑定通道。两种写法都收：

```yaml
# 写法一：节点数组，边由 deps 推出来
graph:
  - id: scan
    label: 扫描目标
    phase: 扫描
  - id: audit
    label: 审计文件
    phase: 审计
    deps: [scan]
```

```yaml
# 写法二：显式 nodes + edges
graph:
  nodes:
    - { id: scan, label: 扫描目标, phase: 扫描 }
    - { id: audit, label: 审计文件, phase: 审计 }
  edges:
    - { from: scan, to: audit, kind: flow }
```

## 命令参考

```
/workflow <随便一句话>          把这句话原样交给模型：它定拓扑，再用 workflow 工具在后台启动
/workflow                      列出可用的工作流与在跑的运行
/workflow <已保存的名称> [JSON]  直接调起一份存好的工作流（后台跑，常驻条里看进度）
/workflow prompt <文本>         强制走「交给模型」那条路（万一名字和你想说的话撞了）
/workflow show [运行号]         看某个运行的阶段与子智能体
/workflow stop <运行号>         取消一个运行
/workflow reload               重新扫描工作流目录
/workflow help                 用法
```

运行号可以只给前 8 位。

> **`input.hint` 不是「提示文案」，是「这个命令接受参数」的开关。**
>
> DSH 客户端里 `desc.input !== void 0` 决定命令认不认领输入行：
>
> | | 有 `input` | 没有 `input` |
> |---|---|---|
> | 从菜单选中 | 进入参数输入态（`/goal` 就是这样） | **立即执行**（`/compact` 那样） |
> | 参数 | `line + args` 一起给到 handler | 永远是空串 |
> | 按 Tab | 补全 | **直接发送** |
>
> 我一度把它整个删掉（嫌那串用法说明糊在输入框上），结果把参数入口一起删了。
> 实测症状两条：`command/run` 事件里 args 全是空串；按 Tab 直接发送而不是补全。
> 宿主还硬性要求 hint 非空（`input hint must not be empty`），所以「留白」也不是选项。
>
> 结论：`input` 必须留着。hint 写**人话**，不写符号语法 —— 本插件用的是
> 「要做什么，或已有工作流的名字」。早先写的 `<一句话>|<名称> [JSON]` 是把内部语法
> 摊给用户看，而用户真正需要知道的只有一件事：这儿可以填什么。
> `test/check.mjs` 有一条断言盯死它，`tools/mutation-check.mjs` 验证过删掉它自检会红。
>
> **顺带一个做不到的事：`/` 菜单里的图标。** 菜单行只在 `item.icon !== undefined` 时
> 渲染图标（`dsh-client-ui-input-trigger` 里没有兜底），而 `icon` 只有两个来源：
> 官方六个命令名的**硬编码表**（`ui-commands` 的 `HOST_FACES`），以及客户端
> contribution。可 contribution 与宿主命令**同名会直接 throw**（会连带把整个菜单搞坏），
> 而且 contribution 只处理「裸命令」、带参数直接 fall through。
> 所以「能带参数的宿主命令」在菜单里注定没有图标 —— 这不是本插件能绕过的，
> 要么上游把 `HOST_FACES` 打开，要么放开同名限制。

### 两种发起方式的区别

| | `/workflow 帮我审一下今天的代码` | `/workflow codebase-audit {"files":[…]}` |
|---|---|---|
| 谁定拓扑 | 模型现场决定 | 你写在文件里 |
| 每次是否一样 | 不一定，看模型怎么拆 | 一样 |
| 适合 | 一次性的、说不准要拆几步的活 | 每周都要跑的固定流程 |
| 落到哪 | `workflow` 工具 + 你当场看到脚本 | 直接启动，脚本早就写好了 |

分流规则很简单：**第一个词能不能对上已保存的工作流名**。对上就直接跑，对不上就当你说了一句人话。

### 交给模型那条路到底发生了什么

1. `/workflow 帮我审一下今天的代码` 把 **`帮我审一下今天的代码`** 这一句原样注入当前会话，
   走官方 `sessionController.prompt`（与你自己在输入框里打字是同一条准入路径）。
2. 模型从**系统提示词**里知道「收到编排请求该怎么做」—— 见[工作原理](#工作原理)。
3. 模型在思考里定拓扑，写脚本，调 `workflow` 工具（默认 `run_in_background: true`）。
4. 运行开始后：常驻条出现，你可以**继续对话**，两者互不阻塞。

## 工作原理

```
                    ┌───────────────── 宿主半边（index.js）──────────────────┐
 /workflow <一句话> │ ctx.commands.register('workflow')                     │
      ─────────────▶│   └─ sessionController.prompt(用户原话)  ← 一个字不改  │
                    │        └─ 模型在思考里定拓扑 → 写脚本 → 调 workflow 工具 │
 /workflow <已存名> │                                                       │
      ─────────────▶│   └─ ctx.workflowEngine.start({script, meta, …})       │
                    │        └─ 脚本 = 结构前置代码 + 用户正文                │
                    │                                                       │
                    │ ctx.systemPrompt.section(WORKFLOW_SECTION)            │
                    │   「怎么做」全在这儿：拓扑在思考里定、用 wfRun 声明结构、│
                    │     默认 run_in_background（前台会占住整轮）            │
                    └────────────────────┬──────────────────────────────────┘
                                         │ 官方引擎执行
                    ┌────────────────────▼──────────────────────────────────┐
   workflow/start   │  workflow/phase · workflow/log                        │
   workflow/agent-* │  workflow/agent-start · workflow/agent-end            │
   workflow/end     │  workflow/end                                         │
                    └────────────────────┬──────────────────────────────────┘
                                         │ 全树广播，插件在根上下文订阅
                    ┌────────────────────▼──────────────────────────────────┐
                    │ host/runs.mjs —— 折叠成「运行模型」                    │
   session/event ──▶│  阶段 → 子智能体 → 逐条工作内容                        │
   （子会话的日志）  │  归属会话：从子会话 header 反推 parentSessionId         │
                    └────────────────────┬──────────────────────────────────┘
                                         │ HTTP：/state /run /node /diagnose
                    ┌────────────────────▼──────────────────────────────────┐
                    │ 客户端半边（client.js）                                │
                    │  常驻条（输入框上方）· 结构图 / 时间线 / 叙述 / 概览     │
                    │  点 pill ─▶ uiWorkspace.openSession(childId)          │
                    └───────────────────────────────────────────────────────┘
```

四条值得单独说的设计决定：

1. **工作内容来自子会话自己的日志。** `workflow/agent-start` 给出的 `childId` 就是一个真实
   的 SessionId；插件在根上下文订阅 `session/event`，按 `childId` 把正文、工具调用、
   工具结果路由回对应的节点。官方卡片只画状态，因为那只需要 `workflow/*` 一条流；
   要显示**内容**就必须订阅第二条流 —— 这是「看得见在写什么」的全部前提。

   不过这些内容**只经由官方会话窗口呈现**：点 pill 走 `uiWorkspace.openSession`，
   插件自己不画第二份转录。`GET /node` 仍然提供镜像出来的逐条内容（给别的消费者用），
   但界面不靠它。

2. **归属会话从子会话的 header 反推。** `workflow/start` 事件里没有「谁发起的」；
   命令那条路能从 `invocation.agent` 拿到，但模型用 `workflow` 工具起的运行拿不到。
   而每个子会话的 `header.parentSession` 都记着 —— 于是两条路统一了，
   常驻条也就能对模型起的运行一视同仁。

3. **结构边分三层，优先级从高到低。** 引擎事件里 agent 之间没有边，所以：
   脚本声明（`deps` / `wfEdge`）> 阶段分组（`phase`）> 时序推断（同阶段内，
   前一个彻底结束后才开始的判为串行）。**推断出来的边在界面上是虚线** ——
   不把推断当事实。

3. **布局是声明序，不跑图布局算法。** 阶段按 `meta.phases` 与首次出现的顺序排成一列；
   相邻两列的边画成直线（轨道段），跨列的边升到图上方绕过去（弧），
   回边按**方向**判定、从下方绕。弧的高度用区间图贪心着色分配：互不相干的弧同一高度，
   嵌套的弧里矮外高。零依赖、确定性、运行期不重排。

## 启用条件

- **必需**：`webServer`、`commands`（都在官方 base bundle 里，硬 inject）。
- **软依赖**：`workflowEngine`。它在官方组合里**不在根上下文** ——
  `plugin_manager` 里 `workflow-ptc` 与 `tool-workflow` 两行都是
  `enabled: false, fiberPhase: null`，它们随 **agent preset** 挂载。
  因此插件按「根上下文 → `agentPresets.serviceFor(agent, …)` → `agent.ctx` → 父链」
  四条路依次解析。实测官方桌面版走的是**第二条**。四条都不中时 `/workflow` 会
  **如实说找不到引擎**，而不是抛一个看不懂的错。
- **软依赖**：`sessionController`（宿主）。`/workflow <提示词>` 靠它把任务注入会话。
  取不到时那条路会失败，但 `/workflow <已保存名>` 照常工作 —— 因为它只需要引擎。

  > **调用它有个坑**：`SessionController.prompt(request, signal)` 的第二个参数是
  > **必传**的 `AbortSignal`（源码里 `signal.throwIfAborted()` 是无条件的，文档注释也写着
  > `@param signal`）。只传 request 的话报错是
  > `Cannot read properties of undefined (reading 'throwIfAborted')` ——
  > 从这句话完全看不出「少传了个参数」。`test/check.mjs` 里有一条专门的回归测试盯这件事，
  > 并且用 `tools/mutation-check.mjs` 验证过它**真的会红**。

- **软依赖**：`uiWorkspace`（客户端）。只用于「打开子会话」一个动作；
  取不到时界面提示一句，其余功能不受影响。
- 客户端半边只 inject `slots`。

两条自检：

```
GET /dsh-workflow-studio/api/diagnose
```

它会报出每条运行所属的会话、引擎是从哪条路解析到的（`engineVia`），以及
`sessionControllerAvailable` —— 这三样合起来能把「为什么启动不了」一次问清。

## 测试

```bash
node test/check.mjs              # 离线自检：46 项，不需要装进 profile
node tools/verify-live.mjs       # 端到端：另起一个隔离的宿主实例，打真实 HTTP 面
node tools/mutation-check.mjs    # 变异测试：确认回归测试真的会红
```

`test/check.mjs` 覆盖：frontmatter 解析器（YAML 子集）、脚本组装、运行登记处的事件折叠
（含工具调用去重、注入上下文的标类、**晚声明结构清掉时序边**）、宿主半边在桩上下文里的
装载与路由契约，以及客户端半边在**自带 React 替身**下的离线渲染 —— 阶段列 / 折叠展开 /
时间线 / 叙述 / 概览 / 常驻条各渲染一遍并断言内容，外加「点 pill 把 childId 交出去」与
「`openChildSession` 的成败契约」。

> 那个 React 替身不是凑数：`useState` 返回初值、`useEffect` 是空操作、只有 `useMemo`/
> `useCallback` 真跑。这样组件函数会被完整执行一遍，条件分支、文案、`data-*` 标记全都验得到，
> 而**不需要**本机存在 react（profile 里的 react 是 pnpm 的 junction，指向一个可能不存在的
> 目录 —— 依赖它，自检就会在别人机器上随机跳过）。

### 需要 DSH 安装目录的工具

`tools/` 下有一组开发/排障脚本。凡是需要读 `app.asar` 的，都要先告诉它 DSH 装在哪 ——
那是机器相关的，不写在仓库里：

```powershell
$env:DSH_INSTALL = "D:\DeepSeek Harness"   # 或者只给 $env:DSH_ASAR = "...\resources\app.asar"
```

| 脚本 | 作用 |
|---|---|
| `peek.mjs <包名> <lib 内文件> <正则>` | 从 asar 里抠出某个官方包的文件并按正则扫描 |
| `slice.mjs <包名> <lib 内文件> <起> <止>` | 打印某个文件的指定行区间 |
| `find-css-var.mjs` | 字节级搜索 asar，把 CSS 变量的**定义处**与**引用处**分开报 |
| `verify-profile.mjs` | 校验 profile 的 `cordis.patch.yml` 与 `package.json` 仍可解析、插件仍登记在 bundle 里 |
| `probe-host.mjs` / `verify-live.mjs` | 另起一个换端口、换 `DSH_HOME` 的宿主实例做端到端验证 |
| `inspect-session-log.mjs` / `inspect-commands.mjs` | 解开多帧 zstd 会话日志，列出每一次命令执行的命令名、参数与结果 |

路径统一从 `tools/paths.mjs` 推导：**插件自己的位置**从 `import.meta.url` 推（永远正确），
**DSH 装在哪**从环境变量取（取不到就报错并告诉你怎么设，而不是用一个写死的默认值
悄悄跑出莫名其妙的结果）。

### 变异测试：为什么必须有它

`tools/mutation-check.mjs` 把三处修过的缺陷**改回坏的样子**，确认自检确实变红：

```
✓ sessionController.prompt 少传 signal          改坏后自检变红：通过 45 项，失败 1 项
✓ inferEdges 的清理写在早退之后（死代码）        改坏后自检变红：通过 45 项，失败 1 项
✓ PhaseLink 忽略 inferred（推断边被画成实线）    改坏后自检变红：通过 45 项，失败 1 项
```

**它不是形式主义 —— 它当场抓到过一条假测试。** 「阶段连线的虚实」那条断言原本写的是
`includes('data-edge="0"')`，而那个字符串是**另一条**连线（本来就无依赖的那条）贡献的，
所以无论推断边怎么画它都成立。改成断言**同一条连线上的两个属性连在一起**
（`data-edge="0" data-inferred="1"`）之后才真的有效。

`tools/verify-live.mjs` 会另起一个**换端口、换 `DSH_HOME`** 的宿主实例
（官方端口 19387 被正在运行的实例占着），因此不会碰到用户正在用的那个：

```
通过 46 项，失败 0 项     ← test/check.mjs
通过 21 项，失败 0 项     ← tools/verify-live.mjs
```

## 已知限制

1. **装完必须重启 DSH。** 宿主半边是宿主启动时加载的一部分。运行中的宿主**不会**热启动
   一个新插入的插件行 —— 它的配置重载明确要求「不引入新的 inactive 条目」，
   而新插入的条目必然先是 inactive。实测：往 profile patch 里插入后条目出现在
   `listConfigs` 里但状态是 `inactive`，`/info` 一直 404；移除再插入也一样。
   （另有一个坑：**Node 会缓存失败的 import**。第一次尝试时模块里有个写错的 import，
   修好之后同一个宿主进程内无论怎么重试都还是「failed to import」，只有重启才清掉。）

   顺带：改完宿主半边也要重启。官方 `hmr` 只热重载**模块**，不会重新执行 `apply()`。
   客户端半边刷新页面即可（bundle 是按需从磁盘取的）。

2. **一次运行里，逻辑节点与实例的绑定按 `label` 匹配。** 两个不同的逻辑节点用同一个
   `label` 且同一个 `phase` 时会被判成同一个。这是刻意的取舍：并发下按声明顺序绑定会
   随机错配，那比不绑更糟。

3. **只画声明的阶段依赖，不画推断的。** 宿主仍然会按时序推断节点级的边，但板面只画
   **阶段之间**的声明边（实线）与「相邻 / 推断」（淡虚线）。理由：一枚 pill 就是一个实例，
   在同一列里画实例之间的箭头会立刻变成一团乱麻，而读者真正要判断的「是不是真并行」
   由「时间线」那一页回答得更准。声明不全时，未声明的实例之间不再有任何线。

4. **常驻条只显示本会话最近的一次运行。** 更早的、别的会话的运行在侧栏面板里看。
   本会话没有任何运行时，整条不出现。

5. **点 pill 会离开当前视图。** 跳去子智能体会话后，工作台面板不再处于前台；
   要回来重新点侧栏图标。之所以这么设计而不是就地展开，是因为官方会话窗口
   在完整性、流式、冷恢复上都比插件能给的强，没有理由再镜像一份。

6. **正文有上限。** 每个节点最多保留 500 条内容、单个文本块最多 6000 字；
   超限时丢弃最早的并在流里留一条提示（不静默截断）。

7. **运行记录只保留最近 60 次**，且只在内存里 —— 宿主重启后工作台是空的。
   真相在会话日志里（`tool-workflow/*` 记录仍然写入了发起会话，官方会话内卡片照常显示）。

8. **`uiWorkspace` 取不到时点 pill 不会有反应**，只会在条上提示一句。
   客户端半边只 inject `slots`，`uiWorkspace` 是软取的 —— 这样它在别的组合里缺席时，
   整个面板不会跟着一起不出现。

9. **本机 pnpm 装不动**（见[安装](#安装)）—— 与插件无关，是 profile 里一条指向已删除目录的
   `file:` 依赖导致的。

## 致谢

界面与交互的形制大量借自 [ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）：

- **视觉词汇**（一个阶段是一列、一个子智能体是一枚 pill、只有一种箭头语义「在它之后运行」、
  颜色只编码状态、布局用声明序而不跑图算法）来自 `packages/ui/src/components/workflow-timeline/`；
- **阶段的 `12/12` 分数**、**每列钉住 N 枚后折成「还有 N 个」+ 叠三张脸**、
  **reduced-motion 覆盖**，同样来自那里（`roster-model.ts` 的 `ROSTER_PINS_CARD` / `ROSTER_DECK`）；
- **`/workflow [提示词]` 的语义**（命令不跑工作流，只把任务说清楚，编排交给模型）
  来自 `apps/zcode-cli/packages/bootstrap/src/builtin-workflow-command.ts`。

三处**刻意的不一样**：

1. ZCode 那套图是**静态分析产物**（提交时解析出来的因果图），本插件的板面是**运行时的实时投影** ——
   pill 会亮、会完成、点开是那个子智能体此刻正在写的东西；
2. ZCode 的阶段之间画的是控制流，本插件只画**脚本声明过的依赖**（实线）与「相邻 / 推断」（淡虚线）——
   猜出来的东西不画成实线；
3. ZCode 把子智能体的转录渲染在聊天卡里，本插件**不镜像转录**：点 pill 走
   `uiWorkspace.openSession` 跳进官方原生会话窗口。ZCode 之所以要自己画，是因为它的
   actor 会话不在既有的会话面板里；DSH 里子会话本来就是一个普通会话，复用比复刻强。

引擎、事件、会话、命令注册、系统提示词、槽位、`conversation.input.dock` 全部是 DeepSeek Harness
官方能力，本插件只做投影与呈现。

## 许可

MIT
