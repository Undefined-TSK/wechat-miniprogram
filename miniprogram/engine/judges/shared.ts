/**
 * 判分器公共工具
 * 所有文本归一化规则集中在这里，保证 5 个判分器的口径一致。
 */

import type { JudgeResult, Reveal } from '../types';

export function clamp01(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function unique(list: string[]): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    if (!seen[k]) {
      seen[k] = true;
      out.push(k);
    }
  }
  return out;
}

/** 全角 → 半角。只处理常见可见字符区间与全角空格，不误伤中文 */
export function toHalfWidth(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += input[i];
    }
  }
  return out;
}

export function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString);
  const s = asString(v);
  return s === '' ? [] : [s];
}

export interface TextRules {
  trim?: boolean;
  ignoreCase?: boolean;
  collapseSpaces?: boolean;
  stripAllSpace?: boolean;
  halfWidth?: boolean;
}

/** 按统一规则归一化文本。默认：全角转半角 + 去首尾空白 + 忽略大小写 */
export function applyTextRules(raw: string, rules?: TextRules | Record<string, unknown>): string {
  const r = (rules || {}) as TextRules;
  let s = raw;
  if (r.halfWidth !== false) s = toHalfWidth(s);
  if (r.stripAllSpace) {
    s = s.replace(/\s+/g, '');
  } else if (r.collapseSpaces) {
    s = s.trim().replace(/\s+/g, ' ');
  } else if (r.trim !== false) {
    s = s.trim();
  }
  if (r.ignoreCase !== false) s = s.toLowerCase();
  return s;
}

/**
 * 统一收口得分。
 * 规则：未开启 partialCredit 时强制二值化——部分匹配不给分，避免「蒙对一半」被计为得分。
 */
export function finalizeScore(
  rawScore: number,
  options: Record<string, unknown> | undefined,
  strategy: string,
  detail: string,
  reveal?: Reveal
): JudgeResult {
  const partialCredit = !!(options && options.partialCredit);
  const score = partialCredit ? clamp01(rawScore) : rawScore >= 1 ? 1 : 0;
  const correct = score >= 1 - 1e-9;
  return {
    correct: correct,
    partial: !correct && score > 0,
    score: score,
    detail: detail,
    layer: 'local',
    strategy: strategy,
    reveal: reveal,
  };
}
