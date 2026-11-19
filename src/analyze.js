/**
 * analyze.js —— 把"一次请求"和"一份会话日志"拆成可读的账
 *
 * 核心判断只有一句：**窗口爆掉时，钱和 token 往往不在你以为的地方。**
 * 真实事故里 2.2M token 的请求体中，messages 只占 552k，
 * 一个隐藏的 `dsh_session_log` 字段占了 1.64M —— 它不在 messages 里，
 * 所以任何"数消息"的工具都看不见它。
 *
 * 因此本文件只做两件事：
 *   1) 按**顶层字段**拆请求体（而不是只数 messages）
 *   2) 按**轮次**拆会话日志（找出从哪一轮开始失控）
 */

import { estimateTokens, estimateTokensFromBytes } from "./tokens.js";

const FOLDABLE_KINDS = new Set(["messages", "system", "tools"]);

export function classifyKey(key) {
  if (key === "messages") return "messages";
  if (key === "system" || key === "instructions") return "system";
  if (key === "tools" || key === "functions") return "tools";
  return "hidden"; // 真正的大头经常在这里
}

/** 请求体顶层字段的字节/ token 账 */
export function decomposeRequest(body) {
  const parts = [];
  let totalBytes = 0;
  let totalTokens = 0;
  for (const [key, value] of Object.entries(body ?? {})) {
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    const bytes = Buffer.byteLength(text, "utf8");
    const tokens = estimateTokens(text);
    totalBytes += bytes;
    totalTokens += tokens;
    parts.push({ key, kind: classifyKey(key), bytes, tokens, value });
  }
  for (const p of parts) p.share = totalBytes > 0 ? p.bytes / totalBytes : 0;
  parts.sort((a, b) => b.bytes - a.bytes);
  return { parts, totalBytes, totalTokens };
}

/** 单条消息里最大的那几条 —— 它们通常是"压不动"的单元。按 token 排，不按字节：CJK 一字一 token，字节会低估它。 */
export function biggestMessages(messages, top = 5) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m, i) => {
      const text = typeof m === "string" ? m : JSON.stringify(m) ?? "";
      return {
        index: i,
        role: m?.role ?? "?",
        bytes: Buffer.byteLength(text, "utf8"),
        tokens: estimateTokens(text),
      };
    })
    .sort((a, b) => b.tokens - a.tokens || b.bytes - a.bytes)
    .slice(0, top);
}

export function analyzeRequest(body, { window = 1_048_576 } = {}) {
  const { parts, totalBytes, totalTokens } = decomposeRequest(body);
  const biggest = biggestMessages(body?.messages);
  const hidden = parts.filter((p) => p.kind === "hidden" && p.share > 0.15);
  const overflow = totalTokens > window;
  return {
    window,
    totalBytes,
    totalTokens,
    overflow,
    overBy: overflow ? totalTokens - window : 0,
    parts,
    biggest,
    hidden,
    // 可折叠的部分：messages/system/tools；hidden 不参与常规压缩，只能关掉或截断
    foldableTokens: parts
      .filter((p) => FOLDABLE_KINDS.has(p.kind))
      .reduce((s, p) => s + p.tokens, 0),
  };
}

function turnOf(ev) {
  const d = ev?.data ?? {};
  const t = d.turn ?? d.turnId ?? ev?.turn ?? ev?.turnId;
  return Number.isFinite(t) ? t : null;
}

/**
 * 会话日志按轮次聚合。
 * 返回 { turns, lastError, heaviest, overflowTurn, events, badLines }
 */
export function analyzeSession(events, { window = 1_048_576, badLines = 0 } = {}) {
  const turns = new Map();
  let current = null;
  let lastError = null;
  let preludeEvents = 0;

  for (const ev of events) {
    const t = turnOf(ev);
    if (t !== null) current = t;
    // 第一轮开始前的事件（模型选择、启动日志）不归任何一轮，单独计数，
    // 否则会凭空多出一个 turn 0，把"哪一轮开始失控"算歪。
    if (current === null) {
      preludeEvents += 1;
      continue;
    }
    const turnNo = current;

    const text = JSON.stringify(ev?.data ?? ev);
    const bytes = Buffer.byteLength(text, "utf8");
    const rec = turns.get(turnNo) ?? { turn: turnNo, bytes: 0, tokens: 0, events: 0, types: {} };
    rec.bytes += bytes;
    rec.tokens += estimateTokens(text);
    rec.events += 1;
    const ty = ev?.type ?? "?";
    rec.types[ty] = (rec.types[ty] ?? 0) + 1;
    turns.set(turnNo, rec);

    if (ev?.type === "turn/end") {
      const kind = ev?.data?.reason?.kind ?? ev?.data?.kind;
      if (kind === "error") {
        lastError = {
          turn: turnNo,
          message: ev?.data?.reason?.error?.message ?? ev?.data?.error?.message ?? "(no message)",
          code: ev?.data?.reason?.error?.code ?? ev?.data?.error?.code ?? null,
          status: ev?.data?.reason?.error?.status ?? null,
        };
      }
    }
  }

  const list = [...turns.values()].sort((a, b) => a.turn - b.turn);
  let overflowTurn = null;
  // 注意：会话日志是"累积"的，但请求体通常小于累积值——压缩会把旧历史折叠，
  // 且请求里还有日志里没有的隐藏字段。这里只报"原始累积第一次超过窗口"，
  // 作为量级提示，不作为"某次请求真的爆了"的证据。
  let acc = 0;
  const totalTokens = list.reduce((s, r) => s + r.tokens, 0);
  for (const r of list) {
    acc += r.tokens;
    if (overflowTurn === null && acc > window) overflowTurn = r.turn;
  }
  const heaviest = [...list].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return {
    turns: list,
    heaviest,
    overflowTurn,
    totalTokens,
    lastError,
    totalEvents: events.length,
    preludeEvents,
    badLines,
  };
}

export { estimateTokens, estimateTokensFromBytes };
