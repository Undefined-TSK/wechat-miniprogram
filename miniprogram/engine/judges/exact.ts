/**
 * 判分器 · exact（精确匹配）
 * 适用：单项选择、判断、答案唯一的填空。
 * 归一化后完全相等才得分。
 */

import type { JudgeResult } from '../types';
import { applyTextRules, asString, finalizeScore, type TextRules } from './shared';

export function judgeExact(
  userAnswer: unknown,
  judgeKey: unknown,
  options?: Record<string, unknown>
): JudgeResult {
  const rules = options as TextRules | undefined;
  const user = applyTextRules(asString(userAnswer), rules);
  const expect = asString(judgeKey);
  const target = applyTextRules(expect, rules);
  const hit = user !== '' && user === target;
  const detail = hit ? '回答正确' : '正确答案：' + expect;
  return finalizeScore(hit ? 1 : 0, options, 'exact', detail, { correctKeys: [expect] });
}
