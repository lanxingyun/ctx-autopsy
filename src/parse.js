/**
 * parse.js —— 读三种真实存在的东西
 *
 *   1) 压缩后的 agent 会话日志（jsonl.zstd，每行一个事件）
 *   2) 明文 jsonl 会话日志
 *   3) 一次请求的请求体快照（.json，可能带一段人写的前导说明）
 *
 * 为什么容错这么宽松：这些文件是"事故现场"，本来就残缺——写了一半的行、
 * 被截断的 zstd 帧、上面盖了一行 "PLAINTEXT DUMP" 的 banner。工具的价值在于
 * 从残缺里读出结论，而不是要求现场整洁。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export function readZstd(file) {
  let raw;
  try {
    raw = zstdDecompressSync(readFileSync(file));
  } catch (e) {
    // 截断的 zstd 帧：解不出来就是解不出来，如实返回
    const err = new Error(`zstd decode failed: ${e.message}`);
    err.code = "ZSTD";
    throw err;
  }
  return raw;
}

export function stripBanner(text) {
  const i = text.indexOf("{");
  return i <= 0 ? text : text.slice(i);
}

export function readJsonRequest(file) {
  const raw = readFileSync(file, "utf8");
  return JSON.parse(stripBanner(raw));
}

/**
 * 读会话日志。返回 { events, badLines, format }。
 * 事件形状不强求：只要求是对象，且可能有 type / seq / time / data。
 */
export function readSession(file) {
  const isZstd = file.toLowerCase().endsWith(".zstd");
  const text = isZstd ? readZstd(file).toString("utf8") : readFileSync(file, "utf8");
  const events = [];
  let badLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object") events.push(o);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { events, badLines, format: isZstd ? "jsonl.zstd" : "jsonl" };
}

/** 找目录下最新的会话日志（支持 <dir>/<工作区>/<会话>/file 两层） */
export function findLatestSession(root) {
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (n === "session.v4.jsonl.zstd" || n.endsWith(".jsonl.zstd")) {
        candidates.push({ file: p, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}
