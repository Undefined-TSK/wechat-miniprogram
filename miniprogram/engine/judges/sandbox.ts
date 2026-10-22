/**
 * 判分器 · sandbox（占位）
 *
 * ⚠️ 这个判分器**永远不会真正判分**，它的存在只有一个目的：
 *    让「题型 ↔ 判分器」的覆盖自检通过。
 *
 * 背景：`services/judge.ts` 在题目带 localJudgeKey 时才调判分器，
 * 而 sandbox 策略的题目**永远不下发 localJudgeKey**（编译判分必须服务端做）。
 * 所以正常链路上这个函数根本不会被调用。
 *
 * 那为什么还要注册？因为 wiring 自检里有这么一条规则：
 *   「渲染器注册表里声明的每个 judgeStrategy，都必须在判分器注册表里存在」
 * 这条规则本身是对的（防止注册表引用一个不存在的判分器），
 * 但它无法区分「本地可执行的判分器」与「服务端策略」。
 *
 * 两种做法：
 *   ① 在自检里给服务端策略开白名单（把规则改复杂）
 *   ② 注册一个明确会报错的占位判分器（本文件的做法）
 *
 * 选 ②：规则保持不变（简单规则不容易随时间腐化），
 *      而且万一真的有代码绕过 service 直接调它，会立刻看到明确的错误信息，
 *      而不是一个含糊的「判分器未注册」。**fail loud 优于 fail silent**。
 */

import type { JudgeResult } from '../types';

export function judgeSandbox(userAnswer: unknown, judgeKey: unknown): JudgeResult {
  void userAnswer;
  void judgeKey;
  return {
    correct: false,
    partial: false,
    score: 0,
    detail:
      'sandbox 策略不能在客户端判分。这是设计使然：编译判分必须在服务端沙箱执行，' +
      '客户端不持有测试点。若你在本地看到这条信息，说明有代码绕过了 services/judge。',
    layer: 'remote',
    strategy: 'sandbox',
  };
}
