/**
 * tokens.js —— 粗略 token 估算（CJK 感知）
 *
 * 为什么不用 tiktoken：它要装包、要下编码表、且对中文/日文/韩文仍然按 BPE 切，
 * 一个 CLI 起步不该带 2 MB 依赖。我们只需要"哪个字段在吃窗口"的相对判断，
 * 误差 10% 不影响结论；绝对数交给 provider 的 usage 行。
 *
 * 口径（与常见中英混合文本实测偏差约 ±15%）：
 *   - CJK 字符（汉字/假名/谚文）≈ 1 token/字
 *   - 其余非空白字符 ≈ 4 字符/token
 *   - 换行与连续空白 ≈ 0（折行不改变 token 量级）
 */

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

export function countCjk(text) {
  if (!text) return 0;
  const m = text.match(CJK);
  return m ? m.length : 0;
}

export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = countCjk(text);
  // 去掉 CJK 与空白后剩下的字符按 4:1 估
  const rest = text
    .replace(CJK, "")
    .replace(/\s+/g, " ")
    .trim();
  return Math.ceil(cjk + rest.length / 4);
}

export function estimateTokensFromBytes(buf) {
  return estimateTokens(buf.toString("utf8"));
}

export function fmtTokens(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
