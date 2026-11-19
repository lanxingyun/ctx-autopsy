#!/usr/bin/env node
/**
 * ctx-autopsy —— 看你的 agent 上下文去了哪，以及它为什么死
 *
 * 为什么有它：一次真实事故里，一个 2.2M token 的请求撞穿了 1M 窗口，
 * 而 messages 只占 552k —— 剩下 1.64M 在一个没人数的隐藏字段里。
 * 现有工具要么只数 messages，要么要求你接 SDK、开代理、上 SaaS；
 * 这里只做一件事：**从现场的原始文件里把账算清楚。**
 *
 * 退出码：0 正常；1 检测到超窗；2 用法/解析错误。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLatestTarget, parseArgs } from "./args.js";
import { analyzeRequest, analyzeSession } from "./analyze.js";
import { findLatestSession, readJsonRequest, readSession } from "./parse.js";
import { prescribe } from "./prescribe.js";
import { fmtBytes, fmtTokens } from "./tokens.js";
import { selftest } from "./selftest.js";

const args = process.argv.slice(2);
const parsed = parseArgs(args);

function usage() {
  console.log(`ctx-autopsy — where your agent's context went, and why it died

Usage:
  ctx-autopsy request <file.json>       拆一次请求体的顶层字段
  ctx-autopsy session <file.jsonl[.zstd]|--latest>   按轮次拆会话日志
  ctx-autopsy --selftest                跑内建自测

Options:
  --window <n>     模型窗口，默认 1048576
  --top <n>        列表条数，默认 5
  --json           机器可读输出
  --latest         取 ~/.dsh/sessions 下最新的会话日志
  --prescribe      即使未超窗也打印处方

Exit: 0 ok · 1 overflow detected · 2 usage/parse error`);
}

function opt(name, fallback) {
  return parsed[name.slice(2)] ?? fallback;
}

function has(name) {
  return parsed[name.slice(2)] === true;
}

function cmdRequest(file) {
  const body = readJsonRequest(file);
  const window = opt("--window", 1_048_576);
  const r = analyzeRequest(body, { window });
  const plan = prescribe(body, r, { window });
  if (has("--json")) {
    console.log(JSON.stringify({ ...r, parts: r.parts.map(({ value, ...p }) => p), prescription: plan }, null, 2));
  } else {
    console.log(`request   ${file}`);
    console.log(
      `total     ${fmtBytes(r.totalBytes)} · ~${fmtTokens(r.totalTokens)} tok · window ${fmtTokens(r.window)} · ${
        r.overflow ? `OVER by ~${fmtTokens(r.overBy)}` : "fits"
      }`,
    );
    console.log("\nby top-level field");
    for (const p of r.parts) {
      console.log(
        `  ${p.key.padEnd(20)} ${p.kind.padEnd(9)} ${fmtBytes(p.bytes).padStart(10)}  ~${fmtTokens(p.tokens).padStart(8)}  ${(p.share * 100).toFixed(1).padStart(5)}%`,
      );
    }
    if (r.hidden.length) {
      console.log("\n⚠ 非对话字段（常规压缩碰不到，只能关掉/截断）");
      for (const p of r.hidden) {
        console.log(`  ${p.key} — ~${fmtTokens(p.tokens)} tok (${(p.share * 100).toFixed(1)}%)`);
      }
    }
    if (r.biggest.length) {
      console.log("\nlargest single messages (fold 的原子单位)");
      for (const m of r.biggest) {
        console.log(`  #${String(m.index).padEnd(4)} ${String(m.role).padEnd(10)} ${fmtBytes(m.bytes).padStart(10)}  ~${fmtTokens(m.tokens)}`);
      }
    }
    if (r.overflow || has("--prescribe")) {
      console.log(`\n处方（不同改动的最小组合，按风险从低到高）`);
      if (!plan.steps.length && !plan.unsplittable) {
        console.log("  装得下，不用改");
      }
      for (const s of plan.steps) {
        console.log(`  ${s.risk.padEnd(6)} −${fmtTokens(s.saves).padStart(7)}  ${s.note}`);
      }
      if (plan.unsplittable) console.log(`  ${plan.unsplittable}`);
      const tail = plan.fitsByPlan
        ? `→ 按此执行后 ~${fmtTokens(plan.after)} tok，装得下 ${fmtTokens(plan.window)}`
        : `→ 按此执行后仍 ~${fmtTokens(plan.after)} tok，超出 ${fmtTokens(plan.after - plan.window)}`;
      console.log(`  ${tail}`);
    }
  }
  return r.overflow ? 1 : 0;
}

function cmdSession(target) {
  let file = target;
  let latest = false;
  if (isLatestTarget(target, has("--latest"))) {
    file = findLatestSession(join(homedir(), ".dsh", "sessions"));
    latest = true;
  }
  if (!file || !existsSync(file)) {
    console.error(`no such session log: ${file ?? "(none)"}`);
    return 2;
  }
  const { events, badLines, format } = readSession(file);
  const r = analyzeSession(events, { window: opt("--window", 1_048_576), badLines });
  const top = opt("--top", 5);

  if (has("--json")) {
    console.log(JSON.stringify({ file, format, ...r }, null, 2));
  } else {
    const win = opt("--window", 1_048_576);
    console.log(`session   ${file}${latest ? " (latest)" : ""}`);
    console.log(
      `events    ${r.totalEvents}${r.badLines ? ` · ${r.badLines} unparsable line(s)` : ""} · format ${format}`,
    );
    console.log(
      `turns     ${r.turns.length} · cumulative ~${fmtTokens(r.totalTokens)} tok in this log (log bytes, not request size)`,
    );
    if (r.overflowTurn !== null) {
      console.log(
        `note      raw accumulation passed window ${fmtTokens(win)} at turn ${r.overflowTurn} — compaction may have folded history, so an actual request can be smaller`,
      );
    }
    if (r.lastError) {
      console.log(`\nlast error (turn ${r.lastError.turn})${r.lastError.code ? ` [${r.lastError.code}]` : ""}`);
      console.log(`  ${r.lastError.message.slice(0, 400)}`);
    }
    console.log("\nheaviest turns");
    for (const t of r.heaviest.slice(0, top)) {
      console.log(`  turn ${String(t.turn).padStart(4)}  ${fmtTokens(t.tokens).padStart(9)} tok  ${String(t.events).padStart(5)} events  ${fmtBytes(t.bytes)}`);
    }
  }
  // 会话模式只有"确实是一次超窗发送失败"才退 1；原始累积超窗不算证据
  const overflowed =
    r.lastError && (r.lastError.status === 413 || /outbound body/i.test(r.lastError.message ?? ""));
  return overflowed ? 1 : 0;
}

function main() {
  if (args.length === 0 || has("--help") || has("-h")) {
    usage();
    return 0;
  }
  if (has("--selftest")) {
    const r = selftest();
    console.log(`${r.pass} passed, ${r.fail} failed`);
    return r.fail === 0 ? 0 : 2;
  }
  if (parsed.unknown.length) {
    console.error(`unknown or invalid option: ${parsed.unknown.join(" ")}`);
    usage();
    return 2;
  }
  if (parsed.extra.length) {
    console.error(`unexpected argument(s): ${parsed.extra.join(" ")}`);
    usage();
    return 2;
  }
  if (parsed.cmd === "request" && has("--latest")) {
    console.error("--latest is only valid for session");
    usage();
    return 2;
  }
  if (has("--latest") && parsed.target) {
    console.error("--latest cannot be combined with a session file");
    usage();
    return 2;
  }
  if (parsed.cmd === "session" && has("--prescribe")) {
    console.error("--prescribe is only valid for request");
    usage();
    return 2;
  }
  const cmd = parsed.cmd;
  const target = parsed.target;
  try {
    if (cmd === "request") return cmdRequest(target);
    if (cmd === "session") return cmdSession(target);
    console.error(`unknown command: ${cmd}`);
    usage();
    return 2;
  } catch (e) {
    console.error(`ctx-autopsy: ${e.message}`);
    return 2;
  }
}

process.exitCode = main();
