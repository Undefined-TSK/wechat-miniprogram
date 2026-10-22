/**
 * 判分器 · numeric（数值容差）
 * 适用：数值填空、计算结果（高数/线代）。
 *
 * judgeKey 结构：
 *   { value: number, tolerance?: number, mode?: 'abs' | 'rel' }
 *   tolerance 默认 1e-6；mode='rel' 时按相对误差判定
 */

import type { JudgeResult } from '../types';
import { asString, finalizeScore } from './shared';

export interface NumericKey {
  value: number;
  tolerance?: number;
  mode?: 'abs' | 'rel';
}

/** 去掉千分位、单位与全角空格，只留下数字与科学计数法符号 */
function extractNumber(input: string): number {
  const cleaned = input
    .replace(/[，,\s]/g, '')
    .replace(/[^\d.eE+\-]/g, '');
  return Number(cleaned);
}

export function judgeNumeric(
  userAnswer: unknown,
  judgeKey: unknown,
  options?: Record<string, unknown>
): JudgeResult {
  const key = (judgeKey || {}) as NumericKey;
  const target = Number(key.value);

  if (!isFinite(target)) {
    return finalizeScore(0, options, 'numeric', '题目配置异常：未提供有效数值答案', {});
  }

  const got = extractNumber(asString(userAnswer));
  const correctText = String(target);

  if (!isFinite(got)) {
    return finalizeScore(0, options, 'numeric', '无法识别为数值。正确答案：' + correctText, {
      correctText: correctText,
    });
  }

  const mode = key.mode || 'abs';
  const tol = typeof key.tolerance === 'number' ? key.tolerance : 1e-6;
  const limit = mode === 'rel' ? Math.abs(target) * tol : tol;
  const hit = Math.abs(got - target) <= limit + 1e-12;

  const detail = hit
    ? '回答正确'
    : '正确答案：' + correctText + '（容差 ' + limit + '）';

  return finalizeScore(hit ? 1 : 0, options, 'numeric', detail, { correctText: correctText });
}
