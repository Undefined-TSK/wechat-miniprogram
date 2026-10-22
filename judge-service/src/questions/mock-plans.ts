/**
 * ⚠️ 模拟判题计划 —— 仅用于本地开发与自检演示
 *
 * 生产环境这些数据在题库的 `judge_plans` 集合里，由题库后台录入与审核，
 * **只在判题服务侧存在**，绝不下发客户端。
 *
 * 本文件与 miniprogram/mock/bank.ts 的编程题一一对应，
 * 是「题目 ↔ 测试点」这条链路的本地实现。
 */

import type { JudgePlan } from '../questions/testcases';

/**
 * 题 5：读入 n，输出 1..n 的和。
 *
 * 测试点设计要点（这几个点是有意选的，不是随手写的）：
 *   1. 边界 n=1：循环写错（多算或少算一轮）在这里暴露
 *   2. 普通 n=5：基础功能
 *   3. **n=100000**：这是本题的核心考点——和超过 int 上限。
 *      用 int 的同学逻辑完全对，但会得到负数或错值。
 *   4. 隐藏点 n=99999：防止用户针对公开点硬编码
 */
export const PLAN_SUM_1_TO_N: JudgePlan = {
  questionId: 'q_c_0005',
  language: 'c',
  judgeMs: 1000,
  memoryMB: 256,
  compare: 'exact-lines',
  cases: [
    { index: 1, stdin: '1\n', expected: '1\n' },
    { index: 2, stdin: '5\n', expected: '15\n' },
    {
      index: 3,
      stdin: '100000\n',
      // 100000 × 100001 / 2 = 5000050000，超出 int 上限
      expected: '5000050000\n',
    },
    { index: 4, stdin: '99999\n', expected: '4999950000\n', hidden: true, runMs: 2000 },
  ],
};

/**
 * 题 6：读入若干整数直到 EOF，输出最大值。
 *
 * 测试点设计要点：
 *   1. 单个数：循环体一次都不执行也要正确
 *   2. 常规多值
 *   3. **全负数**：这是本题的核心陷阱——把初值写成 0 的同学在这里错
 *      4. 隐藏点：最大值在开头 / 在结尾，防止「只在特定位置更新」的实现蒙对
 */
export const PLAN_MAX_UNTIL_EOF: JudgePlan = {
  questionId: 'q_c_0006',
  language: 'c',
  judgeMs: 1000,
  memoryMB: 256,
  compare: 'exact-lines',
  cases: [
    { index: 1, stdin: '42\n', expected: '42\n' },
    { index: 2, stdin: '3 9 2 7\n', expected: '9\n' },
    { index: 3, stdin: '-5 -1 -9\n', expected: '-1\n', hidden: false },
    { index: 4, stdin: '100 1 2 3\n', expected: '100\n', hidden: true },
    { index: 5, stdin: '1 2 3 100\n', expected: '100\n', hidden: true },
  ],
};

/* ------------------------------------------------------------------ */
/* 以下是第一章「编程关」新增的题目                                      */
/* ------------------------------------------------------------------ */

/**
 * 题 43：判断闰年，输出 yes / no。
 *
 * 测试点设计要点：
 *   1. 普通闰年 2024：基础功能
 *   2. 普通平年 2023：基础功能
 *   3. **1900**：能被 4 整除但能被 100 整除 → 不是闰年。
 *      这是本题的核心陷阱——只判 `y % 4 == 0` 的实现会在这里错
 *   4. 2000：能被 400 整除 → 是闰年。与 1900 成对出现，卡住「只判 100 不判 400」的实现
 *   5. 隐藏点 2100：又一个「整百但不是 400 倍数」的年份，防止用户针对 1900 硬编码输出 no
 */
export const PLAN_LEAP_YEAR: JudgePlan = {
  questionId: 'q_c_0043',
  language: 'c',
  judgeMs: 1000,
  memoryMB: 256,
  compare: 'exact-lines',
  cases: [
    { index: 1, stdin: '2024\n', expected: 'yes\n' },
    { index: 2, stdin: '2023\n', expected: 'no\n' },
    { index: 3, stdin: '1900\n', expected: 'no\n' },
    { index: 4, stdin: '2000\n', expected: 'yes\n' },
    { index: 5, stdin: '2100\n', expected: 'no\n', hidden: true },
    { index: 6, stdin: '1\n', expected: 'no\n', hidden: true },
  ],
};

/**
 * 题 44：统计 1..n 中是 3 的倍数、但不是 5 的倍数的个数。
 *
 * 测试点设计要点：
 *   1. 样例 n=10 → 3
 *   2. n=1：答案 0。卡「差一错误」（把 i<=n 写成能多算一个）
 *   3. n=3 → 1
 *   4. n=15 → 3、6、9、12 是 3 的倍数（15 虽是 3 的倍数但是 5 的倍数，要排除）→ 4 个
 *      这一条同时考「3 的倍数」与「5 的倍数」两个条件的**取交集补集**关系
 *   5. 隐藏点 n=1000000：大数测试，检查是否有溢出或 O(n²) 写法导致超时
 */
export const PLAN_COUNT_MULT: JudgePlan = {
  questionId: 'q_c_0044',
  language: 'c',
  judgeMs: 1000,
  memoryMB: 256,
  compare: 'exact-lines',
  cases: [
    { index: 1, stdin: '10\n', expected: '3\n' },
    { index: 2, stdin: '1\n', expected: '0\n' },
    { index: 3, stdin: '3\n', expected: '1\n' },
    { index: 4, stdin: '15\n', expected: '4\n' },
    { index: 5, stdin: '1000000\n', expected: '266667\n', hidden: true, runMs: 2000 },
  ],
};

/**
 * 题 45：求非负整数各位数字之和。
 *
 * 测试点设计要点：
 *   1. **0**：核心边界。while (n > 0) 一次都不执行，必须输出 0
 *   2. 一位数 7 → 7
 *   3. 常规 12345 → 15
 *   4. 含 0 的 1002003 → 1+0+0+2+0+0+3 = 6，考「中间有零」不会提前终止循环
 *   5. 隐藏点 2000000000 → 2。卡 int 边界（能不能正确处理接近 int 上限的值）
 */
export const PLAN_DIGIT_SUM: JudgePlan = {
  questionId: 'q_c_0045',
  language: 'c',
  judgeMs: 1000,
  memoryMB: 256,
  compare: 'exact-lines',
  cases: [
    { index: 1, stdin: '0\n', expected: '0\n' },
    { index: 2, stdin: '7\n', expected: '7\n' },
    { index: 3, stdin: '12345\n', expected: '15\n' },
    { index: 4, stdin: '1002003\n', expected: '6\n' },
    { index: 5, stdin: '2000000000\n', expected: '2\n', hidden: true },
  ],
};

export const JUDGE_PLANS: JudgePlan[] = [
  PLAN_SUM_1_TO_N,
  PLAN_MAX_UNTIL_EOF,
  PLAN_LEAP_YEAR,
  PLAN_COUNT_MULT,
  PLAN_DIGIT_SUM,
];

/**
 * 生产用：按 (questionId, language) 建索引。
 * 注意这里是索引视图，不是数据副本——避免两处数据不一致。
 */
export function indexPlans(): Record<string, JudgePlan> {
  const out: Record<string, JudgePlan> = {};
  for (let i = 0; i < JUDGE_PLANS.length; i++) {
    const p = JUDGE_PLANS[i];
    out[p.questionId + '::' + p.language] = p;
  }
  return out;
}
