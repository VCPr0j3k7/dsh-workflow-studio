/**
 * dsh-workflow-studio 的 client 半边。
 *
 * ## 装载协议
 *
 * 与官方客户端插件逐字相同：由 `@deepseek-ai/dsh-client-modules` 提供给浏览器，
 * 协议是 `window.__ModuleLoader__.load({ id, factory })`。`id` 必须是**包名**，
 * 宿主半边 `/info` 的 `plugin` 字段也是它 —— 客户端靠这个比对确认「连上的是自己的宿主」。
 *
 * ## 视觉词汇（照搬 ZCode 的 causality graph，刻意做小）
 *
 *   - 一个**模块** = 一个阶段（phase）
 *   - 一张**卡** = 这个阶段里的一个参与者（一个子智能体）
 *   - 折叠的模块 = 该阶段参与者的牌堆
 *   - 一条**箭头** = 「在它之后运行」
 *
 * ZCode 把这套词汇写在一行注释里，并刻意只保留这五种元素。这里照做，理由相同：
 * 图上的每一笔都必须对应一个可以讲清楚的事实，否则图会变成装饰。
 *
 * 与 ZCode 的差别只有一处，但很关键：**ZCode 的图是静态分析产物**（脚本解析出来的
 * 因果图），本插件的图是**运行时的实时投影** —— 节点会亮、会完成、卡片点开是那个
 * 子智能体此刻正在写的东西。官方 DSH 的会话内卡片只有「阶段 → 成员」两层的状态列表，
 * 既没有结构边，也没有内容；这两件事正是本插件补的。
 *
 * ## 三种视图
 *
 *   1. **结构图**：阶段模块 + 参与者卡 + 「在它之后运行」的箭头；
 *   2. **时间线**：每个子智能体一条泳道，横轴是时间 —— 并行的会重叠，串行的会错开；
 *   3. **叙述**：脚本自己 `log()` 出来的进度行，加上阶段推进的时间戳。
 *
 * 右侧详情面板显示选中子智能体的**逐条工作内容**（提示词、正文、工具调用、工具结果），
 * 随运行实时增长。
 */

