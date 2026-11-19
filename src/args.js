/**
 * args.js —— 命令行参数解析
 *
 * 原先 cli.js 直接拿 args[1] 当文件，导致 `request --prescribe file.json`
 * 或 `session --window 100 --latest` 把选项当文件名。选项应可放在命令后任意位置。
 */

const VALUE_FLAGS = new Set(["--window", "--top"]);

export function parseArgs(argv) {
  const out = {
    cmd: null,
    target: null,
    window: null,
    top: null,
    json: false,
    latest: false,
    prescribe: false,
    selftest: false,
    help: false,
    unknown: [],
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const raw = argv[i + 1];
      const n = Number(raw);
      // 缺值 / 非数字 / 非正数都必须报错；否则 `--window abc` 会静默回落到默认窗口，
      // 用户拿着“fits”结论却不知道窗口根本没按他的值算。
      if (raw === undefined || raw === "" || !Number.isFinite(n) || n <= 0) {
        out.unknown.push(a);
      } else {
        out[a.slice(2)] = n;
        i++;
      }
      continue;
    }
    if (a === "--json") out.json = true;
    else if (a === "--latest") out.latest = true;
    else if (a === "--prescribe") out.prescribe = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("-")) out.unknown.push(a);
    else positional.push(a);
  }

  out.cmd = positional[0] ?? null;
  out.target = positional[1] ?? null;
  out.extra = positional.slice(2);
  return out;
}

/**
 * `--latest` 是布尔选项，解析后 target 为 null；不能再拿 target === undefined 判。
 * 这个函数单独存在，是为了让这条 CLI 级条件能被自测直接测到。
 */
export function isLatestTarget(target, latest) {
  return latest === true && (target == null || target === "--latest");
}
