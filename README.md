# ctx-autopsy

**验尸，不是观测。** 你手里已经有一具尸体——一次保存下来的请求体、一份跑完的会话日志——它告诉你 token 去了哪、哪一轮开始失控、最后为什么死。**不代理、不重放、不接 SDK。**

```bash
ctx-autopsy request  req-*.json                  # 一次请求体：按顶层字段拆
ctx-autopsy session  session.v4.jsonl.zstd       # 会话日志：按轮次拆 + 最后一条错误
```

## 先读这个：已有的工具（2026-11-19 核查）

这个方向不是空的。下面三个都比本工具成熟，如果你的需求落在它们的范围里，**请直接用它们**：

| 项目 | 规模 | 它解决什么 | 它不做什么 |
|---|---|---|---|
| [larsderidder/context-lens](https://github.com/larsderidder/context-lens) | 405★，活跃 | 本地代理抓每一次 API 调用，按 system / tools / 历史 / 工具结果 / thinking 做构成分析，带 UI，支持 Claude Code、Codex、Gemini CLI、Cline、Aider 等 | 需要**经过它的代理**；不读你已有的死会话日志或旧 dump |
| [ccusage/ccusage](https://github.com/ccusage/ccusage) | 19.5k★ | 从各 agent 的本地用量文件汇总每日/每月/每会话的 token 与成本 | 只汇总用量，不做请求体字段构成，不回答"这次为什么爆" |
| [dabit3/ctxlens](https://github.com/dabit3/ctxlens) | 14★ | 静态分析磁盘上的文件占用多少 token，估算上下文压力 | 分析的是**你的源码目录**，不是一次真实请求体 |

## 那为什么还有这个

因为有一类事故，上面三个都接不上：**会话已经死了，代理从来没在链路里。**

真实案例：请求体 2,215,206 token 撞穿 1,048,576 窗口，发送被拦住。官方错误里写着：

```
messages ~552,091 · tools[] ~15,184 · system ~7,109 · other ~1,640,822
```

- `messages` 只占四分之一，剩下 1.64M 在一个**请求级隐藏字段**里（`dsh_session_log`）。
- 它不在 `messages` 里 ⇒ 数消息的工具看不见；压缩器只折叠对话 ⇒ 也碰不到它。
- 事故现场只有两个文件：一份请求体 dump、一份跑完的会话日志。它们已经在那里了。

`ctx-autopsy` 只做两件事，并且**只读本地文件**：把请求体按**顶层字段**拆开（隐藏字段才会现形），把会话日志按**轮次**拆开（并摘出最后一条 `turn/end` 的错误原文）。

它还多做一件现有工具不做的事：**给处方**——不是"窗口里都是什么"，而是"最小改哪一处，这次就不会爆"，按风险分三档（加隐藏字段上限 / 删大工具定义 / 折叠最旧历史），并算清执行后还差多少。

```
$ ctx-autopsy request req-1794904316247-....json
total     18.0 MiB · ~2.2M tok · window 1.05M · OVER by ~1.17M

by top-level field
  dsh_session_log      hidden       8.0 MiB  ~1.64M   45.4%
  messages             messages     2.0 MiB  ~552k    11.6%
  tools                tools       81.1 KiB  ~ 15.2k    0.4%
  system               system      28.0 KiB  ~  7.1k    0.1%

⚠ 非对话字段（常规压缩碰不到，只能关掉/截断）
  dsh_session_log — ~1.64M tok (45.4%)
```

## 处方：最小改哪一处

```bash
ctx-autopsy request body.json --window 200000
```

```
total     924.2 KiB · ~248.0k tok · window 200.0k · OVER by ~48.0k

处方（不同改动的最小组合，按风险从低到高）
  medium −  48.3k  折叠最旧的 39/160 条消息（会丢掉早期上下文）
  → 按此执行后 ~199.7k tok，装得下 200.0k
```

原则：

- **安全档（cap-field）**：只对超过 512 KiB 的请求级隐藏字段提议——它通常不是对话内容，压它不丢上下文。
- **中等档（drop-tool）**：只建议"省得动"的工具定义（省不到缺口 2% 的不值得用能力面去换）。
- **有损档（fold-history）**：折叠最旧的消息，按比例标 `medium`/`high` 风险。
- **救不了的情况会明说**：单条消息本身就超过窗口时，折叠等于截断内容——必须让生产方拆分；可能不止一条，处方会全部列出。

## 安装

尚未发布 npm。现在：

```bash
git clone https://github.com/lanxingyun/ctx-autopsy
cd ctx-autopsy
npm link                 # 把 ctx-autopsy 放到 PATH；不想全局链接就始终用 node src/cli.js
ctx-autopsy --help
node test/run.js         # 29 条自测
```

下文示例默认 `ctx-autopsy` 已在 PATH；没链接时把命令换成 `node src/cli.js` 即可。

要求 Node ≥ 22（用内置 `zlib.zstdDecompressSync` 读 `.jsonl.zstd`，不需要 zstd CLI）。

## 用法

### 请求体（验尸主体）

```bash
ctx-autopsy request body.json
ctx-autopsy request body.json --window 200000 --json
```

输出：顶层字段的字节 / token / 占比；`⚠ 非对话字段`；单条最大消息（压缩的原子单位，压不动的就是它们）。

### 会话日志

```bash
ctx-autopsy session ~/.dsh/sessions/.../session.v4.jsonl.zstd
ctx-autopsy session --latest            # 取最新的
ctx-autopsy session file --top 10 --json
```

输出：事件数、轮次数、累积 token（**日志累积，不是请求大小**）、最后一条 `turn/end` 的错误原文、最重的几轮。支持明文 `.jsonl` 与压缩 `.jsonl.zstd`，坏行只计数不中断。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常（请求未超窗 / 会话没有超窗发送失败） |
| 1 | 请求超窗，或会话里有一次超窗发送失败（`413` / `outbound body`） |
| 2 | 用法或解析错误 |

可接进 CI：`ctx-autopsy request body.json \|\| echo "context budget exceeded"`。

## 它是怎么算的

- **按顶层字段拆**，而不是只数 `messages`。分类：`messages` / `system` / `tools` / `hidden`。大头经常在 `hidden`。
- **按轮次拆会话**：用 `data.turn` / `data.turnId` 归组（没有就沿用上一轮），第一轮之前的事件单独计为 `prelude`，不污染轮表。
- **处方**：先试安全档，再试材料档（省得动的工具），最后才折叠历史；每步都算"执行后还剩多少"。
- **token 估算（CJK 感知）**：CJK 字符 ≈ 1 token/字，其余 ≈ 4 字符/token。与 provider usage 行偏差约 ±15%——判断"谁在吃窗口"够用，报销不够。
- **压缩边界**：标出"单条最大消息"和"非对话字段"，因为这两类是压缩器压不动的。

## 边界（先说不行的）

- **估算不是账单。** ±15% 是常态。
- **会话累积 ≠ 请求大小。** 压缩会折叠旧历史，请求里还有日志中没有的字段。`session` 的累积值只作量级参考。
- **只读本地文件。** 不连 API、不读进程内存、不代理流量、不重放。
- **只认通用结构。** 只依赖"每行一个对象 + 可能有 data.turn"，特殊字段用 `--json` 自己再加工。
- **没有可视化、没有持续观测、没有多工具接入。** 那是 context-lens 的活。

## 设计约束

- 零运行时依赖（Node 内置模块）。
- 只读：不写、不改、不上传。
- 单一入口：`src/cli.js`；核心逻辑在 `src/analyze.js`（纯函数，可被别处引用）。
- 自测测真函数；合成数据复现真实事故形状（413 的 `turn/end`、banner 前缀 dump、坏行、两层会话目录）。

## English

`ctx-autopsy` is a **post-mortem** tool for dead agent sessions. Given a saved request body or a finished
session log, it decomposes the *top-level* request fields (most tools only count `messages`, so request-level
hidden fields stay invisible) and groups session events by turn, surfacing the last error verbatim. It also
**prescribes the smallest fix**: cap a hidden field, drop an oversized tool definition, or fold the oldest
history — ranked by risk, with the resulting size computed. No proxy, no replay, no integration.

If you want live capture, a UI, or per-tool composition over time, use
[context-lens](https://github.com/larsderidder/context-lens). If you want cost aggregation, use
[ccusage](https://github.com/ccusage/ccusage).

## License

MIT