window.__ModuleLoader__.load({
	id: "dsh-workflow-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;
		const useRef = react.useRef;
		const useCallback = react.useCallback;
		const useMemo = react.useMemo;

		// 自检：把「插件代码已执行」写入浏览器控制台。缺少这一步时，「界面没有出现」
		// 容易被误判为槽位问题，而实际原因可能只是 bundle 未被取走。
		try {
			console.log("[dsh-workflow-studio] client factory 已执行");
		} catch {
			// 忽略
		}

		//#region 样式

		/*
		 * 变量全部来自官方主题（可用 cordis_inspect_query 的 Theme.listTokens 核对）。
		 * 一个原则：颜色只编码**状态**（运行中/完成/失败/取消），身份靠卡片上的名字承载 ——
		 * 与 ZCode 的 laneClass 注释同一条理由：给每个参与者一个色相，图会花掉且没有信息量。
		 */
		const CSS = `
.wfs-root{--wfs-mono:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Consolas,monospace);display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}

/* ── 头部 ─────────────────────────────────────────── */
.wfs-head{display:flex;align-items:center;gap:10px;padding:16px 20px 12px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.wfs-title{font-size:16px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px;flex:none}
.wfs-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}
.wfs-spacer{flex:1;min-width:8px}
.wfs-tabs{display:flex;gap:2px;padding:0 20px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1)}
.wfs-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.wfs-tab:hover{color:var(--dsw-alias-label-primary)}
.wfs-tab[data-on="1"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}
.wfs-tab-count{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}

/* ── 控件 ─────────────────────────────────────────── */
.wfs-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:0 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .14s,border-color .14s,opacity .14s}
.wfs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wfs-btn:disabled{opacity:.42;cursor:not-allowed}
.wfs-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff);font-weight:500}
.wfs-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));filter:brightness(1.06)}
.wfs-btn-danger{color:var(--dsw-alias-state-error-primary)}
.wfs-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.wfs-btn-sm{min-height:26px;padding:0 9px;font-size:12px;border-radius:7px}
.wfs-select{min-height:30px;max-width:340px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;cursor:pointer}

/* ── 主体 ─────────────────────────────────────────── */
.wfs-body{flex:1;min-height:0;display:flex;overflow:hidden}
.wfs-main{flex:1;min-width:0;min-height:0;overflow:auto;position:relative}
/* 右侧概览栏：**按容器比例伸缩**，不写死像素。
 * 早期版本是 width:390px —— 在宽窗口里显得又宽又空，在窄窗口里又把板面挤没。
 * 现在跟着容器走（26%），并夹在 240~360px 之间：窄屏不至于挤没板面，宽屏也不会无限拉宽。 */
.wfs-side{flex:0 1 26%;min-width:240px;max-width:360px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1)}
.wfs-empty{color:var(--dsw-alias-label-tertiary);padding:60px 20px;text-align:center;font-size:13px}
.wfs-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px;padding:10px 20px;white-space:pre-wrap;word-break:break-word}

/* 状态点：颜色只编码状态。
 * running 用「活动色」（warn）而不是品牌色 —— 与 ZCode 同一条理由：品牌色跨主题会反色
 * （亮色主题下近黑），读起来是」强调」而不是「在动」。
 * pending 是**空心**的：它表示」一个真实的实例在排队」，与「这里什么都没有」（不画点）不同。 */
.wfs-dot{width:7px;height:7px;border-radius:50%;flex:none;box-sizing:border-box;background:var(--dsw-alias-label-tertiary,currentColor)}
.wfs-dot[data-s="running"]{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-brand-primary));animation:wfs-pulse 1.4s ease-in-out infinite}
.wfs-dot[data-s="completed"]{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))}
.wfs-dot[data-s="failed"]{background:var(--dsw-alias-state-error-primary)}
.wfs-dot[data-s="cancelled"]{background:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-tertiary))}
.wfs-dot[data-s="pending"]{background:transparent;border:1.5px solid var(--dsw-alias-label-tertiary,currentColor)}
@keyframes wfs-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){
  .wfs-dot[data-s="running"],.wfs-tl-bar[data-s="running"]{animation:none}
  .wfs-pill,.wfs-btn{transition:none}
}

/* ── 时间线 ───────────────────────────────────────── */
.wfs-timeline{padding:18px 20px 40px;min-width:min-content}
.wfs-tl-row{display:flex;align-items:center;gap:10px;height:26px}
.wfs-tl-name{width:190px;flex:none;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:6px}
.wfs-tl-track{position:relative;flex:1;min-width:420px;height:16px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent)}
.wfs-tl-bar{position:absolute;top:2px;height:12px;border-radius:3px;background:var(--dsw-alias-brand-primary);opacity:.85;min-width:3px;cursor:pointer}
.wfs-tl-bar[data-s="completed"]{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))}
.wfs-tl-bar[data-s="failed"]{background:var(--dsw-alias-state-error-primary)}
.wfs-tl-bar[data-s="cancelled"]{background:var(--dsw-alias-state-idle-primary,var(--dsw-alias-label-tertiary))}
.wfs-tl-bar[data-s="running"]{background:var(--dsw-alias-state-warn-primary,var(--dsw-alias-brand-primary))}
.wfs-tl-bar[data-s="running"]{animation:wfs-pulse 1.4s ease-in-out infinite}
.wfs-tl-axis{display:flex;gap:10px;margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-family:var(--wfs-mono)}
.wfs-tl-ticks{position:relative;flex:1;min-width:420px;height:16px}
.wfs-tl-tick{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}
.wfs-tl-phase{display:flex;gap:10px;margin-top:14px;margin-bottom:4px;align-items:center}
.wfs-tl-phase-label{width:190px;flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}

/* ── 叙述 ─────────────────────────────────────────── */
.wfs-log{padding:16px 20px 40px;font-family:var(--wfs-mono);font-size:11.5px;line-height:1.75}
.wfs-log-row{display:flex;gap:12px;padding:1px 0}
.wfs-log-time{color:var(--dsw-alias-label-tertiary);flex:none;width:74px}
.wfs-log-phase{color:var(--dsw-alias-brand-primary);font-weight:600}
.wfs-log-text{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;min-width:0}

/* ── 详情面板 ─────────────────────────────────────── */
.wfs-side-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.wfs-side-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfs-side-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 28px}
.wfs-kv{display:flex;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-bottom:5px;align-items:baseline}
.wfs-kv-k{flex:none;width:52px}
.wfs-kv-v{color:var(--dsw-alias-label-secondary);word-break:break-all;min-width:0}
.wfs-sec{margin-top:14px}
.wfs-sec-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.03em;margin-bottom:7px;display:flex;align-items:center;gap:6px}
/* 概览栏里的正文段。逐条转录的样式（.wfs-entry / -kind / data-mono）已随内联面板一起删掉 ——
 * 点 pill 现在是跳去子智能体自己的会话窗口，插件不再镜像转录。 */
.wfs-entry-text{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;line-height:1.65}
.wfs-more{color:var(--dsw-alias-label-tertiary);font-size:11.5px;padding:6px 0}

/* ── 工作流库 ─────────────────────────────────────── */
.wfs-lib{padding:18px 20px 40px}
.wfs-lib-item{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:13px 15px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.wfs-lib-name{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wfs-lib-desc{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin-top:6px;line-height:1.65}
.wfs-lib-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:8px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
.wfs-tag{display:inline-flex;align-items:center;border-radius:6px;padding:1px 7px;font-size:10.5px;line-height:17px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wfs-tag-brand{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary);font-weight:500}
.wfs-code{margin:9px 0 0;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-base));font-family:var(--wfs-mono);font-size:11px;line-height:1.6;max-height:260px;overflow:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}

/* ════════════════════════════════════════════════════════════════════════
   板面：阶段列 + 子智能体 pill + 阶段连线
   —— 视觉词汇照搬 ZCode 的 workflow timeline（刻意的做小）：
      一个阶段是一列 · 一个子智能体是一枚 pill · 阶段之间一条线表示」在它之后运行」
   ════════════════════════════════════════════════════════════════════════ */
.wfs-board{display:flex;align-items:flex-start;gap:0;min-width:min-content}
.wfs-board-col{display:flex;flex-direction:column;gap:7px;width:212px;flex:none;min-width:0}
.wfs-board-head{display:flex;align-items:center;gap:7px;height:26px;padding:0 2px;min-width:0}
.wfs-board-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.wfs-board-frac{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;font-family:var(--wfs-mono)}
/* 阶段说明文字不再渲染（见 PhaseColumn 里的注释）。这条规则留着只为兼容旧产物。 */
.wfs-board-detail{display:none}
.wfs-board-body{display:flex;flex-direction:column;gap:5px;min-height:26px}
/* 阶段之间的连线：画在阶段头那一行的高度上。有声明边 → 实线；没有 → 淡虚线。 */
.wfs-board-link{width:26px;flex:none;height:26px;display:flex;align-items:center;justify-content:center;position:relative}
.wfs-board-link::before{content:"";display:block;width:100%;height:1px;background:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}
.wfs-board-link[data-edge="0"]::before{background:repeating-linear-gradient(to right,var(--dsw-alias-border-l1) 0 4px,transparent 4px 8px)}
.wfs-board-link[data-back="1"]::after{content:"↺";position:absolute;font-size:10px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base);padding:0 2px}

/* ── 子智能体 pill ─────────────────────────────────── */
.wfs-pill{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 9px 0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;cursor:pointer;text-align:left;transition:background .13s,border-color .13s}
.wfs-pill:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.wfs-pill-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfs-pill[data-s="pending"] .wfs-pill-label{color:var(--dsw-alias-label-secondary)}
.wfs-pill-tail{flex:none;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.wfs-pill:hover .wfs-pill-tail{color:var(--dsw-alias-label-primary)}
.wfs-pill-seq{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--wfs-mono)}

/* 头像方块：颜色只用来区分「这是不同的实例」，不编码状态 —— 状态由右下角的点承担 */
.wfs-avatar{width:22px;height:22px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#fff;position:relative;letter-spacing:0}
.wfs-avatar[data-i="0"]{background:hsl(212 68% 52%)}
.wfs-avatar[data-i="1"]{background:hsl(26 80% 52%)}
.wfs-avatar[data-i="2"]{background:hsl(160 58% 40%)}
.wfs-avatar[data-i="3"]{background:hsl(268 58% 60%)}
.wfs-avatar[data-i="4"]{background:hsl(342 66% 55%)}
.wfs-avatar[data-i="5"]{background:hsl(190 66% 42%)}
.wfs-avatar[data-i="6"]{background:hsl(46 76% 46%)}
.wfs-avatar[data-i="7"]{background:hsl(300 44% 54%)}
.wfs-avatar[data-i="8"]{background:hsl(104 44% 42%)}

/* 」还有 N 个」那一行：叠三张脸 + 计数 */
.wfs-pill-more{background:transparent;border-style:dashed;color:var(--dsw-alias-label-tertiary);gap:6px}
.wfs-pill-more:hover{color:var(--dsw-alias-label-primary)}
.wfs-stack{display:flex;flex:none;padding-left:2px}
.wfs-stack .wfs-avatar{width:18px;height:18px;border-radius:5px;font-size:9px;margin-left:-6px;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1)}
.wfs-stack .wfs-avatar:first-child{margin-left:0}

/* ── 板面容器（主面板里用） ─────────────────────────── */
.wfs-board-wrap{padding:18px 20px 40px;min-width:min-content}

/* ── 输入框上方的常驻条 ─────────────────────────────── */
/*
 * ## 宽度必须自己算，槽位不会替你算
 *
 * conversation.input.dock 是**全宽槽位**。每个条目要自己把 composer 的
 * clearance / inset 减掉，才能和输入框左右对齐 —— 官方 goal bar 就是这么做的
 * （dsh-client-ui-goal 的 .dock，以及 dsh-client-ui-conversation 里
 * 每一个 dock 条目，都是同一个公式）：
 *
 *   width: calc(100% - 2×side-clearance - 4×dock-inset); margin: 0 auto;
 *
 * 我原来什么都没减，于是这条比输入框宽出两圈 —— 就是「宽度不对」的全部原因。
 *
 * 变量全部带 0px 兜底：万一某个组合没定义它们，退化成原来的行为，
 * 而不是把 calc 算成 0 让整条消失。
 *
 * 注意：CSS 是模板字符串，这段注释里**不能出现反引号** —— 写了一个就会提前结束
 * 字符串，整个 client.js 语法错误。（第一次改这里时就是这么挂的，报错还指向别处。）
 */
.wfs-dock{
  box-sizing:border-box;
  width:calc(100%
    - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px)
    - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px)
    - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));
  max-width:calc(var(--dsh-composer-card-max-width,100vw) - 4 * var(--dsh-composer-dock-inset,0px));
  margin:0 auto 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;
}
.wfs-dock-head{box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;min-height:38px;padding:0 12px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;cursor:pointer;text-align:left}
.wfs-dock-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wfs-dock-title{font-weight:600;flex:none}
.wfs-dock-name{color:var(--dsw-alias-label-secondary);font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wfs-dock-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;font-variant-numeric:tabular-nums}
/*
 * 箭头方向：**收起时朝上、展开时朝下**。
 * 这条条挂在输入框上方，内容是从头部**往下**铺到输入框那侧的 ——
 * 所以」朝下」表示「已经铺开了」，」朝上」表示「折着，点开往下铺」。
 * （官方两种约定都有：」ui-jobs「 的 」.triggerOpen{rotate(180deg)}「 与
 *   」.sectionChevron{-90deg → none}「。这里按用户实际观感选的后者。）
 */
.wfs-dock-chevron{flex:none;display:flex;color:var(--dsw-alias-label-tertiary);transition:transform .16s;transform:rotate(180deg)}
.wfs-dock-chevron[data-open="1"]{transform:none}
.wfs-dock-body{padding:4px 12px 12px;max-height:46vh;overflow:auto}
.wfs-dock-panel{margin-top:9px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:9px}
@media (prefers-reduced-motion:reduce){.wfs-dock-chevron{transition:none}}
`;

		/*
		 * 样式注入。
		 *
		 * 官方前端没有稳定的类名，也没有「插件样式」这条通道，所以自己往 head 里挂一个
		 * `<style>`。用 `data-plugin-css` 做去重标记：插件被热重载或页面里出现第二份
		 * 实例时不会叠加两份样式（叠加会让同名规则互相覆盖，症状很难查）。
		 *
		 * 注意：CSS 是模板字符串，里面**不能出现反引号** —— 会提前结束字符串，
		 * 让整个 client.js 语法错误，而报错信息只会指向文件末尾。
		 */
		const STYLE_TAG_ID = "dsh-workflow-studio/styles.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-workflow-studio";
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		//#endregion

		//#region 宿主通道

		const ROUTE_PREFIX = "/dsh-workflow-studio/api";
		/*
		 * 页面来源有三种可能：宿主自己的 HTTP 地址 / 外壳自定义 scheme / **不透明来源**
		 * （`location.origin === "null"`）。不要赌一条：按顺序试，用返回**内容**判定哪条真通 ——
		 * 只看「拿到 200」不够，SPA 兜底路由会把未知路径也回成 200 + HTML。
		 */
		const BASE_CANDIDATES = ["", "http://dsh.internal"];

		let resolvedBase = null;
		let probing = null;

		async function probeBase(candidate) {
			try {
				const response = await fetch(candidate + ROUTE_PREFIX + "/info", {
					method: "GET",
					headers: { accept: "application/json" },
					cache: "no-store",
				});
				if (response.ok !== true) return false;
				const payload = await response.json();
				return payload?.ok === true && payload?.data?.plugin === "dsh-workflow-studio";
			} catch {
				return false;
			}
		}

		async function hostBase() {
			if (resolvedBase !== null) return resolvedBase;
			if (probing === null) {
				probing = (async () => {
					for (const candidate of BASE_CANDIDATES) {
						if (await probeBase(candidate)) return candidate;
					}
					return "";
				})();
			}
			const settled = await probing;
			probing = null;
			resolvedBase = settled;
			try {
				console.log("[dsh-workflow-studio] 宿主基址 = " + (settled === "" ? "（相对路径）" : settled));
			} catch {
				// 控制台不可用就算了
			}
			return settled;
		}

		async function request(method, path, body) {
			const base = await hostBase();
			try {
				const response = await fetch(base + ROUTE_PREFIX + path, {
					method,
					headers: body === undefined ? undefined : { "content-type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				const text = await response.text();
				let payload = null;
				try {
					payload = JSON.parse(text);
				} catch {
					payload = null;
				}
				if (payload === null || typeof payload !== "object") {
					return { ok: false, error: `宿主返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}` };
				}
				return payload;
			} catch (error) {
				return { ok: false, error: String((error && error.message) || error) };
			}
		}

		/** 把 `{ok,data|error}` 归一成 `{ok,data,error}`。 */
		async function call(work) {
			try {
				const result = await work();
				if (result === null || result === undefined) return { ok: false, error: "宿主没有返回结果" };
				if (result.ok === false) return { ok: false, error: String(result.error ?? "未知错误") };
				return { ok: true, data: result.data ?? result };
			} catch (error) {
				return { ok: false, error: String((error && error.message) || error) };
			}
		}

		const api = {
			state: (since) => call(() => request("GET", `/state?since=${String(since)}`)),
			run: (id, content) => call(() => request("GET", `/run?id=${encodeURIComponent(id)}&content=${content ? "1" : "0"}`)),
			node: (runId, seq) => call(() => request("GET", `/node?run=${encodeURIComponent(runId)}&seq=${String(seq)}`)),
			library: () => call(() => request("GET", "/library")),
			libraryItem: (name) => call(() => request("GET", `/library/item?name=${encodeURIComponent(name)}`)),
			start: (name, args, parentSessionId) => call(() => request("POST", "/run", { name, args, parentSessionId })),
			cancel: (runId) => call(() => request("POST", "/cancel", { runId })),
			forget: (runId) => call(() => request("POST", "/forget", { runId })),
			logs: () => call(() => request("GET", "/logs?limit=200")),
		};

		//#endregion

		//#region 展示辅助

		const STATUS_LABEL = {
			running: "运行中",
			completed: "已完成",
			failed: "失败",
			cancelled: "已取消",
			pending: "等待中",
			interrupted: "已中断",
		};

		function statusLabel(status) {
			return STATUS_LABEL[status] ?? String(status ?? "未知");
		}

		function duration(from, to) {
			if (typeof from !== "number") return "-";
			const ms = Math.max(0, (typeof to === "number" ? to : Date.now()) - from);
			if (ms < 1000) return `${String(ms)}ms`;
			if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
			const minutes = Math.floor(ms / 60000);
			return `${String(minutes)}m${String(Math.round((ms % 60000) / 1000))}s`;
		}

		function clockTime(time) {
			try {
				return new Date(time).toLocaleTimeString();
			} catch {
				return "-";
			}
		}

		function firstLine(text, limit) {
			const value = String(text ?? "").replace(/\s+/g, " ").trim();
			return value.length > limit ? `${value.slice(0, limit)}…` : value;
		}

		/** 一组实例的聚合状态：全完成 → completed；有失败 → failed；有运行 → running；否则 cancelled。 */
		function rollup(instances) {
			if (instances.length === 0) return "pending";
			if (instances.some((node) => node.status === "running")) return "running";
			if (instances.some((node) => node.status === "failed")) return "failed";
			if (instances.every((node) => node.status === "completed")) return "completed";
			if (instances.some((node) => node.status === "completed")) return "running";
			return "cancelled";
		}

		function useNowTicker(active) {
			const [, force] = useState(0);
			useEffect(() => {
				if (active !== true) return undefined;
				const timer = window.setInterval(() => force((value) => value + 1), 1000);
				return () => window.clearInterval(timer);
			}, [active]);
		}

		//#endregion

		//#region 板面投影

		/**
		 * 把一次运行投影成「阶段列 + 子智能体 pill + 阶段之间的边」。
		 *
		 * 视觉词汇照搬 ZCode 的 workflow timeline，刻意做小：
		 *   一个阶段 = 一列 · 一个子智能体 = 一枚 pill · 阶段之间一条线 = 「在它之后运行」
		 *
		 * 与早期版本的关键差别：**一枚 pill 就是一个子智能体实例**，而不是「一张卡 = 一个逻辑
		 * 节点 + 若干实例片」。后者在 pipeline 扇出时把 12 个子智能体压成一张写着「12 个实例」
		 * 的卡，读者要再点一次才知道谁是谁；而看工作流的人第一眼想知道的恰恰是
		 * 「这一阶段到底派了哪些人」。
		 */
		function projectBoard(run) {
			if (run === null) return { phases: [], links: [], total: 0, settled: 0 };

			const order = [];
			const map = new Map();
			const ensure = (title) => {
				const key = title === null || title === undefined ? "" : String(title);
				let entry = map.get(key);
				if (entry === undefined) {
					entry = { key, title: key === "" ? "(未分阶段)" : key, detail: null, pills: [] };
					map.set(key, entry);
					order.push(key);
				}
				return entry;
			};

			// meta.phases 先定列顺序与说明，即使该阶段还没有实例
			for (const phase of run.phases ?? []) {
				const entry = ensure(phase.title);
				if (typeof phase.detail === "string") entry.detail = phase.detail;
			}
			for (const node of run.nodes ?? []) ensure(node.phase).pills.push(node);

			const phases = [];
			for (const key of order) {
				const entry = map.get(key);
				entry.pills.sort((left, right) => left.startedAt - right.startedAt || left.seq - right.seq);
				/*
				 * 同一列里出现重名时补一个 #seq 尾巴。
				 * pipeline 扇出的实例 label 全都一样，不加这个尾巴，一列五枚 pill 长得一模一样，
				 * 点开哪一个全靠猜。
				 */
				const counts = new Map();
				for (const pill of entry.pills) counts.set(pill.label, (counts.get(pill.label) ?? 0) + 1);
				phases.push({
					key: entry.key,
					title: entry.title,
					detail: entry.detail,
					pills: entry.pills.map((pill) => ({ ...pill, duplicate: (counts.get(pill.label) ?? 0) > 1 })),
					observed: entry.pills.length,
					settled: entry.pills.filter((pill) => pill.endedAt !== null).length,
					status: rollup(entry.pills),
				});
			}

			/*
			 * 阶段之间的边：把节点级的边「商掉」到阶段级。
			 *
			 * 引擎事件里 agent 之间没有边，边来自脚本声明（deps / wfEdge）或时序推断，
			 * 端点都是**节点**（declaredId 或 seq:N）。这里把每个端点解析到它所在的阶段，
			 * 于是 12 条节点级的边塌缩成「扫描 → 审计」这样一条列间的线 —— 这正是 ZCode
			 * 说的「模块之间的箭头是控制流的阶段商」。列内不画边：同一列的人本来就并排站着。
			 */
			const phaseOfEndpoint = (endpoint) => {
				const raw = String(endpoint ?? "");
				if (raw.startsWith("seq:")) {
					const seq = Number(raw.slice(4));
					const node = (run.nodes ?? []).find((item) => item.seq === seq);
					return node === undefined ? null : String(node.phase ?? "");
				}
				const spec = (run.declaredNodes ?? []).find((item) => String(item.id) === raw);
				if (spec !== undefined && typeof spec.phase === "string") return spec.phase;
				// 声明节点没写 phase 时，看绑到它的实例落在哪一列
				const bound = (run.nodes ?? []).find((item) => String(item.declaredId) === raw);
				return bound === undefined ? null : String(bound.phase ?? "");
			};

			const seen = new Set();
			const links = [];
			for (const edge of run.edges ?? []) {
				const from = phaseOfEndpoint(edge.from);
				const to = phaseOfEndpoint(edge.to);
				if (from === null || to === null || from === to) continue;
				const id = `${from}\u0000${to}`;
				if (seen.has(id)) continue;
				seen.add(id);
				links.push({
					id,
					from,
					to,
					back: order.indexOf(to) <= order.indexOf(from),
					inferred: edge.inferred === true,
				});
			}

			return {
				phases,
				links,
				total: phases.reduce((sum, phase) => sum + phase.observed, 0),
				settled: phases.reduce((sum, phase) => sum + phase.settled, 0),
			};
		}

		/** 相邻两列之间有没有声明的边（决定连线画实线还是淡虚线）。 */
		function linkBetween(board, fromKey, toKey) {
			return board.links.find((link) => link.from === fromKey && link.to === toKey) ?? null;
		}

		//#endregion

		//#region 板面

		const AVATAR_SLOTS = 9;
		/** 一列里先显示几枚 pill，其余折进「还有 N 个」。与 ZCode 的 ROSTER_PINS_CARD 同值。 */
		const PILL_PINS = 5;
		/** 「还有 N 个」那一行上叠几张脸。 */
		const STACK_FACES = 3;

		function avatarIndex(seq) {
			return Math.abs(Number(seq) || 0) % AVATAR_SLOTS;
		}

		/** 头像里的字：标签的首个字符（按码点取，免得把 emoji 切成半个）。 */
		function avatarGlyph(pill) {
			const label = String(pill.label ?? "").trim();
			if (label === "") return `#${String(pill.seq)}`;
			return Array.from(label)[0];
		}

		const STATUS_WORD = {
			running: "工作流进行中",
			completed: "工作流已完成",
			failed: "工作流失败",
			cancelled: "工作流已取消",
		};

		/**
		 * 打开一个子智能体自己的会话窗口。
		 *
		 * 与 DSH 顶部的子智能体下拉菜单点进去是同一个落点（`ctx.uiWorkspace.openSession`），
		 * 也与官方 `dsh-client-ui-workflow-run` 的「点成员开子会话」同一条路。
		 *
		 * ## 为什么抽成纯函数
		 *
		 * 只为一件事：让「点 pill → 用 childId 调 openSession」这条契约**能被离线断言**。
		 * 组件的 onClick 在离线渲染里点不到（React 替身不派发事件），但这条函数可以。
		 * 而这个契约恰好是「点开看内容」的全部 —— 写错了界面不会报错，只会什么都不发生。
		 *
		 * 软取而不是 inject（见 inject 处的说明）：取不到时返回 false，由调用方如实告诉用户，
		 * **不假装成功**。
		 *
		 * @param {object|null} hostCtx 客户端插件上下文
		 * @param {string} childId 子智能体的 SessionId
		 * @returns {boolean} 是否真的打开了
		 */
		function openChildSession(hostCtx, childId) {
			if (childId === null || childId === undefined || childId === "") return false;
			let workspace = null;
			try {
				workspace = hostCtx === null || hostCtx === undefined ? null : (hostCtx.get?.("uiWorkspace") ?? null);
			} catch {
				workspace = null;
			}
			if (workspace === null || typeof workspace.openSession !== "function") return false;
			try {
				workspace.openSession(childId);
				return true;
			} catch {
				return false;
			}
		}

		function ChevronIcon({ open }) {
			return h(
				"span",
				{ className: "wfs-dock-chevron", "data-open": open ? "1" : "0" },
				h(
					"svg",
					{
						width: 14,
						height: 14,
						viewBox: "0 0 24 24",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 2,
						strokeLinecap: "round",
						strokeLinejoin: "round",
						"aria-hidden": "true",
					},
					h("path", { d: "m6 9 6 6 6-6" }),
				),
			);
		}

		/**
		 * 一枚 pill = 一个子智能体。
		 *
		 * **点它就是打开那个子智能体自己的会话窗口** —— 那是官方原生的会话视图，
		 * 有完整的 markdown、工具卡片、图片、流式追加与冷恢复。本插件在这里只做一件事：
		 * 把人送到那儿去（`onOpen(pill)` → `ctx.uiWorkspace.openSession(pill.childId)`）。
		 *
		 * 早期版本点开的是插件自己镜像的一份精简转录（一个内联面板）。那是错的：
		 * 同一份内容维护两遍，而镜像那份永远是残缺的 —— 官方会话窗口本来就在那儿。
		 */
		function Pill({ pill, onOpen }) {
			const mark =
				pill.status === "running"
					? "…"
					: pill.status === "completed"
						? "✓"
						: pill.status === "failed"
							? "✕"
							: pill.status === "cancelled"
								? "⊘"
								: "";
			return h(
				"button",
				{
					type: "button",
					className: "wfs-pill",
					"data-s": pill.status,
					title: `${pill.label} · ${statusLabel(pill.status)} · ${duration(pill.startedAt, pill.endedAt)}${pill.model === null ? "" : ` · ${pill.model}`} —— 点开它的会话`,
					onClick: () => onOpen(pill),
				},
				h("span", { className: "wfs-avatar", "data-i": String(avatarIndex(pill.seq)) }, avatarGlyph(pill)),
				h("span", { className: "wfs-pill-label" }, pill.label),
				pill.duplicate ? h("span", { className: "wfs-pill-seq" }, `#${String(pill.seq)}`) : null,
				mark === "" ? h("span", { className: "wfs-pill-tail" }, "↗") : h("span", { className: "wfs-pill-tail" }, mark),
			);
		}

		/**
		 * 一列：阶段头（状态点 + 名字 + 已结算/已观测）+ 说明 + 该阶段的 pill 堆。
		 * 超过 PILL_PINS 枚时折叠成「还有 N 个」，展开态由父组件按列记忆。
		 */
		function PhaseColumn({ phase, onOpen, expanded, onExpand }) {
			const shown = expanded ? phase.pills : phase.pills.slice(0, PILL_PINS);
			const rest = phase.pills.slice(shown.length);
			return h(
				"div",
				{ className: "wfs-board-col" },
				h(
					"div",
					{ className: "wfs-board-head" },
					h("span", { className: "wfs-dot", "data-s": phase.status }),
					h("span", { className: "wfs-board-name", title: phase.title }, phase.title),
					h("span", { className: "wfs-board-frac" }, `${String(phase.settled)}/${String(phase.observed)}`),
				),
				/*
				 * 阶段下方**不渲染说明文字**。
				 * `meta.phases[].detail` 仍然照收（前端数据里留着，别处可能有消费者），
				 * 但板面上不画 —— 阶段头一行「名字 + 12/12」已经把该说的说完了，
				 * 再垫一行小字只是噪音，而且会把这列 pill 往下推。
				 */
				h(
					"div",
					{ className: "wfs-board-body" },
					phase.observed === 0 ? h("div", { className: "wfs-more" }, "（尚无子智能体）") : null,
					shown.map((pill) => h(Pill, { key: pill.seq, pill, onOpen })),
					rest.length === 0
						? null
						: h(
								"button",
								{
									type: "button",
									className: "wfs-pill wfs-pill-more",
									onClick: () => onExpand(true),
									title: `展开其余 ${String(rest.length)} 个`,
								},
								h(
									"span",
									{ className: "wfs-stack" },
									rest
										.slice(0, STACK_FACES)
										.map((pill) =>
											h("span", { key: pill.seq, className: "wfs-avatar", "data-i": String(avatarIndex(pill.seq)) }, avatarGlyph(pill)),
										),
								),
								h("span", { className: "wfs-pill-label" }, `还有 ${String(rest.length)} 个`),
								h("span", { className: "wfs-pill-tail" }, "↗"),
							),
				),
			);
		}

		/**
		 * 阶段之间的连线。
		 *
		 * 实线 = 脚本声明的依赖；淡虚线 = 只是相邻（**或**那条边是按时序推出来的）——
		 * 不把「挨着」或「猜的」说成「有依赖」。
		 */
		function PhaseLink({ state }) {
			const declared = state !== null && state.inferred !== true;
			return h("div", {
				className: "wfs-board-link",
				"data-edge": declared ? "1" : "0",
				"data-inferred": state !== null && state.inferred === true ? "1" : "0",
				"data-back": state?.back === true ? "1" : "0",
			});
		}

		/**
		 * 板面：阶段列横向排开，列间用连线表示「在它之后运行」。
		 *
		 * 布局是**声明序**，不跑图布局算法：阶段按 meta.phases 与首次出现的顺序排成一列到底。
		 * 好处是零依赖、确定性、运行期不重排 —— 新的子智能体只会往自己那一列里加，列序不变。
		 */
		function PhaseBoard({ run, onOpen, expandedPhases, onExpandPhase }) {
			const board = useMemo(() => projectBoard(run), [run]);
			if (run === null) return h("div", { className: "wfs-empty" }, "还没有选中任何运行。");
			if (board.phases.length === 0) return h("div", { className: "wfs-empty" }, "这次运行还没有派出任何子智能体。");

			const children = [];
			board.phases.forEach((phase, index) => {
				if (index > 0) {
					const previous = board.phases[index - 1];
					children.push(h(PhaseLink, { key: `link-${phase.key}`, state: linkBetween(board, previous.key, phase.key) }));
				}
				children.push(
					h(PhaseColumn, {
						key: `col-${phase.key}`,
						phase,
						onOpen,
						expanded: expandedPhases[phase.key] === true,
						onExpand: () => onExpandPhase(phase.key),
					}),
				);
			});
			return h("div", { className: "wfs-board" }, children);
		}

		/** 主面板里的结构图：板面 + 外层滚动与内边距。 */
		function GraphView({ run, onOpen, expandedPhases, onExpandPhase }) {
			return h(
				"div",
				{ className: "wfs-board-wrap" },
				h(PhaseBoard, {
					run,
					onOpen,
					expandedPhases: expandedPhases ?? {},
					onExpandPhase: onExpandPhase ?? (() => {}),
				}),
			);
		}

		//#endregion

		//#region 时间线

		/**
		 * 每个子智能体一条泳道，横轴是时间。
		 *
		 * 这张图回答结构图答不了的问题：**到底是不是真并行**。重叠的条是真并行，
		 * 错开的条是串行 —— 时序推断（host/runs.mjs 的 inferEdges）给出的边，
		 * 在这里可以被人一眼验证或推翻。
		 */
		function TimelineView({ run, onOpen }) {
			useNowTicker(run !== null && run.status === "running");

			if (run === null) return h("div", { className: "wfs-empty" }, "还没有选中任何运行。");
			if (run.nodes.length === 0) return h("div", { className: "wfs-empty" }, "这次运行还没有派出任何子智能体。");

			const start = run.startedAt;
			const end = Math.max(run.endedAt ?? Date.now(), ...run.nodes.map((node) => node.endedAt ?? Date.now()), start + 1000);
			const span = Math.max(1000, end - start);
			const percent = (time) => `${String(((time - start) / span) * 100)}%`;

			const ordered = [...run.nodes].sort((left, right) => left.startedAt - right.startedAt);
			const ticks = [];
			const tickCount = 5;
			for (let index = 0; index <= tickCount; index += 1) {
				const time = start + (span * index) / tickCount;
				ticks.push({ time, at: `${String((index / tickCount) * 100)}%` });
			}

			return h(
				"div",
				{ className: "wfs-timeline" },
				ordered.map((node) =>
					h(
						"div",
						{ className: "wfs-tl-row", key: node.seq },
						h(
							"div",
							{ className: "wfs-tl-name", title: `${node.label}（#${String(node.seq)}）` },
							h("span", { className: "wfs-dot", "data-s": node.status }),
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, node.label),
						),
						h(
							"div",
							{ className: "wfs-tl-track" },
							h("div", {
								className: "wfs-tl-bar",
								"data-s": node.status,
								style: {
									left: percent(node.startedAt),
									width: `${String(Math.max(0.6, (((node.endedAt ?? Date.now()) - node.startedAt) / span) * 100))}%`,
								},
								title: `${node.label} · ${statusLabel(node.status)} · ${duration(node.startedAt, node.endedAt)} —— 点开它的会话`,
								onClick: () => onOpen(node),
							}),
						),
					),
				),
				h(
					"div",
					{ className: "wfs-tl-axis" },
					h("div", { style: { width: 190, flex: "none" } }, "时间轴"),
					h(
						"div",
						{ className: "wfs-tl-ticks" },
						ticks.map((tick, index) => h("span", { className: "wfs-tl-tick", key: index, style: { left: tick.at } }, clockTime(tick.time))),
					),
				),
			);
		}

		//#endregion

		//#region 叙述

		function LogView({ run }) {
			if (run === null) return h("div", { className: "wfs-empty" }, "还没有选中任何运行。");
			const rows = [];
			for (const entry of run.phaseHistory ?? []) {
				rows.push({ time: entry.time, kind: "phase", text: entry.title });
			}
			for (const entry of run.log ?? []) {
				rows.push({ time: entry.time, kind: entry.kind, text: entry.text });
			}
			rows.sort((left, right) => left.time - right.time);
			if (rows.length === 0) {
				return h("div", { className: "wfs-empty" }, "这次运行没有输出任何叙述。脚本里的 phase() 与 log() 会出现在这里。");
			}
			return h(
				"div",
				{ className: "wfs-log" },
				rows.map((row, index) =>
					h(
						"div",
						{ className: "wfs-log-row", key: index },
						h("span", { className: "wfs-log-time" }, clockTime(row.time)),
						row.kind === "phase" ? h("span", { className: "wfs-log-phase" }, `▸ ${row.text}`) : h("span", { className: "wfs-log-text" }, row.text),
					),
				),
			);
		}

		//#endregion

		//#region 运行概览

		/**
		 * 右侧的运行概览。
		 *
		 * 这里**不再**显示某个子智能体的转录。点 pill 会直接跳到那个子智能体自己的会话窗口 ——
		 * 那是官方原生视图，完整性、流式追加、工具卡片、冷恢复全是现成的。
		 * 面板只回答「这次运行整体怎么样」：规模、用时、当前阶段，以及这张图怎么读。
		 *
		 * 早期版本在这里镜像了一份精简转录。那是错的：同一份内容维护两遍，而镜像那份永远是残缺的。
		 */
		function DetailPanel({ run }) {
			if (run === null) {
				return h("div", { className: "wfs-side" }, h("div", { className: "wfs-empty" }, "还没有选中任何运行。"));
			}
			return h(
				"div",
				{ className: "wfs-side" },
				h(
					"div",
					{ className: "wfs-side-head" },
					h("span", { className: "wfs-dot", "data-s": run.status }),
					h("span", { className: "wfs-side-title" }, "运行概览"),
				),
				h(
					"div",
					{ className: "wfs-side-body" },
					kv("名称", run.name),
					kv("状态", statusLabel(run.status)),
					kv("用时", duration(run.startedAt, run.endedAt)),
					kv("子智能体", `${String(run.agentsStarted)} 个`),
					kv("当前阶段", run.currentPhase ?? "-"),
					run.error === null ? null : h("div", { className: "wfs-err" }, run.error),
					h(
						"div",
						{ className: "wfs-sec" },
						h("div", { className: "wfs-sec-title" }, "说明"),
						h("div", { className: "wfs-entry-text" }, run.description),
					),
					h(
						"div",
						{ className: "wfs-sec" },
						h("div", { className: "wfs-sec-title" }, "怎么读这张图"),
						h(
							"div",
							{ className: "wfs-entry-text" },
							"一列是一个阶段，一枚 pill 是这个阶段里的一个子智能体。列与列之间的实线是脚本声明的依赖，淡虚线只是相邻（或按时序推出来的，不一定真有依赖）。点任意一枚 pill 会打开那个子智能体自己的会话窗口 —— 完整的转录、工具调用与实时流都在那边。一列超过 5 个时，最后一行「还有 N 个」可以展开。",
						),
					),
				),
			);
		}

		function kv(key, value) {
			return h("div", { className: "wfs-kv" }, h("span", { className: "wfs-kv-k" }, key), h("span", { className: "wfs-kv-v" }, String(value)));
		}

		//#endregion

		//#region 工作流库

		function LibraryView({ library, onRun, onShow, busyName }) {
			if (library === null) return h("div", { className: "wfs-empty" }, "正在读取工作流库…");
			const items = library.items ?? [];
			return h(
				"div",
				{ className: "wfs-lib" },
				h(
					"div",
					{ className: "wfs-lib-meta", style: { marginBottom: 14 } },
					h("span", { className: "wfs-mono" }, `用户目录：${String(library.userRoot ?? "-")}`),
					library.bundledRoot === null ? null : h("span", { className: "wfs-mono" }, `随包目录：${String(library.bundledRoot)}`),
				),
				items.length === 0
					? h(
							"div",
							{ className: "wfs-empty" },
							`还没有任何工作流。在 ${String(library.userRoot ?? "")} 里放一个 .js 文件即可（YAML frontmatter + 脚本正文）。`,
						)
					: items.map((item) =>
							h(
								"div",
								{ className: "wfs-lib-item", key: item.name },
								h(
									"div",
									{ className: "wfs-lib-name" },
									item.name,
									item.origin === "bundled" ? h("span", { className: "wfs-tag" }, "随包") : h("span", { className: "wfs-tag wfs-tag-brand" }, "自建"),
									(item.phases ?? []).map((phase) => h("span", { className: "wfs-tag", key: phase.title }, phase.title)),
								),
								h("div", { className: "wfs-lib-desc" }, item.description),
								item.whenToUse === null ? null : h("div", { className: "wfs-lib-meta" }, `适用：${item.whenToUse}`),
								h(
									"div",
									{ className: "wfs-row", style: { marginTop: 10, display: "flex", gap: 8 } },
									h(
										"button",
										{ className: "wfs-btn wfs-btn-primary wfs-btn-sm", disabled: busyName === item.name, onClick: () => onRun(item.name) },
										busyName === item.name ? "启动中…" : "运行",
									),
									h("button", { className: "wfs-btn wfs-btn-sm", onClick: () => onShow(item.name) }, "看脚本"),
								),
								h("div", { className: "wfs-lib-meta" }, h("span", { className: "wfs-mono" }, item.path)),
							),
						),
				(library.invalid ?? []).length > 0
					? h(
							"div",
							null,
							h("div", { className: "wfs-sec-title", style: { marginTop: 20 } }, `被忽略的文件（${String(library.invalid.length)}）`),
							library.invalid.map((item) => h("div", { className: "wfs-err", key: item.path }, `${item.path} —— ${item.reason}`)),
						)
					: null,
			);
		}

		//#endregion

		//#region 常驻条

		/**
		 * 输入框上方的常驻工作流条。
		 *
		 * ## 为什么放在这里，而不是侧栏面板
		 *
		 * 工作流是**当前会话正在发生的事**，而人打字的时候视线就在输入框上。要跑去看侧栏，
		 * 等于把「进度」和「我正在做的事」割成两块。官方把目标/任务列表放在同一个槽位
		 * （`conversation.input.dock`），这里跟着放。
		 *
		 * ## 只显示属于本会话的运行
		 *
		 * 过滤键是 `parentSessionId` —— 由宿主从**子会话的 header** 反推出来（`host/runs.mjs`），
		 * 因此模型用 `workflow` 工具起的运行也归得到发起它的会话上，不只是 `/workflow` 起的那些。
		 *
		 * ## 点 pill 就是打开那个子智能体自己的会话
		 *
		 * 面板里**没有**内联转录 —— 点一枚 pill 走 `ctx.uiWorkspace.openSession(childId)`，
		 * 跳到官方原生的会话窗口（与 DSH 顶部的子智能体下拉菜单点进去是同一个落点）。
		 * 那边有完整的 markdown、工具卡片、图片、流式追加与冷恢复，插件不必也不该再镜像一份。
		 *
		 * ## 折叠规则
		 *
		 * 运行中默认展开（这时候人最关心），结算后默认折叠成一行（不占地方）。
		 * 用户手动点过之后以用户的选择为准 —— `open === null` 表示「还没表过态」。
		 */
		function WorkflowDock({ sessionId, hostCtx }) {
			const [run, setRun] = useState(null);
			const [open, setOpen] = useState(null);
			const [expanded, setExpanded] = useState({});
			const [error, setError] = useState(null);

			/*
			 * 一个轮询循环干完三件事：拉增量状态、挑出本会话最近的运行、在它的 revision 变了时
			 * 拉一次结构。**刻意不拆成两个 effect** —— 拆开就要在依赖里放「当前运行的 id 与
			 * revision」，而那两样每次轮询都会变，effect 会被反复拆掉重建。
			 */
			useEffect(() => {
				let stopped = false;
				let timer = null;
				let cursor = 0;
				let lastId = null;
				let lastRevision = -1;

				const tick = async () => {
					if (stopped) return;
					const state = await api.state(cursor);
					if (stopped) return;
					let active = false;
					if (state.ok) {
						cursor = typeof state.data.seq === "number" ? state.data.seq : cursor;
						const mine = (state.data.runs ?? []).filter((item) => item.parentSessionId === sessionId);
						active = mine.some((item) => item.status === "running");
						const top = mine.length === 0 ? null : mine[0];
						if (top === null) {
							lastId = null;
							lastRevision = -1;
							setRun(null);
						} else if (top.id !== lastId || top.revision !== lastRevision) {
							lastId = top.id;
							lastRevision = top.revision;
							const detail = await api.run(top.id, false);
							if (stopped) return;
							if (detail.ok) {
								setRun(detail.data);
								setError(null);
							} else {
								setError(detail.error);
							}
						}
					} else {
						setError(state.error);
					}
					timer = window.setTimeout(tick, active ? 800 : 2500);
				};

				tick();
				return () => {
					stopped = true;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, [sessionId]);

			/** 打开一个子智能体自己的会话。取不到导航服务时如实说一句，不假装成功。 */
			const openSession = useCallback(
				(pill) => {
					if (!openChildSession(hostCtx, pill?.childId)) {
						setError("当前外壳没有暴露会话导航服务，打不开子会话。");
					}
				},
				[hostCtx],
			);

			if (run === null) return null;

			const board = projectBoard(run);
			const isOpen = open === null ? run.status === "running" : open;

			return h(
				"div",
				{ className: "wfs-dock" },
				h(
					"button",
					{
						type: "button",
						className: "wfs-dock-head",
						"aria-expanded": isOpen ? "true" : "false",
						onClick: () => setOpen(!isOpen),
					},
					h("span", { className: "wfs-dot", "data-s": run.status }),
					h("span", { className: "wfs-dock-title" }, STATUS_WORD[run.status] ?? "工作流"),
					h("span", { className: "wfs-dock-name", title: run.name }, run.name),
					h("span", { className: "wfs-spacer" }),
					run.status === "running" && run.currentPhase !== null
						? h("span", { className: "wfs-dock-meta" }, run.currentPhase)
						: null,
					h("span", { className: "wfs-dock-meta" }, `${String(board.phases.length)} 个阶段 · ${String(board.total)} 个子代理`),
					h(ChevronIcon, { open: isOpen }),
				),
				error === null ? null : h("div", { className: "wfs-err" }, error),
				isOpen
					? h(
							"div",
							{ className: "wfs-dock-body" },
							h(PhaseBoard, {
								run,
								onOpen: openSession,
								expandedPhases: expanded,
								onExpandPhase: (key) => setExpanded((previous) => ({ ...previous, [key]: true })),
							}),
						)
					: null,
			);
		}

		//#endregion

		//#region 主页面

		const TABS = [
			{ id: "graph", label: "结构图" },
			{ id: "timeline", label: "时间线" },
			{ id: "log", label: "叙述" },
			{ id: "library", label: "工作流库" },
		];

		function WorkbenchPage({ hostCtx }) {
			const [tab, setTab] = useState("graph");
			const [runs, setRuns] = useState([]);
			const [library, setLibrary] = useState(null);
			const [runId, setRunId] = useState(null);
			const [run, setRun] = useState(null);
			const [error, setError] = useState(null);
			const [busyName, setBusyName] = useState(null);
			const [script, setScript] = useState(null);
			/* 「还有 N 个」的展开态按阶段 key 记在这里：切走再切回来不该丢掉 */
			const [expandedPhases, setExpandedPhases] = useState({});

			const cursor = useRef(0);
			const runIdRef = useRef(null);
			runIdRef.current = runId;
			const dirty = useRef(false);
			/*
			 * 详情轮询用的游标与最新快照都放 ref：轮询 effect 的依赖必须只有 runId，
			 * 否则每次 setRuns 都会把它拆掉重建（见下面 effect 的说明）。
			 */
			const runsRef = useRef([]);
			runsRef.current = runs;
			const runRef = useRef(null);
			runRef.current = run;
			const lastRevisionRef = useRef(-1);
			const lastNodesRef = useRef(-1);

			/** 主循环：拉增量事件 + 运行列表 + 工作流库。 */
			useEffect(() => {
				let stopped = false;
				let timer = null;

				const tick = async () => {
					if (stopped) return;
					const result = await api.state(cursor.current);
					if (stopped) return;
					if (result.ok) {
						const data = result.data;
						cursor.current = typeof data.seq === "number" ? data.seq : cursor.current;
						setRuns(data.runs ?? []);
						setLibrary(data.library ?? null);
						setError(null);
						/*
						 * 只要事件里出现过当前选中的运行，就把它的详情标脏。
						 * 不在这里直接拉详情：事件可能一次来几十条，合并成一次请求。
						 */
						const current = runIdRef.current;
						if (current !== null && (data.events ?? []).some((entry) => entry.payload?.runId === current)) {
							dirty.current = true;
						}
						// 没有运行在跑时降频，避免空转
						const active = (data.runs ?? []).some((item) => item.status === "running");
						timer = window.setTimeout(tick, active ? 600 : 2200);
					} else {
						setError(result.error);
						timer = window.setTimeout(tick, 3000);
					}
				};

				tick();
				return () => {
					stopped = true;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, []);

			/** 首次拿到运行列表时自动选中最近的一个。 */
			useEffect(() => {
				if (runId === null && runs.length > 0) setRunId(runs[0].id);
			}, [runs, runId]);

			/**
			 * 详情轮询：只拉结构（不含正文），正文由详情面板按需拉。
			 *
			 * **依赖只有 `[runId]`。** 早期版本把 `runs` 也写进依赖 —— 而 `runs` 每次轮询
			 * 都是新数组，于是这个 effect 每个 tick 都被拆掉重建：内部的
			 * `lastRevision` / `lastNodes` 跟着归零，`/run` 变成**每 500ms 全量拉一次**。
			 * 症状是「界面看着正常，但宿主请求量是设计值的两倍」——很难发现。
			 * 现在这些游标放在 ref 里（跨 effect 重建存活），`runs` 也从 ref 读。
			 */
			useEffect(() => {
				if (runId === null) {
					setRun(null);
					return undefined;
				}
				let stopped = false;
				let timer = null;
				// 换了运行，强制重拉一次
				lastRevisionRef.current = -1;
				lastNodesRef.current = -1;

				const tick = async () => {
					if (stopped) return;
					const summary = runsRef.current.find((item) => item.id === runId);
					const revision = summary === undefined ? -1 : summary.revision;
					const nodeCount = summary === undefined ? -1 : summary.nodeCount;
					if (
						revision !== lastRevisionRef.current ||
						nodeCount !== lastNodesRef.current ||
						dirty.current ||
						runRef.current === null
					) {
						dirty.current = false;
						lastRevisionRef.current = revision;
						lastNodesRef.current = nodeCount;
						const result = await api.run(runId, false);
						if (stopped) return;
						if (result.ok) {
							setRun(result.data);
							setError(null);
						} else {
							setError(result.error);
						}
					}
					timer = window.setTimeout(tick, 500);
				};

				tick();
				return () => {
					stopped = true;
					if (timer !== null) window.clearTimeout(timer);
				};
			}, [runId]);

			const startRun = useCallback(async (name) => {
				setBusyName(name);
				const result = await api.start(name, undefined, undefined);
				setBusyName(null);
				if (result.ok) {
					setRunId(result.data.runId);
					dirty.current = true;
				} else {
					setError(result.error);
				}
			}, []);

			const cancelRun = useCallback(async () => {
				if (run === null) return;
				const result = await api.cancel(run.id);
				if (!result.ok) setError(result.error);
			}, [run]);

			const showScript = useCallback(async (name) => {
				const result = await api.libraryItem(name);
				if (result.ok) setScript({ name, text: result.data.script, meta: result.data.meta });
				else setError(result.error);
			}, []);

			/**
			 * 打开一枚 pill 对应的子智能体会话。
			 *
			 * 走官方的会话导航（`ctx.uiWorkspace.openSession`）—— 与 DSH 顶部的子智能体下拉菜单
			 * 点进去是同一个落点，也与官方 `dsh-client-ui-workflow-run` 的「点成员开子会话」同一条路。
			 *
			 * 软取而不是 inject（见 inject 处的说明）。取不到时**不假装成功**：如实说一句。
			 */
			const openSession = useCallback(
				(pill) => {
					if (!openChildSession(hostCtx, pill?.childId)) {
						setError("当前外壳没有暴露会话导航服务，打不开子会话。");
					}
				},
				[hostCtx],
			);

			const current = runs.find((item) => item.id === runId) ?? null;

			return h(
				"div",
				{ className: "wfs-root" },
				h(
					"div",
					{ className: "wfs-head" },
					h("h2", { className: "wfs-title" }, "工作流工作台", h("span", { className: "wfs-sub" }, "Workflow Studio")),
					h(
						"select",
						{
							className: "wfs-select",
							value: runId ?? "",
							onChange: (event) => {
								setRunId(event.target.value === "" ? null : event.target.value);
							},
						},
						runs.length === 0 ? h("option", { value: "" }, "（还没有运行记录）") : null,
						runs.map((item) =>
							h(
								"option",
								{ key: item.id, value: item.id },
								`${item.name} · ${statusLabel(item.status)}${item.currentPhase === null ? "" : ` · ${item.currentPhase}`} · ${clockTime(item.startedAt)}`,
							),
						),
					),
					run === null
						? null
						: h(
								"span",
								{ className: "wfs-sub" },
								`${String(run.nodes.length)} 个子智能体 · ${duration(run.startedAt, run.endedAt)}${run.currentPhase === null ? "" : ` · 当前：${run.currentPhase}`}`,
							),
					h("div", { className: "wfs-spacer" }),
					run !== null && run.status === "running" && current?.canCancel !== false
						? h("button", { className: "wfs-btn wfs-btn-danger wfs-btn-sm", onClick: cancelRun }, "停止")
						: null,
					h("button", { className: "wfs-btn wfs-btn-sm", onClick: () => setTab("library") }, "工作流库"),
				),
				h(
					"div",
					{ className: "wfs-tabs" },
					TABS.map((item) =>
						h(
							"button",
							{ key: item.id, className: "wfs-tab", "data-on": tab === item.id ? "1" : "0", onClick: () => setTab(item.id) },
							item.label,
							item.id === "library" && library !== null ? h("span", { className: "wfs-tab-count" }, String((library.items ?? []).length)) : null,
						),
					),
				),
				error === null ? null : h("div", { className: "wfs-err" }, error),
				h(
					"div",
					{ className: "wfs-body" },
					h(
						"div",
						{ className: "wfs-main" },
						tab === "graph"
							? h(GraphView, {
									run,
									onOpen: openSession,
									expandedPhases,
									onExpandPhase: (key) => setExpandedPhases((previous) => ({ ...previous, [key]: true })),
								})
							: null,
						tab === "timeline" ? h(TimelineView, { run, onOpen: openSession }) : null,
						tab === "log" ? h(LogView, { run }) : null,
						tab === "library" ? h(LibraryView, { library, onRun: startRun, onShow: showScript, busyName }) : null,
					),
					tab === "library" ? null : h(DetailPanel, { run }),
				),
				script === null
					? null
					: h(
							"div",
							{
								style: {
									position: "fixed",
									inset: 0,
									background: "rgba(0,0,0,.42)",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									zIndex: 60,
								},
								onClick: () => setScript(null),
							},
							h(
								"div",
								{
									style: {
										width: "min(860px,90vw)",
										maxHeight: "80vh",
										overflow: "auto",
										background: "var(--dsw-alias-bg-layer-1)",
										border: "1px solid var(--dsw-alias-border-l1)",
										borderRadius: 14,
										padding: "16px 18px",
									},
									onClick: (event) => event.stopPropagation(),
								},
								h("div", { className: "wfs-lib-name" }, script.name, h("span", { className: "wfs-tag" }, script.meta?.description ?? "")),
								h("pre", { className: "wfs-code" }, script.text),
							),
						),
			);
		}

		//#endregion

		//#region 图标

		function makeIcon(paths, inSidebar) {
			return function Icon(props) {
				const size = (props && props.size) || 16;
				const attrs = {
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					style: { flex: "none", opacity: props && props.active === false ? 0.6 : 1 },
				};
				if (inSidebar === true) attrs["data-dshd-nav"] = "1";
				return h("svg", attrs, paths.map((d, index) => h("path", { key: index, d })));
			};
		}

		/**
		 * 工作台图标：一个扇出再汇聚的图 —— 左边一个节点，中间三个，右边一个。
		 * 与面板内容（阶段 → 参与者 → 汇聚）同形，不画装饰性的东西。
		 */
		const StudioIcon = makeIcon(
			["M3.5 12h3", "M18 12h2.5", "M6.5 12 10 6.5h4L17.5 12", "M6.5 12 10 17.5h4L17.5 12", "M12 6.5V4", "M12 17.5V20"],
			true,
		);

		//#endregion

		//#region 注册

		const PANEL_WORKFLOW = "dsh-workflow-studio-page";

		/*
		 * 客户端半边用**短服务名** inject，package.json 的 `dsh.client.inject` 用**包名** ——
		 * 两者不是一回事，写错会让插件静默不装载。
		 *
		 * 这里只 inject `slots`（与已在本机稳定运行的 `dsh-skill-manager` 逐字相同）。
		 * `uiWorkspace` 是**可选**依赖：它在官方契约里就有 `ctx.get("uiWorkspace")` 这条
		 * 软取路径，而写进 inject 会让插件在它缺席的组合里永远不装载 ——
		 * 「打不开子会话」远比「整个面板不出现」轻。
		 */
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("sidebar.panellist", function () {
				return [
					ctx.slots.register({ name: "sidebar.panellist", id: PANEL_WORKFLOW, order: 44, label: "工作流工作台" }, StudioIcon),
				];
			});

			ctx.slots.inject("main", function () {
				/*
				 * 把宿主上下文交给页面：页面需要它来软取 `uiWorkspace`。
				 * 用一层薄包装而不是模块级变量，是为了让同一个页面组件在卸载后重挂时
				 * 拿到的一定是当前这次 apply 的上下文。
				 */
				const Bound = (props) => h(WorkbenchPage, { ...props, hostCtx: ctx });
				Bound.displayName = "WorkflowStudioPage";
				return [ctx.slots.register({ name: "main", key: PANEL_WORKFLOW }, Bound)];
			});

			/*
			 * 常驻条：输入框上方。
			 *
			 * `inject` 在这里是**函数**（收 sessionId、返回注入给组件的 props），
			 * 与 `conversation.chat.node` 那种数组形式不同 —— 照官方 goal 面板的形状写。
			 * order 排在 goal（10）之后，免得压住它。
			 *
			 * 同样包一层把 `ctx` 递进去：点 pill 要调 `uiWorkspace.openSession`。
			 */
			ctx.slots.inject("conversation.input.dock", function () {
				const BoundDock = (props) => h(WorkflowDock, { ...props, hostCtx: ctx });
				BoundDock.displayName = "WorkflowDock";
				return [
					ctx.slots.register(
						{
							name: "conversation.input.dock",
							id: "workflow-studio",
							order: 20,
							inject: (sessionId) => ({ sessionId }),
						},
						BoundDock,
					),
				];
			});
		}

		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/*
		 * 测试缝：把纯函数与视图组件暴露出来，供 `test/check.mjs` 在 Node 里做
		 * 离线渲染自检（不需要真窗口）。官方客户端插件不导出这些，但它们都是纯函数/纯组件，
		 * 暴露出来不会让运行时多出任何行为。
		 */
		exports.__internals = {
			projectBoard,
			linkBetween,
			rollup,
			statusLabel,
			duration,
			avatarIndex,
			avatarGlyph,
			openChildSession,
			GraphView,
			PhaseBoard,
			PhaseColumn,
			Pill,
			WorkflowDock,
			TimelineView,
			LogView,
			DetailPanel,
			WorkbenchPage,
			StudioIcon,
			PANEL_WORKFLOW,
		};
		return module.exports;
	},
});
