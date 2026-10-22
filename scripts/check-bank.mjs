/**
 * 题库体检脚本
 *
 * 用法：
 *   node scripts/check-bank.mjs            # 跑校验，有问题则退出码非 0
 *   node scripts/check-bank.mjs --stats    # 附带题库统计
 *
 * ⚠️ 为什么放在 scripts 而不是 tests：
 *    tests 是「回归防线」（每次提交必跑，失败即阻断）；
 *    scripts 是「录题工具」（录题时反复跑、看具体哪条有问题）。
 *    两者的输出诉求不同：测试要简洁，工具要详细。
 *    但**两者共用同一份校验逻辑**（miniprogram/mock/bank-validator.ts）。
 */

import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

register('../tests/ts-resolver.mjs', import.meta.url);

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ⚠️ Windows 上必须用 pathToFileURL —— 直接传 'D:/...' 给 import()
//    会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（Node 只认 file:/data:/node: 协议）
const bank = await import(pathToFileURL(path.join(ROOT, 'miniprogram/mock/bank.ts')).href);
const { validateBank, summarizeIssues } = await import(
  pathToFileURL(path.join(ROOT, 'miniprogram/mock/bank-validator.ts')).href
);

const issues = validateBank({
  subjects: bank.SUBJECTS,
  chapters: bank.CHAPTERS,
  knowledgePoints: bank.KNOWLEDGE_POINTS,
  levels: bank.LEVELS,
  questions: bank.QUESTIONS,
});

const withStats = process.argv.indexOf('--stats') >= 0;

if (withStats) {
  printStats(bank);
}

if (issues.length === 0) {
  console.log('\n题库校验通过：' + bank.QUESTIONS.length + ' 道题、' +
    bank.LEVELS.length + ' 个关卡，无问题。');
  process.exit(0);
}

console.log('\n题库校验发现 ' + issues.length + ' 个问题（' + summarizeIssues(issues) + '）：\n');
for (const it of issues) {
  console.log('  ✗ [' + it.kind + '] ' + it.message);
}
console.log('');
process.exit(1);

/* ------------------------------------------------------------------ */

function printStats(b) {
  console.log('='.repeat(60));
  console.log('题库统计');
  console.log('='.repeat(60));

  // 按题型
  const byType = {};
  for (const q of b.QUESTIONS) byType[q.type] = (byType[q.type] || 0) + 1;
  console.log('\n题型分布：');
  for (const t of Object.keys(byType).sort()) {
    console.log('  ' + pad(t, 18) + byType[t] + ' 题');
  }

  // 按知识点
  const byKp = {};
  for (const q of b.QUESTIONS) {
    for (const kp of q.kpIds || []) byKp[kp] = (byKp[kp] || 0) + 1;
  }
  console.log('\n知识点覆盖：');
  for (const kp of b.KNOWLEDGE_POINTS) {
    const n = byKp[kp.id] || 0;
    const flag = n === 0 ? '  ⚠️ 无题' : '';
    console.log('  ' + pad(kp.name, 24) + n + ' 题' + flag);
  }

  // 按关卡
  console.log('\n关卡列表：');
  for (const lv of b.LEVELS) {
    console.log('  ' + pad(lv.id, 18) + pad(lv.mode, 11) + lv.questionIds.length + ' 题  ' + lv.name);
  }

  console.log('\n难度分布：');
  const byDiff = {};
  for (const q of b.QUESTIONS) byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
  for (const d of Object.keys(byDiff).sort()) {
    console.log('  难度 ' + d + '：' + byDiff[d] + ' 题');
  }
  console.log('');
}

function pad(s, n) {
  s = String(s);
  // 中文按 2 个宽度算，否则表格对不齐
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  const spaces = Math.max(0, n - width);
  return s + ' '.repeat(spaces);
}
