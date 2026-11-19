/**
 * test/cli.js —— CLI 契约矩阵
 *
 * 单元测试只证明 parseArgs 的输出；这里证明 CLI 真正拿到参数后怎么退出。
 * 每次抓到的洞（--latest 不找日志、无效 --window 静默回落、多余位置参数被丢）
 * 都应在这里留一格，避免下一次又在“解析对了、消费错了”处漏掉。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "ctx-autopsy-cli-"));
const req = join(dir, "req.json");
writeFileSync(
  req,
  JSON.stringify({
    model: "test",
    messages: [{ role: "user", content: "hello ".repeat(5000) }],
  }),
);

let pass = 0;
const failures = [];

function run(name, args, wantStatus, wantPattern) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== wantStatus) {
    failures.push(`${name}: exit ${r.status}, want ${wantStatus}\n${out.slice(0, 500)}`);
    return;
  }
  if (wantPattern && !wantPattern.test(out)) {
    failures.push(`${name}: output missing ${wantPattern}\n${out.slice(0, 500)}`);
    return;
  }
  pass++;
}

try {
  run("--help", ["--help"], 0, /Usage:/);
  run("fits", ["request", req], 0, /fits/);
  run("overflow", ["request", req, "--window", "100"], 1, /OVER by/);
  run("invalid window", ["request", req, "--window", "abc"], 2, /unknown or invalid option: --window/);
  run("unknown flag", ["request", req, "--bogus"], 2, /unknown or invalid option: --bogus/);
  run("extra positional", ["request", req, "extra.json"], 2, /unexpected argument\(s\): extra.json/);
  run("latest + file", ["request", req, "--latest"], 2, /cannot be combined/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (const f of failures) console.error(`✗ ${f}`);
console.log(`${pass} passed, ${failures.length} failed`);
process.exitCode = failures.length === 0 ? 0 : 1;
