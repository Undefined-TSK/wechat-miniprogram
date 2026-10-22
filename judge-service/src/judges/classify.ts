/**
 * 判题服务 · 结果分类
 *
 * 这是整个判题链路里最值钱的一段逻辑：把「容器退出码 + 信号 + 输出 + 耗时 + 内存」
 * 翻译成用户能看懂的判题结论。
 *
 * 之所以单独成文件并且是纯函数，是因为**分类错了会静默误导用户**：
 * 把段错误判成答案错误，用户会去改逻辑；把超时判成内存超限，用户会去优化空间复杂度。
 * 这类错误没有异常、没有日志，只能靠单测覆盖。
 */

import { MAX_OUTPUT_BYTES, type JudgeLimits, type JudgeVerdict } from '../contract';

export interface RawExecution {
  /** 编译是否通过 */
  compiled: boolean;
  /** 编译器输出（CE 时给用户看） */
  compileMessage?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  /** 峰值内存 KB */
  peakMemoryKB: number;
  /** 是否被墙钟超时杀掉 */
  timedOut: boolean;
  /** 输出是否被截断 */
  outputTruncated: boolean;
  /** 期望输出（服务端有，客户端没有） */
  expected: string;
  /** 比对结果 */
  outputMatched: boolean;
}

export interface ClassifyResult {
  verdict: JudgeVerdict;
  /** 给运维/日志的判定依据（不给用户看） */
  reason: string;
}

/** 常见致命信号 → 人类可读说明。这些信号意味着「不是答案错，是程序崩了」 */
export const SIGNAL_TEXT: Record<string, string> = {
  SIGSEGV: '段错误（访问了非法内存，常见于数组越界、空指针解引用）',
  SIGBUS: '总线错误（常见于非对齐访问或映射文件被截断）',
  SIGFPE: '算术异常（常见于整数除零或取模零）',
  SIGABRT: '程序主动中止（断言失败或 std::terminate）',
  SIGKILL: '进程被强制终止（通常是内存超限被 OOM Killer 杀掉）',
  SIGXCPU: 'CPU 时间超限（被内核按 CPU 配额杀掉）',
  SIGILL: '非法指令',
  SIGSYS: '非法系统调用（被沙箱 seccomp 策略拦截）',
};

/**
 * 判定顺序很重要，不能随意调换。当前顺序：
 *   ① 编译失败 → CE（最先，编译不过谈不上运行）
 *   ② 输出超限 → OLE（先于答案比对：输出爆炸时比对结果无意义）
 *   ③ 墙钟超时 → TLE
 *   ④ 被 SIGXCPU 杀 → TLE（内核级 CPU 超时）
 *   ⑤ 被 SIGKILL 杀 → 优先 MLE（有内存证据时），否则 RE
 *   ⑥ 其他致命信号 → RE
 *   ⑦ 退出码非 0 → RE
 *   ⑧ 输出比对 → AC / WA
 */
export function classify(raw: RawExecution, limits?: JudgeLimits): ClassifyResult {
  if (!raw.compiled) {
    return { verdict: 'compile-error', reason: '编译阶段未通过（未进入运行阶段）' };
  }

  if (raw.outputTruncated || raw.stdout.length > MAX_OUTPUT_BYTES) {
    return { verdict: 'output-limit-exceeded', reason: 'stdout 超过 ' + MAX_OUTPUT_BYTES + ' 字节上限' };
  }

  if (raw.timedOut) {
    const limit = limits && limits.runMs ? limits.runMs : 1000;
    return { verdict: 'time-limit-exceeded', reason: '墙钟超过 ' + limit + ' 毫秒' };
  }

  if (raw.signal === 'SIGXCPU') {
    return { verdict: 'time-limit-exceeded', reason: '内核按 CPU 配额终止（ulimit -t 生效）' };
  }

  if (raw.signal === 'SIGKILL') {
    // SIGKILL 有两种可能：OOM Killer（内存超限）或运维强制。靠内存证据区分。
    const memLimitMB = limits && limits.memoryMB ? limits.memoryMB : 256;
    const peakMB = raw.peakMemoryKB / 1024;
    if (raw.peakMemoryKB > 0 && peakMB >= memLimitMB * 0.85) {
      return {
        verdict: 'memory-limit-exceeded',
        reason: '峰值内存 ' + Math.round(peakMB) + 'MB 接近上限 ' + memLimitMB + 'MB，判定为 OOM',
      };
    }
    return {
      verdict: 'runtime-error',
      reason: 'SIGKILL 且无内存超限证据（峰值 ' + Math.round(peakMB) + 'MB），可能为外部终止',
    };
  }

  if (raw.signal && SIGNAL_TEXT[raw.signal]) {
    // SIGSYS 属于沙箱拦截，归到 system-error 而不是用户错：可能是我们的白名单缺调用
    if (raw.signal === 'SIGSYS') {
      return { verdict: 'system-error', reason: '进程被 seccomp 拦截（SIGSYS），需检查白名单' };
    }
    return { verdict: 'runtime-error', reason: '收到信号 ' + raw.signal + '：' + SIGNAL_TEXT[raw.signal] };
  }

  if (raw.exitCode !== 0) {
    return {
      verdict: 'runtime-error',
      reason: '非零退出码 ' + String(raw.exitCode) + (raw.stderr ? '；stderr: ' + clip(raw.stderr, 200) : ''),
    };
  }

  if (!raw.outputMatched) {
    return { verdict: 'wrong-answer', reason: '输出与期望不一致' };
  }

  return { verdict: 'accepted', reason: '输出与期望一致' };
}

/** 整体结论：全部 AC 才 AC，否则取第一个非 AC 点的 verdict */
export function aggregateVerdict(cases: Array<{ verdict: JudgeVerdict }>): JudgeVerdict {
  if (cases.length === 0) return 'system-error';
  for (let i = 0; i < cases.length; i++) {
    if (cases[i].verdict !== 'accepted') return cases[i].verdict;
  }
  return 'accepted';
}

/** 该 verdict 是否代表「设施问题」（不是用户的锅），需要在 UI 上区分对待 */
export function isInfrastructureVerdict(v: JudgeVerdict): boolean {
  return v === 'system-error';
}

/** 该 verdict 是否需要把编译器/运行输出展示给用户 */
export function shouldShowRawOutput(v: JudgeVerdict): boolean {
  return v === 'compile-error' || v === 'runtime-error';
}

function clip(s: string, limit: number): string {
  if (!s) return '';
  return s.length <= limit ? s : s.slice(0, limit) + '…';
}
