/**
 * 判分器 · output（程序阅读与输出）
 * 适用：给出代码，让用户写出运行结果。
 *
 * 比对口径（可配置）：
 *  - 行尾空白一律忽略（换行符差异、编辑器自动补空格不影响判分）
 *  - 行首空白默认保留（printf 的对齐输出是有意义的），options.trimStart = true 时忽略
 *  - 末尾空行默认忽略，options.ignoreTrailingBlank = false 时保留
 *  - options.ignoreCase / options.collapseSpaces 默认 false
 */

import type { JudgeResult } from '../types';
import { asString, finalizeScore } from './shared';

export interface OutputKey {
  expected: string[] | string;
}

function splitLines(raw: unknown): string[] {
  let s = '';
  if (typeof raw === 'string') {
    s = raw;
  } else if (Array.isArray(raw)) {
    s = raw.map(asString).join('\n');
  } else {
    s = asString(raw);
  }
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(function (line) {
      return line.replace(/\s+$/, '');
    });
}

function dropTrailingBlank(lines: string[]): string[] {
  const out = lines.slice();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

export function judgeOutput(
  userAnswer: unknown,
  judgeKey: unknown,
  options?: Record<string, unknown>
): JudgeResult {
  const key = (judgeKey || {}) as OutputKey;
  const opts = options || {};

  const ignoreTrailingBlank = opts.ignoreTrailingBlank !== false;
  const trimStart = !!opts.trimStart;
  const ignoreCase = !!opts.ignoreCase;
  const collapseSpaces = !!opts.collapseSpaces;

  let expected = splitLines(key ? key.expected : []);
  let actual = splitLines(userAnswer);

  if (ignoreTrailingBlank) {
    expected = dropTrailingBlank(expected);
    actual = dropTrailingBlank(actual);
  }

  if (expected.length === 0) {
    return finalizeScore(0, options, 'output', '题目配置异常：未提供期望输出', {});
  }

  const norm = function (line: string): string {
    let s = line;
    if (trimStart) s = s.replace(/^\s+/, '');
    if (collapseSpaces) s = s.replace(/\s+/g, ' ');
    if (ignoreCase) s = s.toLowerCase();
    return s;
  };

  const totalRef = Math.max(expected.length, actual.length);
  let matched = 0;
  let firstDiff = -1;

  for (let i = 0; i < totalRef; i++) {
    const e = i < expected.length ? norm(expected[i]) : null;
    const a = i < actual.length ? norm(actual[i]) : null;
    if (e !== null && a !== null && e === a) {
      matched++;
    } else if (firstDiff < 0) {
      firstDiff = i;
    }
  }

  const raw = totalRef === 0 ? 0 : matched / totalRef;
  const allHit = matched === totalRef;

  let detail = '';
  if (allHit) {
    detail = '输出完全正确';
  } else if (expected.length !== actual.length) {
    detail =
      '输出行数不一致：期望 ' +
      expected.length +
      ' 行，实际 ' +
      actual.length +
      ' 行。期望输出：' +
      expected.join(' / ');
  } else {
    detail =
      '第 ' +
      (firstDiff + 1) +
      ' 行不符合预期（期望「' +
      expected[firstDiff] +
      '」，实际「' +
      (actual[firstDiff] || '空') +
      '」）';
  }

  return finalizeScore(raw, options, 'output', detail, { expectedLines: expected });
}
