/**
 * prescribe.js —— 不只是诊断，给最小改动的处方
 *
 * 现有工具（context-lens、ccusage）回答"窗口里都是什么"；没人回答
 * "**最小改哪一处，这次就不会爆**"。而事故复盘真正要的是后者：
 * 加一条上限、砍一个工具定义、折一段历史，哪个先做、省多少、风险多大。
 *
 * 处方分三档（按"会不会伤语义"排序）：
 *   - 安全：给请求级隐藏字段加上限（它通常不是对话内容，压它不丢上下文）
 *   - 中等：去掉用不到的工具定义（模型少一个可选动作）
 *   - 有损：折叠最旧的历史（丢掉早期上下文）
 *
 * 处方只在"确实还差一截"时给；已经装得下就明说不用改。
 */

import { estimateTokens } from "./tokens.js";

const SAFE_CAP = 512 * 1024; // 512 KiB：真实事故里验证过的保守上限

function toolEntries(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools
    .map((t, i) => {
      const text = JSON.stringify(t) ?? "";
      return {
        index: i,
        name: t?.function?.name ?? t?.name ?? `tools[${i}]`,
        bytes: Buffer.byteLength(text, "utf8"),
        tokens: estimateTokens(text),
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * @param {object} body 原始请求体
 * @param {object} analysis analyzeRequest() 的结果
 * @param {{window?:number}} opts
 */
export function prescribe(body, analysis, { window = 1_048_576 } = {}) {
  const steps = [];
  let remaining = analysis.totalTokens;
  const deficit = remaining - window;

  if (deficit <= 0) {
    return { needed: false, steps: [], before: analysis.totalTokens, after: analysis.totalTokens, window };
  }

  // 1) 隐藏字段上限：只对超过 SAFE_CAP 的字段提议，省下的就是超出部分
  const hidden = analysis.parts.filter((p) => p.kind === "hidden" && p.bytes > SAFE_CAP);
  for (const p of hidden) {
    if (remaining <= window) break;
    const ratio = SAFE_CAP / p.bytes;
    const saved = Math.floor(p.tokens * (1 - ratio));
    steps.push({
      kind: "cap-field",
      field: p.key,
      capBytes: SAFE_CAP,
      saves: saved,
      risk: "safe",
      note: `把 ${p.key} 序列化上限设到 ${(SAFE_CAP / 1024).toFixed(0)} KiB（非对话内容，不丢上下文）`,
    });
    remaining -= saved;
  }

  // 2) 去掉用不到的大工具定义：只建议"省得动"的。
  //    小工具（省 <2% 缺口）不值得用"能力面变窄"去换，直接跳过、留给折叠。
  const material = Math.max(500, deficit * 0.02);
  if (remaining > window) {
    for (const t of toolEntries(body).slice(0, 3)) {
      if (remaining <= window) break;
      if (t.tokens < material) continue;
      steps.push({
        kind: "drop-tool",
        name: t.name,
        saves: t.tokens,
        risk: "medium",
        note: `移除工具定义 ${t.name}（模型少一个可调用的动作，能力面变窄）`,
      });
      remaining -= t.tokens;
    }
  }

  // 3) 折叠最旧的历史：按消息顺序累加，直到够
  //    单条就超过窗口的消息不能靠"折叠"解决（折叠它等于截断内容），跳过并单列
  const oversizedIndex =
    analysis.biggest[0] && analysis.biggest[0].tokens > window ? analysis.biggest[0].index : -1;
  if (remaining > window) {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    let acc = 0;
    let folded = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (remaining <= window) break;
      if (i === oversizedIndex) continue;
      const m = msgs[i];
      const tok = estimateTokens(typeof m === "string" ? m : JSON.stringify(m) ?? "");
      acc += tok;
      folded += 1;
      remaining -= tok;
    }
    if (folded > 0) {
      const ratio = msgs.length ? folded / msgs.length : 1;
      steps.push({
        kind: "fold-history",
        folded,
        total: msgs.length,
        saves: acc,
        risk: ratio > 0.5 ? "high" : "medium",
        note: `折叠最旧的 ${folded}/${msgs.length} 条消息（${ratio > 0.5 ? "会丢掉大部分早期上下文" : "会丢掉早期上下文"}）`,
      });
    }
  }

  // 单条消息就超过窗口：折叠救不了，必须让生产方拆分
  const largest = analysis.biggest[0];
  const unsplittable =
    remaining > window && largest && largest.tokens > window
      ? `单条消息 #${largest.index}（${largest.role}）约 ${largest.tokens} tok，已超过窗口本身——折叠无法解决，必须让生产方拆分这条消息`
      : null;

  const fits = remaining <= window;
  const netSaved = analysis.totalTokens - remaining;
  return {
    needed: !fits,
    steps,
    before: analysis.totalTokens,
    after: remaining,
    saved: netSaved,
    window,
    fitsByPlan: fits,
    unsplittable,
  };
}
