/**
 * 判分器 · normalize（多答案归一化匹配）
 * 适用：填空、程序填空、名词解释（关键词版）。
 *
 * judgeKey 结构：
 *   { mode: 'single' | 'multi', accepted: string[] | string[][], pattern?: string }
 *   - single：accepted 为可接受答案数组，命中任一即可
 *   - multi ：accepted 为「每个空位的可接受答案数组」的数组，逐空判定
 *   - pattern：可选正则兜底（用于「任意合法写法」的开放答案），与 accepted 是「或」关系
 */

import type { JudgeResult } from '../types';
import { applyTextRules, asStringArray, finalizeScore, type TextRules } from './shared';

export interface NormalizeKey {
  mode?: 'single' | 'multi';
  accepted?: unknown;
  pattern?: string;
}

function toAcceptedGroups(raw: unknown, multi: boolean): string[][] {
  if (multi) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (g) {
      return asStringArray(g);
    });
  }
  return [asStringArray(raw)];
}

function matchOne(
  normalizedUser: string,
  rawUser: string,
  accepted: string[],
  pattern: string | undefined,
  rules: TextRules | undefined
): boolean {
  if (normalizedUser === '') return false;
  for (let i = 0; i < accepted.length; i++) {
    if (applyTextRules(accepted[i], rules) === normalizedUser) return true;
  }
  if (pattern) {
    try {
      const flags = rules && rules.ignoreCase === false ? '' : 'i';
      const re = new RegExp(pattern, flags);
      if (re.test(rawUser.trim())) return true;
    } catch (e) {
      // 题目配置了非法正则：忽略兜底通道，不让脏配置炸掉判分
    }
  }
  return false;
}

export function judgeNormalize(
  userAnswer: unknown,
  judgeKey: unknown,
  options?: Record<string, unknown>
): JudgeResult {
  const key = (judgeKey || {}) as NormalizeKey;
  const rules = options as TextRules | undefined;
  const multi = key.mode === 'multi';

  const userVals = asStringArray(userAnswer);
  const acceptedGroups = toAcceptedGroups(key.accepted, multi);

  const blankCount = multi ? Math.max(acceptedGroups.length, userVals.length) : 1;
  if (blankCount === 0) {
    return finalizeScore(0, options, 'normalize', '题目配置异常：未提供可接受答案', {});
  }

  let hitCount = 0;
  const revealAccepted: string[] = [];

  for (let i = 0; i < blankCount; i++) {
    const rawUser = userVals[i] || '';
    const normalizedUser = applyTextRules(rawUser, rules);
    const group = acceptedGroups[i] || [];
    if (matchOne(normalizedUser, rawUser, group, key.pattern, rules)) hitCount++;
    revealAccepted.push(group.length > 0 ? group[0] : key.pattern || '');
  }

  const raw = hitCount / blankCount;
  const allHit = hitCount === blankCount;
  const detail = allHit ? '回答正确' : '正确答案：' + revealAccepted.join(' / ');

  return finalizeScore(raw, options, 'normalize', detail, { acceptedText: revealAccepted });
}
