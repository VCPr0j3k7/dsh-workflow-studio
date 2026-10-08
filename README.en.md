# dsh-workflow-studio

> A person-facing front door for DeepSeek Harness workflows: launch them with `/workflow`, and
> watch **what every subagent is doing** and **how they relate** on a live board.

---

## Contents

- [Background](#background)
- [What it does](#what-it-does)
- [The UI](#the-ui)
- [Install](#install)
- [Uninstall](#uninstall)
- [Writing a workflow](#writing-a-workflow)
- [Declaring structure](#declaring-structure)
- [Command reference](#command-reference)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Credits](#credits)
- [License](#license)

---

## Background

DSH already ships a **strong workflow engine**: `@deepseek-ai/dsh-workflow-ptc` provides
`ctx.workflowEngine`, and the `workflow` tool lets the model write a JavaScript script that fans a
task out to dozens of subagents — concurrency caps, cancellation, subagent spawning and result
validation included. What is missing is not the engine; it is the **human** side:

| Gap | Symptom |
|---|---|
| Wrong entry point | Only the model can trigger a workflow. To get one running you first have to explain *how* the job should be split — nobody can just say `/workflow review today's code` |
| Nothing accumulates | Workflows are written fresh by the model every time; there is no way to save "the thing I run every week" |
| Content is invisible | The official in-conversation card (`dsh-client-ui-workflow-run`) shows a two-level **status list** — who is running, who finished. **You cannot see what any subagent is writing** |
| Structure is invisible | Engine events carry no edges between agents. What runs in parallel, what depends on what — none of it is on screen |
| Wrong place | Progress appears once in the conversation flow and then scrolls away. While you are typing, you cannot see where the run is |

This plugin fills those five gaps **without replacing any official part** — engine, events,
sessions and the in-conversation card all stay exactly as they are.

## What it does

1. **`/workflow <a plain sentence>`** — hands that sentence to the model **verbatim**. The model
   works out the topology in its own reasoning, writes the script, and calls the `workflow` tool
   **in the background**.
2. **`/workflow <a saved name>`** — runs a workflow you wrote, directly. Same command; the split is
   "does the first word match a saved workflow name".
3. **A workflow library**: `<DSH_HOME>/workflows/*.js`, YAML frontmatter plus a script body.
   Reusable, versionable, shippable.
4. **A dock above the composer** — sits there like the goal/task list, collapsible and expandable.
   Expanded, it is phase columns plus one pill per subagent; **clicking a pill opens that
   subagent's own session window** (the same destination as picking it from DSH's subagent
   dropdown).
5. **A full workbench panel** (sidebar) for what the dock cannot hold — three views:
   - **Board** — phase columns, subagent pills, and "runs after" links between columns
   - **Timeline** — one lane per subagent against real time (the only place that answers
     "is this actually parallel?")
   - **Narration** — whatever the script emitted via `phase()` / `log()`
6. **Structure declaration**: scripts may declare dependencies with `wfNode` / `wfRun` / `wfEdge` /
   `wfGroup`. Declared dependencies are quotiented to the phase level and drawn as solid lines
   between columns.

### Two deliberate boundaries

**One: "how to do it" never goes into your message.** `/workflow <a sentence>` injects that
sentence and nothing else — not one character more. "When you get an orchestration request, work
out the topology in your head first, declare structure with `wfRun`, default to background
execution" is a description of **how the model should work**, so it lives in a system prompt
section the plugin registers (see [How it works](#how-it-works)). What you send is what the model
sees; interpretation happens in the model's reasoning, not by rewriting the message.

**Two: transcripts are not mirrored.** The plugin does **not** render subagent transcripts itself.
Clicking a pill goes through the official session navigation into the official session window —
full markdown, tool cards, images, streaming append and cold recovery all come for free. Mirroring
it would mean maintaining the same content twice, and the mirror would always be the poorer copy.

## The UI

### The dock above the composer (main entry)

```
┌ ● Workflow finished  DS code adversarial review   2 phases · 13 subagents   ⌄ ┐
│                                                                               │
│  ● Four-way parallel review  12/12  ──  ● Merge findings  1/1                 │
│  ┌──────────────────────────┐   ┌──────────────────────────┐                  │
│  │ 🟩 Rollback auditor    ✓ │   │ 🟪 Findings reviewer   ✓ │                  │
│  │ 🟧 Path A code reviewer✓ │   └──────────────────────────┘                  │
│  │ 🟦 Eval-chain reviewer ✓ │                                                 │
│  │ 🟪 Hallucination scan  ✓ │                                                 │
│  │ 🟦 Verifier-scan-1     ✓ │                                                 │
│  │ 🟥🟪🟩 7 more           ↗ │                                                 │
│  └──────────────────────────┘                                                 │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Status dot, a word for the run state, and the workflow name on the left; scale and a chevron on
  the right.
- **Expanded while running** (that is when you care), collapsed to one line once it settles.
- **Clicking a pill opens that subagent's own session window.** No inline transcript, no dropdown —
  the native session view is far more complete than anything this panel could show. The `↗` on the
  pill tail means exactly that.
- When the current session has no workflow, the whole bar is absent.

#### The width has to be computed here — the slot will not do it for you

`conversation.input.dock` is a **full-width slot**: every entry has to subtract the composer's
clearance and inset itself to line up with the input box. The official goal bar does this, and so
does every dock entry in `dsh-client-ui-conversation`:

```css
width: calc(100%
  - var(--dsh-composer-side-clearance) * 2
  - var(--dsh-composer-dock-inset) * 4);
max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
margin: 0 auto;
```

Those variables are defined in the official composition (`--dsh-composer-side-clearance:16px`,
`--dsh-composer-dock-inset:8px`, `--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px)`).
**This plugin originally subtracted nothing**, so the bar was two rings wider than the input box —
that was the entire cause of "the width is wrong". Both places now use the same formula, so the
width lines up exactly with the goal bar and the input box.

One debugging note: `tools/find-css-var.mjs` does a byte-level search over the 121 MB `app.asar`
and reports **definitions** separately from **references** (only a following colon counts as a
definition). It is faster and far harder to get wrong than `cat`-ing package after package, and it
tells you immediately whether a variable is defined at all.

#### Which way the chevron points

**Up when collapsed, down when expanded.** The bar sits above the composer and its content unfolds
**downward** toward the input box, so "down" means already unfolded and "up" means folded.

Both conventions exist in official code (`.triggerOpen{rotate(180deg)}` in `ui-jobs` versus
`.sectionChevron{-90deg → none}`); this plugin follows the latter.

### The workbench panel (sidebar, details and history)

```
┌─ Workflow Studio ───────────────────────────────────────────────────────────┐
│ [run list ▾]  codebase-audit · running · 5 subagents · 12.3s        [stop]   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Board │ Timeline │ Narration │ Library          ┌─────────────────────────┐ │
├─────────────────────────────────────────────────┤ Run overview            │ │
│  ● Scan  1/1 ── ● Audit  1/3 ── ● Merge  1/1    │ name …                  │ │
│  ┌────────────┐  ┌────────────┐                 │ status …                │ │
│  │🟦 scan    ✓│  │🟩 audit   ✓│                 │ elapsed …               │ │
│  └────────────┘  │🟧 audit   …│                 │ subagents …             │ │
│                  │🟪 audit   …│                 │ how to read this …      │ │
│                  └────────────┘                 └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**How to read the board** (also written into the panel):

- **A column is a phase; a pill is a subagent.** A `pipeline(items, …)` that dispatches twelve
  subagents produces twelve pills — not one card reading "12 instances". What a reader wants first
  is *which people this phase actually dispatched*, not "there is a blob here, click to see who".
- The **`12/12`** next to a phase name is "settled / observed": how many in that column have
  finished.
- **Lines between columns** mean "runs after": declared dependencies are solid, mere adjacency (or
  a timing-inferred edge) is a faint dashed line — adjacency and guesses are never dressed up as
  dependencies. No lines are drawn inside a column; those agents already stand side by side.
- **More than five pills in a column** collapse into a "N more" row with three stacked faces.
- **Avatars distinguish instances, not status**: same-named instances each get a hue, and a `#3`
  suffix (otherwise five identically-named pills leave you guessing which one you are clicking).
  Status lives in the pill's tail mark (`…` running / `✓` done / `✕` failed / `⊘` cancelled) and in
  the phase header dot.
- The right-hand overview column is proportional (26%, clamped to 240–360px), not a fixed pixel
  width.

## Install

This plugin is a standard DSH bundle (`dsh.bundle.patch` is declared in `package.json`), so
installing it means putting it into a profile and registering it as a bundle:

```bash
git clone https://github.com/VCPr0j3k7/dsh-workflow-studio
dsh plugin --profile desktop add file:<the directory you cloned into>
```

**Then restart DSH.** The host half is loaded as part of host startup, so a restart is required
for it to take effect (see [Known limitations](#known-limitations)).

### When the install refuses: the manual equivalent

If `dsh plugin add` fails for reasons **unrelated to this plugin** (this happened locally: another
`file:` dependency in the profile pointed at a deleted directory, pnpm resolution hit `ENOENT`, and
from then on every `pnpm add` failed), you can do by hand the three things pnpm would have done:

1. Create a **junction** (Windows) or symlink for the plugin directory under
   `<profile>/node_modules/`;
2. Add `"dsh-workflow-studio": "file:<plugin directory>"` to `dependencies` in
   `<profile>/package.json`;
3. Append `"dsh-workflow-studio"` to `dsh.profile.bundles` in the same file.

**Do not touch `cordis.patch.yml`** — the insert row comes from the plugin's own
`cordis.patch.yml`; inserting it again in the profile patch would duplicate it.

Check the profile's current state:

```bash
node tools/verify-profile.mjs
```

It verifies two things at once: that `cordis.patch.yml` still parses (top level is an array, no
leftover insert), and that the plugin really is listed in `dsh.profile.bundles`.

## Uninstall

```bash
dsh plugin --profile desktop rm dsh-workflow-studio
```

For a manual install, reverse the three steps: delete `node_modules/dsh-workflow-studio`, and
remove the matching lines from `dependencies` and `dsh.profile.bundles`. Workflow files
(`<DSH_HOME>/workflows/`) are left alone.

## Writing a workflow

Put it in `<DSH_HOME>/workflows/<name>.js`. Names allow lowercase letters, digits, dots,
underscores and dashes only.

```js
---
name: audit-docs
description: Audit every file under docs/ for accuracy
whenToUse: When you need to check a batch of documents
phases:
  - title: Scan
    detail: List the files to audit
  - title: Audit
    detail: One subagent per file
graph:
  - id: scan
    label: Scan targets
    phase: Scan
  - id: audit
    label: Audit file
    phase: Audit
    deps: [scan]
---
const files = args?.files ?? []
if (files.length === 0) return { error: 'missing the files argument' }

phase('Scan')
const plan = await wfRun('scan', { label: 'Scan targets', phase: 'Scan' },
  `Files to audit:\n${files.join('\n')}\nGive the key points for each.`)

phase('Audit')
const findings = await pipeline(files, async (file) =>
  wfRun('audit', { label: 'Audit file', phase: 'Audit' },
    `Audit ${file}. Coordinator's notes: ${plan}\nOutput three sections: verdict / evidence / advice.`))

return { total: files.length, findings: findings.filter(Boolean) }
```

### What the script can use

The six hooks the official engine injects work as usual:

| Hook | Effect |
|---|---|
| `agent(prompt, opts?)` | Run one subagent; resolves to its final text (with `opts.schema`, to a validated object; `null` if the child fails) |
| `pipeline(items, ...stages)` | Push every item through all stages independently, **with no barrier between stages** |
| `parallel(thunks)` | Run zero-argument thunks concurrently and await all of them (a barrier) |
| `phase(title)` | Advance the phase (presentation only; changes no execution) |
| `log(message)` | One narration line |
| `args` | The JSON arguments the run was launched with |

This plugin injects four additional **structure hooks** (reported over the `log()` channel only;
removing them would not stop the script from running):

| Hook | Effect |
|---|---|
| `wfRun(id, spec, prompt, opts?)` | Declare a node and immediately run one subagent — **the common case** |
| `wfNode(id, spec)` | Declare a node only (call `agent()` yourself) |
| `wfEdge(from, to, kind?)` | Declare one edge explicitly |
| `wfGroup(id, spec)` | Declare a logical group |

`spec` accepts: `label` (also used as the agent's `label`, and as the **binding key** between an
instance and its declared node), `phase`, `deps` (upstream node ids; edges are generated), `group`,
`kind`, `detail`, `provider`, `model`.

> **`detail` now goes into the data but not onto the screen.** The explanatory line under each
> phase has been removed — the phase header's "name + 12/12" already says what needs saying, and a
> line of small print only adds noise while pushing that column's pills down. A `detail` written
> into a workflow is still parsed (it is visible in `/run`), it is simply not drawn.

> **Binding is by label.** One logical node can own many instances (a `pipeline` fan-out) — the
> binding is many-to-one, so `wfRun`'s `spec.label` must stay the same across instances of the same
> logical step.

## Declaring structure

Structure can live in the frontmatter (static: the board has something to draw before the first
subagent starts) or in the script (dynamic). Both share the same binding path. Both shapes are
accepted:

```yaml
# Shape one: a node array; edges come from deps
graph:
  - id: scan
    label: Scan targets
    phase: Scan
  - id: audit
    label: Audit file
    phase: Audit
    deps: [scan]
```

```yaml
# Shape two: explicit nodes + edges
graph:
  nodes:
    - { id: scan, label: Scan targets, phase: Scan }
    - { id: audit, label: Audit file, phase: Audit }
  edges:
    - { from: scan, to: audit, kind: flow }
```

## Command reference

```
/workflow <a plain sentence>    Hand the sentence to the model verbatim: it sets the topology, then launches via the workflow tool in the background
/workflow                       List available workflows and running runs
/workflow <saved name> [JSON]   Launch a saved workflow directly (runs in the background; watch the dock)
/workflow prompt <text>         Force the "hand it to the model" path (in case a name collides with what you meant to say)
/workflow show [run id]         Show one run's phases and subagents
/workflow stop <run id>         Cancel a run
/workflow reload                Rescan the workflow directory
/workflow help                  Usage
```

Run ids may be given as their first 8 characters.

> **`input.hint` is not "hint text" — it is the switch that says "this command takes arguments".**
>
> In the DSH client, `desc.input !== void 0` decides whether a command claims the input line:
>
> | | with `input` | without `input` |
> |---|---|---|
> | Picked from the menu | Enters argument-entry mode (`/goal` behaves this way) | **Executes immediately** (like `/compact`) |
> | Arguments | `line + args` reach the handler together | Always the empty string |
> | Pressing Tab | Completes | **Sends immediately** |
>
> This was removed once (the usage string felt like clutter on the input box), which took the
> argument entry with it. Two symptoms showed up in practice: `command/run` events carried empty
> args, and Tab sent instead of completing. The host also insists the hint be non-empty
> (`input hint must not be empty`), so "leave it blank" is not an option.
>
> Conclusion: `input` has to stay. The hint is written in **plain language**, not symbolic syntax —
> this plugin uses "what do you want to do, or the name of an existing workflow". An earlier
> `<a sentence>|<name> [JSON]` was exposing internal grammar; all the user needs to know is what may
> go in the box. `test/check.mjs` pins this down, and `tools/mutation-check.mjs` verifies that
> deleting it turns the self-check red.
>
> **One thing that is out of reach: an icon in the `/` menu.** A menu row renders an icon only when
> `item.icon !== undefined` (there is no fallback in `dsh-client-ui-input-trigger`), and `icon` has
> exactly two sources: a **hard-coded table** of six official command names (`HOST_FACES` in
> `ui-commands`) and client contributions. But a contribution whose name collides with a host
> command **throws** (and would break the whole candidate list), and a contribution only handles
> the **bare** command — arguments fall straight through. So a host command that takes arguments is
> destined to have no icon in the menu. Only upstream can change that: open `HOST_FACES` to third
> parties, or lift the name-collision rule.

### Two ways to launch

| | `/workflow review today's code` | `/workflow codebase-audit {"files":[…]}` |
|---|---|---|
| Who sets the topology | The model, on the spot | You, in the file |
| Same every time | Not necessarily; depends how the model splits it | Yes |
| Good for | One-off jobs whose shape is unclear | A fixed process you run every week |
| Lands where | The `workflow` tool, with the script visible as it is written | Launched directly; the script was written long ago |

The split rule is simple: **can the first word be matched to a saved workflow name?** If yes it
runs directly; if no, it is treated as something you said.

### What the "hand it to the model" path actually does

1. `/workflow review today's code` injects **`review today's code`** — verbatim — into the current
   session, through the official `sessionController.prompt` (the same admission path your own
   typing takes).
2. The model learns "what to do with an orchestration request" from the **system prompt** — see
   [How it works](#how-it-works).
3. The model sets the topology in its reasoning, writes the script, and calls the `workflow` tool
   (with `run_in_background: true` by default).
4. Once the run starts the dock appears, and **you can keep talking** — neither blocks the other.

## How it works

```
                    ┌──────────────── Host half (index.js) ────────────────────┐
 /workflow <sentence>│ ctx.commands.register('workflow')                       │
      ──────────────▶│   └─ sessionController.prompt(the user's own words)     │
                    │        └─ model sets topology → writes script → tool    │
 /workflow <name>   │                                                         │
      ──────────────▶│   └─ ctx.workflowEngine.start({script, meta, …})        │
                    │        └─ script = structure preamble + user body       │
                    │                                                         │
                    │ ctx.systemPrompt.section(WORKFLOW_SECTION)              │
                    │   "how to do it" lives here: topology in reasoning,      │
                    │   declare structure with wfRun, default to background    │
                    └────────────────────┬────────────────────────────────────┘
                                         │ official engine executes
                    ┌────────────────────▼────────────────────────────────────┐
   workflow/start   │  workflow/phase · workflow/log                          │
   workflow/agent-* │  workflow/agent-start · workflow/agent-end              │
   workflow/end     │  workflow/end                                           │
                    └────────────────────┬────────────────────────────────────┘
                                         │ tree-wide broadcast; the plugin subscribes at the root
                    ┌────────────────────▼────────────────────────────────────┐
                    │ host/runs.mjs — folded into a "run model"               │
   session/event ──▶│  phase → subagent → per-entry work content              │
   (child logs)     │  owning session: inferred from the child's header       │
                    └────────────────────┬────────────────────────────────────┘
                                         │ HTTP: /state /run /node /diagnose
                    ┌────────────────────▼────────────────────────────────────┐
                    │ Client half (client.js)                                 │
                    │  dock (above the composer) · board / timeline /         │
                    │  narration / overview                                   │
                    │  click a pill ─▶ uiWorkspace.openSession(childId)       │
                    └─────────────────────────────────────────────────────────┘
```

Four design decisions worth spelling out:

1. **Work content comes from the subagent's own session log.** The `childId` in
   `workflow/agent-start` is a real SessionId; the plugin subscribes to `session/event` at the root
   context and routes text, tool calls and tool results back to the right node by `childId`. The
   official card only draws status because that needs just the `workflow/*` stream; showing
   **content** requires the second stream — that is the whole prerequisite for "you can see what
   it is writing".

   That content, however, is presented **only through the official session window**: clicking a
   pill goes through `uiWorkspace.openSession`, and the plugin never draws a second transcript.
   `GET /node` still serves the mirrored per-entry content (for other consumers), but the UI does
   not depend on it.

2. **The owning session is inferred from the child's header.** The `workflow/start` event does not
   say who started the run; the command path can take it from `invocation.agent`, but a run the
   model started with the `workflow` tool cannot. Every child session's `header.parentSession`
   records it, which unifies both paths — and lets the dock treat model-started runs exactly like
   command-started ones.

3. **Structure edges have three layers, highest first.** Engine events carry no edges between
   agents, so: script declaration (`deps` / `wfEdge`) > phase grouping (`phase`) > timing inference
   (within a phase, an agent that starts only after the previous one has fully ended is judged
   sequential). **Inferred edges are drawn as dashed lines** — guesses are not presented as facts.

4. **Layout is declaration order; no graph layout algorithm runs.** Phases line up in the order of
   `meta.phases` and first appearance. Columns are drawn left to right; adjacent columns get a
   straight connector, and the board never re-ranks while running — a new subagent only ever joins
   its own column.

## Requirements

- **Required**: `webServer`, `commands` (both in the official base bundle; hard `inject`).
- **Soft dependency**: `workflowEngine`. In the official composition it is **not in the root
  context** — `plugin_manager` shows both `workflow-ptc` and `tool-workflow` as
  `enabled: false, fiberPhase: null`; they are mounted per **agent preset**. The plugin therefore
  resolves it along four paths in order: root context → `agentPresets.serviceFor(agent, …)` →
  `agent.ctx` → parent chain. On the official desktop build it is the **second** one that hits. If
  none does, `/workflow` says plainly that it cannot find the engine rather than throwing something
  cryptic.
- **Soft dependency**: `sessionController` (host). `/workflow <sentence>` uses it to inject the
  task. Without it that path fails while `/workflow <saved name>` keeps working — it only needs the
  engine.

  > **There is a trap in calling it**: the second argument of `SessionController.prompt(request, signal)`
  > is a **mandatory** `AbortSignal` (the source calls `signal.throwIfAborted()` unconditionally, and
  > the doc comment lists `@param signal`). Passing only the request produces
  > `Cannot read properties of undefined (reading 'throwIfAborted')` — which gives no hint at all
  > that an argument is missing. `test/check.mjs` has a dedicated regression test for this, and
  > `tools/mutation-check.mjs` verifies it **actually turns red**.

- **Soft dependency**: `uiWorkspace` (client). Used only for "open subagent session"; when absent
  the UI says so and everything else is unaffected.
- The client half injects `slots` only.

Two self-checks:

```
GET /dsh-workflow-studio/api/diagnose
```

It reports which session each run belongs to, which path the engine resolved through
(`engineVia`), and `sessionControllerAvailable` — together enough to answer "why won't it start"
in one shot.

## Tests

```bash
node test/check.mjs              # offline self-check: 48 assertions, no profile needed
node tools/verify-live.mjs       # end-to-end: boots an isolated host instance and hits real HTTP
node tools/mutation-check.mjs    # mutation testing: proves the regression tests actually turn red
```

`test/check.mjs` covers: the frontmatter parser (a YAML subset), script composition, the run
registry's event folding (tool-call de-duplication, injected-context classification, **late
structure declarations clearing timing edges**), the host half loading in a stubbed context and its
route contract, and the client half rendered offline under a **bundled React stand-in** — phase
columns, collapse/expand, timeline, narration, overview and dock each rendered once with their
content asserted, plus "clicking a pill hands out the childId" and the `openChildSession` success
contract.

> That React stand-in is not filler: `useState` returns its initial value, `useEffect` is a no-op,
> and only `useMemo`/`useCallback` really run. Component functions are therefore executed in full —
> branches, copy and `data-*` markers are all checkable — while **not** requiring react on the
> machine (the one in the profile is a pnpm junction pointing at a directory that may not exist;
> depending on it would make the self-check skip at random on other machines).

### Mutation testing: why it is mandatory

`tools/mutation-check.mjs` breaks each previously-fixed defect **back into its broken form** and
asserts the self-check turns red:

```
✓ sessionController.prompt missing its signal   turns red: 47 passed, 1 failed
✓ inferEdges cleanup after the early return     turns red: 47 passed, 1 failed
✓ PhaseLink ignoring inferred                   turns red: 47 passed, 1 failed
✓ command input deleted                         turns red: 47 passed, 1 failed
```

**It is not ceremony — it caught a fake test.** The "solid versus dashed" assertion originally read
`includes('data-edge="0"')`, but that string was contributed by a **different** connector (one that
had no dependency anyway), so it held no matter how inferred edges were drawn. It only became real
once it asserted **two attributes on the same connector together**
(`data-edge="0" data-inferred="1"`).

`tools/verify-live.mjs` boots an isolated host instance on a **different port and a different
`DSH_HOME`** (the official port 19387 is held by the running instance), so it never touches the one
you are using:

```
48 passed, 0 failed     ← test/check.mjs
21 passed, 0 failed     ← tools/verify-live.mjs
```

## Known limitations

1. **A restart is required after installing.** The host half is loaded as part of host startup; a
   running host will **not** hot-start a newly inserted plugin row — its config reload explicitly
   requires "no new inactive entry was introduced", and a newly inserted entry is necessarily
   inactive first. Measured: after inserting into the profile patch the entry appears in
   `listConfigs` with status `inactive`, and `/info` keeps returning 404; removing and re-inserting
   behaves the same. (Another trap: **Node caches failed imports**. When a first attempt failed
   because of a bad import, no amount of retrying inside the same host process helped — only a
   restart cleared it.)

   Editing the host half also needs a restart: the official `hmr` reloads **modules**, it does not
   re-run a plugin's `apply()`. The client half only needs a page refresh (its bundle is fetched
   from disk on demand).

2. **Within a run, logical nodes bind to instances by `label`.** Two different logical nodes sharing
   one `label` and one `phase` are treated as the same. That is a deliberate trade: binding by
   declaration order under concurrency mispairs at random, which is worse than not binding.

3. **Only declared phase dependencies are drawn.** The host still infers node-level edges from
   timing, but the board draws only **between phases** — declared edges as solid lines, adjacency
   and inferred edges as faint dashed ones. Reason: a pill is one instance, and drawing arrows
   between instances inside a column turns into a knot immediately, while the question readers
   actually have ("is this really parallel?") is answered far better by the **Timeline** page.
   Where declarations are incomplete, undeclared instances get no lines at all.

4. **The dock shows only the most recent run of the current session.** Older runs and runs from
   other sessions live in the sidebar panel. When the current session has no run, the bar is absent.

5. **Clicking a pill leaves the current view.** After jumping to a subagent session the workbench
   panel is no longer in front; click the sidebar icon to come back. This is deliberate rather than
   an inline expansion, because the official session window is stronger than anything the plugin
   could offer on completeness, streaming and cold recovery.

6. **Content caps.** Each node keeps at most 500 entries and each text block at most 6000
   characters; beyond that the oldest are dropped and a notice is left in the stream (never a silent
   truncation).

7. **Only the most recent 60 runs are kept**, in memory only — after a host restart the workbench is
   empty. The truth lives in the session log (the `tool-workflow/*` records are still written into
   the initiating session, so the official in-conversation card keeps working).

8. **When `uiWorkspace` is unavailable, clicking a pill does nothing** apart from a notice on the
   bar. The client half injects `slots` only and soft-takes `uiWorkspace`, so that its absence does
   not take the whole panel down with it.

## Credits

The shape of the UI and its interactions borrows heavily from
[ZCode](https://github.com/zai-org/ZCode) (Apache-2.0):

- **The visual vocabulary** (a phase is a column, a subagent is a pill, one arrow semantics only —
  "runs after", colour encoding status alone, declaration order instead of a layout algorithm) comes
  from `packages/ui/src/components/workflow-timeline/`;
- **The `12/12` phase fraction**, **pinning N pills per column then folding into "N more" with three
  stacked faces**, and the **reduced-motion coverage** come from the same place
  (`ROSTER_PINS_CARD` / `ROSTER_DECK` in `roster-model.ts`);
- **The semantics of `/workflow [prompt]`** (the command does not run a workflow; it states the task
  and leaves orchestration to the model) comes from
  `apps/zcode-cli/packages/bootstrap/src/builtin-workflow-command.ts`.

Three places where this plugin deliberately differs:

1. ZCode's diagram is a **static analysis artefact** (a causality graph derived at submit time);
   this board is a **live projection of the run** — pills light up, finish, and open onto what that
   subagent is writing right now.
2. ZCode draws control flow between phases; this plugin draws only **dependencies the script
   declared** (solid) plus adjacency / inference (faint dashed) — guesses are never drawn solid.
3. ZCode renders subagent transcripts inside the chat card; this plugin **does not mirror
   transcripts** at all — clicking a pill goes through `uiWorkspace.openSession` into the official
   session window. ZCode has to draw its own because its actor sessions do not live in the existing
   session pane; in DSH a child session is just an ordinary session, so reuse beats reimplementation.

The engine, events, sessions, command registry, system prompt, slots and `conversation.input.dock`
are all official DeepSeek Harness capabilities; this plugin only projects and presents.

## License

MIT
