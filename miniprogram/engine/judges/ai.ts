/**
 * 判分器 · ai（占位）
 *
 * 与 sandbox.ts 同理：AI 语义判分必须在服务端调用模型，
 * 客户端既不持有评分要点，也不应该持有模型调用的凭证。
 *
 * 这个占位存在的唯一目的是让「渲染器声明的 judgeStrategy 必须已注册」
 * 这条自检规则保持简单。详见 sandbox.ts 顶部的取舍说明。
 *
 * Phase 5 接入 AI 网关后，真正的主观题判分链路是：
 *   客户端提交 → 云函数中转 → AI 网关 → 双通道交叉验证（AI 分 + 关键词分）
 *   → 分差 > 20 或置信度 < 0.7 时转人工 / 标「参考分」
 */

import type { JudgeResult } from '../types';

export function judgeAi(userAnswer: unknown, judgeKey: unknown): JudgeResult {
  void userAnswer;
  void judgeKey;
  return {
    correct: false,
    partial: false,
    score: 0,
    detail:
      'AI 主观题批改尚未接入（Phase 5）。该题型的评分要点只在服务端，客户端无法判分。',
    layer: 'remote',
    strategy: 'ai',
  };
}
