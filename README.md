# ctxlens

**你的 agent 上下文去了哪，以及它为什么死。**

一个零依赖的本地 CLI：读 LLM 请求体快照或 agent 会话日志，按**顶层字段**和**轮次**把 token 账算清楚。
不接 SDK、不开代理、不上传任何东西。

```bash
ctxlens request  req-*.json          # 一次请求体：谁在吃窗口
ctxlens session  session.v4.jsonl.zstd --latest   # 会话日志：哪一轮开始失控、最后为什么死
```

## 为什么需要它

一次真实事故：请求体 2,215,206 token 撞穿 1,048,576 窗口，发送被拦住。官方错误里写着：

```
messages ~552,091 · tools[] ~15,184 · system ~7,109 · other ~1,640,822
```

**messages 只占四分之一。** 剩下的 1.64M 在一个隐藏字段里（`dsh_session_log`），
它不在 `messages` 里，所以所有"数消息"的工具都看不见它；而压缩器也只折叠对话，
碰不到这种请求级字段。排查花了几小时，最后是靠 dump 拆字段定位的。

如果当时有 `ctxlens`，这一步是 30 秒：

```
$ ctxlens request req-1794904316247-....json
total     18.0 MiB · ~2.2M tok · window 1.05M · OVER by ~1.17M

by top-level field
  dsh_session_log      hidden       8.0 MiB  ~1.64M   45.4%
  messages             messages     2.0 MiB  ~552k    11.6%
  tools                tools       81.1 KiB  ~ 15.2k    0.4%
  system               system      28.0 KiB  ~  7.1k    0.1%

⚠ 非对话字段（常规压缩碰不到，只能关掉/截断）
  dsh_session_log — ~1.64M tok (45.4%)
```

## 安装

还没有发布到 npm。现在：

```bash
git clone <repo> && cd ctxlens
node src/cli.js --help
node test/run.js        # 16 条自测
```

要求 Node ≥ 22（用内置 `zlib.zstdDecompressSync` 读 `.jsonl.zstd`，不需要 zstd CLI）。

## 用法

### 请求体

```bash
ctxlens request body.json
ctxlens request body.json --window 200000 --json
```

输出：顶层字段字节 / token / 占比；`⚠ 非对话字段`；单条最大消息（压缩的原子单位，压不动的就是它们）。

### 会话日志

```bash
ctxlens session ~/.dsh/sessions/.../session.v4.jsonl.zstd
ctxlens session --latest            # 取最新的
ctxlens session file --top 10 --json
```

输出：事件数、轮次数、累积 token（**日志累积，不是请求大小**）、最后一条 `turn/end` 的错误原文、
最重的几轮。支持明文 `.jsonl` 与压缩 `.jsonl.zstd`，坏行只计数不中断。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常（请求未超窗 / 会话没有超窗发送失败） |
| 1 | 请求超窗，或会话里有一次超窗发送失败（`413` / `outbound body`） |
| 2 | 用法或解析错误 |

可以直接接进 CI：`ctxlens request body.json || echo "context budget exceeded"`。

## 它是怎么算的

- **按顶层字段拆**，而不是只数 `messages`。分类：`messages` / `system` / `tools` / `hidden`。
  大头经常在 `hidden`。
- **按轮次拆会话**：用 `data.turn` / `data.turnId` 归组（没有就沿用上一轮），
  第一轮之前的事件单独计为 `prelude`，不污染轮表。
- **token 估算（CJK 感知）**：CJK 字符 ≈ 1 token/字，其余 ≈ 4 字符/token。
  与 provider 的 usage 行偏差约 ±15%——用来判断"谁在吃窗口"够用，用来报销不够。
  绝对数请看 API 返回的 usage。
- **压缩边界**：标出"单条最大消息"和"非对话字段"，因为这两类东西是压缩器压不动的。

## 边界（先说不行的）

- **估算不是账单。** ±15% 是常态；不同 tokenizer 对代码、emoji、数字的切法差更多。
- **会话累积 ≠ 请求大小。** 压缩会把旧历史折叠，请求体里还有日志中没有的字段。
  `session` 模式的累积值只作量级参考；要判断具体一次请求，用 `request` 模式。
- **只读本地文件。** 不连 API、不读进程内存、不代理流量。
- **只认通用结构。** 各家的会话事件格式不同，本工具只依赖"每行一个对象 + 可能有 data.turn"，
  特殊字段请用 `--json` 自己再加工。

## 设计约束

- 零运行时依赖（Node 内置模块）。
- 只读：不写、不改、不上传。
- 单一入口：`src/cli.js`；核心逻辑在 `src/analyze.js`（纯函数，可被别处引用）。
- 自测测真函数，合成数据复现真实事故形状（含 413 的 `turn/end` 错误、banner 前缀的 dump、坏行）。

## English

`ctxlens` is a local, zero-dependency CLI that explains **where an LLM request's tokens actually went**
and **which turn of an agent session started to blow up**. It decomposes the *top-level* request body
(most tools only count `messages`) and groups session events by turn. Built after a real incident where a
2.2M-token body overran a 1M window — 1.64M of it in a hidden request field that no message counter could see.

```bash
ctxlens request body.json --window 1048576
ctxlens session --latest
```

Exit codes: `0` ok, `1` overflow, `2` usage/parse error.

## License

MIT
