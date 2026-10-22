/**
 * ⚠️ 模拟客观题答案 —— 仅用于本地开发与自检演示
 *
 * 生产环境这些数据在题库的 `question_answers` 集合里，由题库后台录入与审核，
 * **只在判题服务侧存在**，绝不下发客户端。
 *
 * 本文件与 `miniprogram/mock/questions/boss-questions.ts` 一一对应，
 * 是「Boss 关题目 ↔ 服务端答案」这条链路的本地实现。
 *
 * ⚠️ 两道防线保证两边不分叉：
 *   1. `tests/wiring.test.mjs` 断言：**每个服务端判分的关卡里的每道题，
 *      这里都必须有对应答案**（缺了 → 用户提交必然 404）
 *   2. `tests/judge.test.mjs` 断言：这里的 `answer` 与客户端题库里同一题的
 *      `answer` **逐字节一致**（改了一边没改另一边就红）
 *
 *    第 2 条尤其重要 —— 它防的是「练习关判对、Boss 关判错」这种
 *    最难排查的漂移：两边数据看着都对，只是不一样。
 */

import type { ObjectiveAnswer } from './answers';

/**
 * Boss 关 6 道题的答案。
 *
 * 题型与策略的对应（必须与客户端 TYPE_STRATEGY / OBJECTIVE_TYPE_STRATEGY 一致）：
 *   program-output → output
 *   single-choice  → exact
 *
 * 判分选项必须与客户端题库里 `judge.options` 一致，
 * 否则会出现「同一题在服务端的判分口径与题库声明不符」。
 */
export const OBJECTIVE_ANSWERS: ObjectiveAnswer[] = [
  /* q_c_0050 · 整数除法 + 取模 + 优先级（程序输出） */
  {
    questionId: 'q_c_0050',
    type: 'program-output',
    strategy: 'output',
    answer: { expected: ['15', '2', '-2'] },
    options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false },
    note: 'Boss 关 · 三个坑叠加',
  },

  /* q_c_0051 · 短路求值 + 副作用（程序输出） */
  {
    questionId: 'q_c_0051',
    type: 'program-output',
    strategy: 'output',
    answer: { expected: ['1 1 0 0', '0 0 0'] },
    options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false },
    note: 'Boss 关 · 短路改变程序状态',
  },

  /* q_c_0052 · sizeof / 字符串字面量 / 数组长度（程序输出） */
  {
    questionId: 'q_c_0052',
    type: 'program-output',
    strategy: 'output',
    answer: { expected: ['6 16', '6', '4 4'] },
    options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false },
    note: 'Boss 关 · "hello" 是 6 字节',
  },

  /* q_c_0053 · 位运算（程序输出） */
  {
    questionId: 'q_c_0053',
    type: 'program-output',
    strategy: 'output',
    answer: { expected: ['3', '4', '7', '6'] },
    options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false },
    note: 'Boss 关 · 含一个看起来像规律其实是巧合的结果',
  },

  /* q_c_0054 · 数组越界（单选） */
  {
    questionId: 'q_c_0054',
    type: 'single-choice',
    strategy: 'exact',
    answer: 'B',
    options: {},
    note: 'Boss 关 · off-by-one',
  },

  /* q_c_0055 · 字符码值（单选） */
  {
    questionId: 'q_c_0055',
    type: 'single-choice',
    strategy: 'exact',
    answer: 'D',
    options: {},
    note: 'Boss 关 · 常用 ASCII 码值',
  },
];

/**
 * 生产用：按 questionId 建索引。
 * 注意这里是索引视图，不是数据副本 —— 避免两处数据不一致。
 */
export function indexAnswers(): Record<string, ObjectiveAnswer> {
  const out: Record<string, ObjectiveAnswer> = {};
  for (let i = 0; i < OBJECTIVE_ANSWERS.length; i++) {
    const a = OBJECTIVE_ANSWERS[i];
    out[a.questionId] = a;
  }
  return out;
}
