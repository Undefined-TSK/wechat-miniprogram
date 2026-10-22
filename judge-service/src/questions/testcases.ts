/**
 * 判题服务 · 测试用例集与校验
 *
 * 测试点是**服务端资产**，与题目一起存在题库里，永远不下发客户端。
 * 隐藏测试点（hidden）不回传输入与期望输出，这是防泄题的基本要求：
 * 否则用户提交一次错误代码，就能从返回体里把全部期望输出抄出来。
 */

import { MAX_OUTPUT_BYTES, type JudgeLanguage } from '../contract';

export interface TestCase {
  /** 从 1 开始 */
  index: number;
  stdin: string;
  expected: string;
  /** 隐藏测试点：不回传输入/期望/实际输出 */
  hidden?: boolean;
  /** 该测试点单独的超时覆盖（毫秒），不填用题目默认 */
  runMs?: number;
  /** 该测试点单独的内存覆盖（MB） */
  memoryMB?: number;
}

export interface JudgePlan {
  questionId: string;
  language: JudgeLanguage;
  cases: TestCase[];
  judgeMs: number;
  memoryMB: number;
  /** 期望输出的比对口径 */
  compare?: CompareMode;
  /** 题目级版权与状态提示（仅服务端日志用，不下发） */
  note?: string;
}

export type CompareMode =
  /** 严格逐字节（去掉行尾空白与末尾空行）——默认 */
  | 'exact-lines'
  /** 忽略行首行尾与连续空白 */
  | 'collapse'
  /** 浮点容差：每行按浮点数比较，容差 1e-6 或指定值  */
  | 'numeric';

export interface PlanValidation {
  ok: boolean
  errors: string[];
  warnings: string[];
}

const SUPPORTED: JudgeLanguage[] = ['c', 'cpp', 'python'];

export function validatePlan(plan: JudgePlan): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan) return { ok: false, errors: ['判题计划为空'], warnings: [] };
  if (!plan.questionId) errors.push('缺少 questionId');
  if (SUPPORTED.indexOf(plan.language) < 0) errors.push('不支持的语言：' + String(plan.language));

  if (!Array.isArray(plan.cases) || plan.cases.length === 0) {
    errors.push('至少需要一个测试点');
  } else {
    for (let i = 0; i < plan.cases.length; i++) {
      const c = plan.cases[i];
      if (typeof c.stdin !== 'string') errors.push('第 ' + (i + 1) + ' 个测试点 stdin 必须是字符串');
      if (typeof c.expected !== 'string') errors.push('第 ' + (i + 1) + ' 个测试点 expected 必须是字符串');
      if (c.expected.length > MAX_OUTPUT_BYTES) {
        errors.push('第 ' + (i + 1) + ' 个测试点期望输出超过上限，无法可靠比对');
      }
    }

    const hiddenCount = plan.cases.filter(function (c) {
      return !!c.hidden;
    }).length;
    if (hiddenCount === 0) {
      // 不阻止发布，但要提醒：全公开测试点意味着用户能靠猜通过
      warnings.push('没有任何隐藏测试点，编程题容易被硬编码答案通过');
    }
  }

  if (!(plan.judgeMs > 0)) errors.push('judgeMs 必须为正数');
  if (!(plan.memoryMB > 0)) errors.push('memoryMB 必须为正数');

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

/**
 * 期望输出比对。
 *
 * 与 L1 的 output 判分器保持同一口径（行尾空白与末尾空行忽略），
 * 但**多一层 hidden 保护**：调用方只有在拿到真实输出后才有机会比对，
 * 而返回给客户端的 preview 由 buildPreviews 决定。
 */
export function compareOutput(
  actual: string,
  expected: string,
  mode: CompareMode = 'exact-lines',
  tolerance = 1e-6
): boolean {
  const a = normalizeLines(actual, mode);
  const e = normalizeLines(expected, mode);
  if (a.length !== e.length) return false;

  for (let i = 0; i < e.length; i++) {
    if (mode === 'numeric') {
      const na = Number(a[i].replace(/[^\d.eE+\-]/g, ''));
      const ne = Number(e[i].replace(/[^\d.eE+\-]/g, ''));
      if (isFinite(na) && isFinite(ne)) {
        const limit = Math.abs(ne) * tolerance || tolerance;
        if (Math.abs(na - ne) > limit + 1e-12) return false;
        continue;
      }
    }
    if (a[i] !== e[i]) return false;
  }
  return true;
}

function normalizeLines(raw: string, mode: CompareMode): string[] {
  const lines = String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(function (line) {
      if (mode === 'collapse') return line.trim().replace(/\s+/g, ' ');
      return line.replace(/\s+$/, '');
    });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 生成回传给客户端的 preview。
 *
 * ⚠️ 这是**防泄题的唯一执行点**：hidden 测试点的三个 preview 一律清空。
 * 不要因为「调试方便」加开关把它打开——那就是把题库交出去。
 */
export function buildPreviews(
  c: TestCase,
  actual: string,
  passed: boolean
): { stdinPreview?: string; expectedPreview?: string; actualPreview?: string } {
  if (c.hidden) return {};

  const limit = 512;
  return {
    stdinPreview: clip(c.stdin, limit),
    expectedPreview: clip(c.expected, limit),
    // 通过时不回传实际输出：省带宽，也少一个「用输出反推测试点」的面
    actualPreview: passed ? undefined : clip(actual, limit),
  };
}

function clip(s: string, limit: number): string {
  if (!s) return '';
  return s.length <= limit ? s : s.slice(0, limit) + '…';
}
