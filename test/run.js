/**
 * test/run.js —— 跑内建自测。保持一个入口，避免出现"测试脚本比被测代码还长"。
 */

import { selftest } from "../src/selftest.js";

const r = selftest();
for (const f of r.failures) console.error(`✗ ${f}`);
console.log(`\n${r.pass} passed, ${r.fail} failed`);
process.exitCode = r.fail === 0 ? 0 : 1;
