/**
 * 判分器 · set（集合相等，多项选择）
 *
 * 规则：
 *  1. 多选了错误项 → 0 分（不允许蒙）
 *  2. 全部选对 → 满分
 *  3. 漏选但无错选 → 开启 partialCredit 时按 命中数/正确总数 给分，否则 0 分
 */

import type { JudgeResult } from '../types';
import { asStringArray, finalizeScore, unique } from './shared';

function upper(list: string[]): string[] {
  return list.map(function (k) {
    return k.trim().toUpperCase();
  });
}

export function judgeSet(
  userAnswer: unknown,
  judgeKey: unknown,
  options?: Record<string, unknown>
): JudgeResult {
  const selected = unique(upper(asStringArray(userAnswer)));
  const correctKeys = unique(upper(asStringArray(judgeKey)));
  const total = correctKeys.length;

  if (total === 0) {
    return finalizeScore(0, options, 'set', '题目配置异常：未提供正确选项', { correctKeys: [] });
  }

  const hit = selected.filter(function (k) {
    return correctKeys.indexOf(k) >= 0;
  });
  const wrong = selected.filter(function (k) {
    return correctKeys.indexOf(k) < 0;
  });
  const missed = correctKeys.filter(function (k) {
    return selected.indexOf(k) < 0;
  });

  let raw = 0;
  let detail = '';

  if (wrong.length > 0) {
    raw = 0;
    detail = '多选了错误项：' + wrong.join('、') + '。正确答案：' + correctKeys.join('、');
  } else if (missed.length === 0) {
    raw = 1;
    detail = '回答完全正确';
  } else {
    raw = hit.length / total;
    detail = '漏选 ' + missed.join('、') + '。正确答案：' + correctKeys.join('、');
  }

  return finalizeScore(raw, options, 'set', detail, { correctKeys: correctKeys });
}
