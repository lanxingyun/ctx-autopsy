/**
 * selftest.js —— 内建自测（无框架、无依赖）
 *
 * 原则：测**真函数**，不测副本；每条断言都要能失败。
 * 这里用合成数据复现真实事故的形状，而不是拿一段"看起来像"的样例。
 */

import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRequest, analyzeSession, biggestMessages, classifyKey, decomposeRequest } from "./analyze.js";
import { findLatestSession, readJsonRequest, readSession, stripBanner } from "./parse.js";
import { prescribe } from "./prescribe.js";
import { estimateTokens } from "./tokens.js";

export function selftest() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  const check = (name, fn) => {
    try {
      fn();
      pass++;
    } catch (e) {
      fail++;
      failures.push(`${name}: ${e.message}`);
    }
  };

  const eq = (a, b, msg = "") => {
    if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  };
  const ok = (v, msg = "expected truthy") => {
    if (!v) throw new Error(msg);
  };

  // ---- tokens ----
  check("ascii token estimate ~4 chars/token", () => eq(estimateTokens("hello world"), 3));
  check("cjk counts 1 token per char", () => eq(estimateTokens("你好世界"), 4));
  check("mixed cjk+ascii", () => eq(estimateTokens("你好 hello"), 4));

  // ---- request decomposition ----
  check("classifyKey maps the big three", () => {
    eq(classifyKey("messages"), "messages");
    eq(classifyKey("system"), "system");
    eq(classifyKey("tools"), "tools");
    eq(classifyKey("dsh_session_log"), "hidden");
  });

  check("hidden field is detected by share", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      dsh_session_log: "日志".repeat(2000),
      max_tokens: 1024,
    };
    const r = analyzeRequest(body);
    ok(r.hidden.length === 1, "should flag exactly one hidden field");
    eq(r.hidden[0].key, "dsh_session_log");
    ok(r.hidden[0].share > 0.5, "hidden field should dominate bytes");
  });

  check("overflow is computed against window", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(4000) }] };
    ok(analyzeRequest(body, { window: 100 }).overflow, "small window should overflow");
    ok(!analyzeRequest(body, { window: 10_000_000 }).overflow, "huge window should fit");
  });

  check("decomposeRequest totals equal sum of parts", () => {
    const body = { system: "s".repeat(100), messages: [{ role: "user", content: "m".repeat(300) }], stream: true };
    const { parts, totalBytes } = decomposeRequest(body);
    eq(parts.reduce((s, p) => s + p.bytes, 0), totalBytes);
    eq(parts[0].bytes >= parts[1].bytes, true, "sorted desc");
  });

  check("biggestMessages sorts and labels", () => {
    const msgs = [
      { role: "user", content: "a".repeat(10) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "c".repeat(50) },
    ];
    const top = biggestMessages(msgs, 2);
    eq(top.length, 2);
    eq(top[0].index, 1);
    eq(top[0].role, "assistant");
  });

  // ---- session analysis ----
  const mkEvents = () => [
    { type: "turn/start", data: { turn: 1 } },
    { type: "tool/result", data: { turn: 1, text: "x".repeat(100) } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    { type: "turn/start", data: { turn: 2 } },
    { type: "tool/result", data: { turn: 2, text: "y".repeat(5000) } },
    { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
    { type: "turn/start", data: { turn: 3 } },
    {
      type: "turn/end",
      data: {
        turn: 3,
        reason: {
          kind: "error",
          error: { message: "outbound body measures ~2,215,206 tokens", code: "INVALID_REQUEST", status: 413 },
        },
      },
    },
  ];

  check("session groups events by turn", () => {
    const r = analyzeSession(mkEvents());
    eq(r.turns.length, 3);
    eq(r.turns[0].turn, 1);
    eq(r.totalEvents, 8);
  });

  check("session finds last error with code and message", () => {
    const r = analyzeSession(mkEvents());
    ok(r.lastError, "should capture error");
    eq(r.lastError.turn, 3);
    eq(r.lastError.code, "INVALID_REQUEST");
    ok(r.lastError.message.includes("2,215,206"));
  });

  check("session finds first cumulative overflow turn", () => {
    const r = analyzeSession(mkEvents(), { window: 1000 });
    eq(r.overflowTurn, 2); // turn1 ~30 tok, turn2 +5000 crosses
  });

  check("session keeps pre-turn events out of the turn table", () => {
    const r = analyzeSession([{ type: "model/selection", data: { model: "m" } }, ...mkEvents()]);
    eq(r.turns.length, 3);
    eq(r.totalEvents, 9);
    eq(r.preludeEvents, 1);
  });

  // ---- prescription ----
  check("no prescription when the body already fits", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const a = analyzeRequest(body, { window: 1_000_000 });
    const p = prescribe(body, a, { window: 1_000_000 });
    eq(p.needed, false);
    eq(p.steps.length, 0);
  });

  check("caps a dominant hidden field first (safe step)", () => {
    const body = { messages: [{ role: "user", content: "hi" }], dsh_session_log: "字".repeat(600_000) };
    const a = analyzeRequest(body, { window: 200_000 });
    const p = prescribe(body, a, { window: 200_000 });
    ok(p.steps.length > 0, "should propose at least one step");
    eq(p.steps[0].kind, "cap-field");
    eq(p.steps[0].risk, "safe");
    ok(p.fitsByPlan, `plan should fit, after=${p.after}`);
  });

  check("drops the largest tool when there is no hidden field", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ function: { name: "big", description: "x".repeat(40_000) } }],
    };
    const a = analyzeRequest(body, { window: 2_000 });
    const p = prescribe(body, a, { window: 2_000 });
    ok(p.steps.some((s) => s.kind === "drop-tool" && s.name === "big"), "should drop tool 'big'");
    ok(p.fitsByPlan, "dropping the tool should make it fit");
  });

  check("folds oldest history and labels risk", () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}`.padEnd(4_000, "y") }));
    const body = { messages };
    const a = analyzeRequest(body, { window: 12_000 });
    const p = prescribe(body, a, { window: 12_000 });
    const fold = p.steps.find((s) => s.kind === "fold-history");
    ok(fold, "should propose folding");
    ok(fold.folded > 0 && fold.folded < 20);
    ok(p.after <= 12_000, `should fit after folding, got ${p.after}`);
  });

  check("flags an oversized single message as unsplittable", () => {
    const body = { messages: [{ role: "user", content: "z".repeat(2_000_000) }] };
    const a = analyzeRequest(body, { window: 100_000 });
    const p = prescribe(body, a, { window: 100_000 });
    ok(p.unsplittable, "should report unsplittable");
    eq(p.fitsByPlan, false);
  });

  // ---- parsing ----
  check("stripBanner finds first brace", () => {
    eq(stripBanner('PLAINTEXT DUMP\nheader\n{"a":1}'), '{"a":1}');
  });

  check("readSession counts unparsable lines instead of dying", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxlens-"));
    try {
      const f = join(dir, "s.jsonl");
      writeFileSync(f, '{"type":"turn/start","data":{"turn":1}}\n{broken\n{"type":"turn/end","data":{"turn":1}}\n');
      const r = readSession(f);
      eq(r.events.length, 2);
      eq(r.badLines, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("readJsonRequest accepts a banner-prefixed dump", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxlens-"));
    try {
      const f = join(dir, "req.json");
      writeFileSync(f, 'PLAINTEXT DUMP (do not edit)\n{"messages":[{"role":"user","content":"hi"}]}');
      const body = readJsonRequest(f);
      eq(body.messages.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("findLatestSession walks two levels and picks newest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctxlens-"));
    try {
      const a = join(dir, "ws-a", "s1");
      const b = join(dir, "ws-b", "s2");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      const fa = join(a, "session.v4.jsonl.zstd");
      const fb = join(b, "session.v4.jsonl.zstd");
      writeFileSync(fa, "x");
      writeFileSync(fb, "y");
      const past = new Date(Date.now() - 60_000);
      utimesSync(fa, past, past);
      eq(findLatestSession(dir), fb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  return { pass, fail, failures };
}
