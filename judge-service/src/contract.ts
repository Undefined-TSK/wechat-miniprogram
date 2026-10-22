/**
 * 判题服务 · 跨端契约
 *
 * ⚠️ 这份文件在客户端与判题服务里各有一份**完全相同的拷贝**，必须逐字节一致。
 *    原因：小程序端不能 import 主工程外的文件；而契约假如各写一遍，
 *    表现是「服务端返回了 wrong-answer，客户端没这个 case，UI 显示 null」这类静默 bug。
 *    同步校验在 tests/judge.test.mjs 里（比对两份文件的哈希），不要手工改单边。
 *
 * 本文件不依赖任何运行时（无 wx API、无 Node API、无第三方库）。
 */

/* ------------------------------------------------------------------ */
/* 判题结果分类                                                        */
/* ------------------------------------------------------------------ */

/**
 * 判题状态码。用于前端展示与统计，命名对齐 OJ 惯例。
 * ⚠️ 这里是**字符串字面量联合**，不要改成 enum——枚举在跨端序列化时容易出双份定义。
 */
export type JudgeVerdict =
  | 'accepted' // AC 通过
  | 'wrong-answer' // WA 答案错误
  | 'compile-error' // CE 编译错误
  | 'runtime-error' // RE 运行时错误（段错误/异常退出）
  | 'time-limit-exceeded' // TLE 超时
  | 'memory-limit-exceeded' // MLE 超内存
  | 'output-limit-exceeded' // OLE 输出超限
  | 'system-error'; // SE 系统错误，需运维介入

export const VERDICT_TEXT: Record<JudgeVerdict, string> = {
  accepted: '通过',
  'wrong-answer': '答案错误',
  'compile-error': '编译错误',
  'runtime-error': '运行时错误',
  'time-limit-exceeded': '运行超时',
  'memory-limit-exceeded': '内存超限',
  'output-limit-exceeded': '输出超限',
  'system-error': '系统错误',
};

/** 系统错误是否需要重试（前端据此决定「重试」还是「放弃」） */
export function isRetryable(verdict: JudgeVerdict): boolean {
  return verdict === 'system-error';
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

/** 判题语言。首批只开 C / C++，其余按需扩。 */
export type JudgeLanguage = 'c' | 'cpp' | 'python';

export interface JudgeLimits {
  /** 编译墙钟超时（毫秒），默认 10000 */
  compileMs?: number;
  /** 单测试点运行墙钟超时（毫秒），默认 1000 */
  runMs?: number;
  /** 运行内存上限（MB），默认 256 */
  memoryMB?: number;
  /** stdout / stderr 各自上限（字节），默认 1MB */
  outputBytes?: number;
  /** 进程/线程数上限（防 fork 炸弹），默认 64 */
  maxProcs?: number;
}

export interface JudgeRequest {
  /** 幂等键。同一 submissionId 重复提交必须返回同一结果（服务端结果缓存） */
  submissionId: string;
  questionId: string;
  /** 与渲染器 tag 同名，用于服务端选判分策略 */
  type: string;
  language: JudgeLanguage;
  /** 用户源码。大小上限由 limits 与 MAX_CODE_* 共同约束 */
  code: string;
  limits?: JudgeLimits;
}

/**
 * 客观题服务端判分请求。
 *
 * ⚠️ 与 JudgeRequest 的关键区别：**这里不发 language / code / limits**。
 *    客观题不需要沙箱，只需要「题目 + 作答」两样东西。
 *
 * ⚠️ 更要紧的是：**请求里没有、也不能有判分依据**。
 *    答案由服务端从题库取（客户端永远拿不到）。
 *    这也意味着这个端点是「可被前端调用的」，但它不能返回任何能反推答案的信息——
 *    所以 response 里只有 correct / partial / score / detail，
 *    且 detail 在答错时不能暴露正确答案（只给「再想想」类提示）。
 */
export interface ObjectiveJudgeRequest {
  /** 幂等键，与编程题共用生成规则 */
  submissionId: string;
  questionId: string;
  /** 题型（服务端用于交叉校验，防止 questionId 与实际题型不符） */
  type: string;
  /**
   * 用户作答。形态随题型而异（见 engine/answer.ts 的作答形态契约）：
   *   single-choice   string
   *   multi-choice    string[]
   *   fill-blank      string | string[]
   *   program-output  string
   */
  answer: unknown;
}

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

export interface JudgeCaseResult {
  /** 测试点序号（从 1 开始） */
  index: number;
  verdict: JudgeVerdict;
  /** 是否被隐藏（隐藏测试点不回传输入与期望输出，防泄题） */
  hidden: boolean;
  costMs: number;
  /** 实际占用内存（KB） */
  memoryKB: number;
  /** 该测试点的输入摘要（隐藏点为空） */
  stdinPreview?: string;
  /** 该测试点的期望输出（隐藏点为空） */
  expectedPreview?: string;
  /** 用户实际输出（隐藏点为空，或按配置截断） */
  actualPreview?: string;
  message?: string;
}

export interface JudgeResponse {
  submissionId: string;
  /** 整体结论：所有点通过才 accepted，否则取「第一个非 AC 点」的 verdict */
  verdict: JudgeVerdict;
  /** 通过率 0-1，用于星级与部分给分 */
  score: number;
  passed: number;
  total: number;
  /** 编译错误原始信息（CE 时才有，来自 gcc/clang 的 stderr） */
  compileMessage?: string;
  cases: JudgeCaseResult[];
  /** 判题总耗时（含排队） */
  totalMs: number;
  /** 服务端完成时间（毫秒时间戳，服务端生成，客户端不参与计算） */
  finishedAt: number;
  /** 结果来源：首次执行 / 幂等缓存命中 */
  cacheHit: boolean;
  /** 系统错误时的运维提示（不给用户看） */
  systemNote?: string;
}

/* ------------------------------------------------------------------ */
/* 服务端错误码                                                        */
/* ------------------------------------------------------------------ */

/** 请求级错误（HTTP 4xx/5xx 与业务拒绝），与「判题结论」是两个层次 */
export type JudgeErrorCode =
  | 'unauthorized' // 缺少或伪造鉴权
  | 'forbidden' // 无权访问该题（非本场次题目、越权提交）
  | 'rate-limited' // 提交频率超限，需冷却
  | 'payload-too-large' // 代码或请求体超限
  | 'unsupported-language' // 语言不支持
  | 'question-not-found'
  | 'session-expired' // 场次已结束（Boss 关时限到点后提交）
  | 'busy' // 判题队列饱和，可重试
  | 'internal'; // 未分类错误

export interface JudgeErrorBody {
  error: {
    code: JudgeErrorCode;
    message: string;
    /** 冷却剩余毫秒（rate-limited 时才有） */
    retryAfterMs?: number;
  };
}

/* ------------------------------------------------------------------ */
/* 客户端限流参数（与服务端保持一致的口径，避免「前端放行服务端拒绝」） */
/* ------------------------------------------------------------------ */

export const RATE_LIMIT = {
  /** 每分钟提交上限 */
  perMinute: 30,
  /** 每日提交上限 */
  perDay: 300,
  /** 超限后的冷却时长（毫秒） */
  cooldownMs: 60 * 1000,
} as const;

/** 代码大小上限：单文件 64KB、换算成字符数按 UTF-8 最坏情况取三分之一 */
export const MAX_CODE_BYTES = 64 * 1024;
export const MAX_TOTAL_CODE_BYTES = 256 * 1024;

/** 输出上限（字节）。超出即 OLE，不当成 AC */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** 默认资源上限。题目可通过 limits 收紧，但服务端必须再夹一层上限（不允许放宽） */
export const DEFAULT_LIMITS: Required<JudgeLimits> = {
  compileMs: 10000,
  runMs: 1000,
  memoryMB: 256,
  outputBytes: MAX_OUTPUT_BYTES,
  maxProcs: 64,
};

/**
 * 服务端强制上限。请求里的 limits 只能**小于等于**这个值。
 * ⚠️ 这是防「客户端传个超大 limits 绕开资源限制」的关键，不要省。
 */
export const HARD_LIMITS: Required<JudgeLimits> = {
  compileMs: 10000,
  runMs: 2000,
  memoryMB: 512,
  outputBytes: 1024 * 1024,
  maxProcs: 128,
};

/** 把请求里的 limits 夹到硬上限内。服务端与客户端都应调用，但**服务端必须再调一次** */
export function clampLimits(input?: JudgeLimits): Required<JudgeLimits> {
  const src = input || {};
  return {
    compileMs: Math.min(num(src.compileMs, DEFAULT_LIMITS.compileMs), HARD_LIMITS.compileMs),
    runMs: Math.min(num(src.runMs, DEFAULT_LIMITS.runMs), HARD_LIMITS.runMs),
    memoryMB: Math.min(num(src.memoryMB, DEFAULT_LIMITS.memoryMB), HARD_LIMITS.memoryMB),
    outputBytes: Math.min(num(src.outputBytes, DEFAULT_LIMITS.outputBytes), HARD_LIMITS.outputBytes),
    maxProcs: Math.min(num(src.maxProcs, DEFAULT_LIMITS.maxProcs), HARD_LIMITS.maxProcs),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback;
}

/* ------------------------------------------------------------------ */
/* 静态预检（客户端先拦住明显非法的请求，省一次网络往返）              */
/* ------------------------------------------------------------------ */

export interface PrecheckResult {
  ok: boolean;
  code?: JudgeErrorCode;
  message?: string;
}

const SUPPORTED_LANGUAGES: JudgeLanguage[] = ['c', 'cpp', 'python'];

/** 按 UTF-8 估算字节数。用于代码大小上限判断，服务端会用真实字节重算 */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // 代理对，下一个码元一并计入
      i++;
    } else bytes += 3;
  }
  return bytes;
}

export function precheck(req: JudgeRequest): PrecheckResult {
  if (!req || !req.submissionId) return { ok: false, code: 'internal', message: '缺少 submissionId' };
  if (!req.questionId) return { ok: false, code: 'question-not-found', message: '缺少 questionId' };
  if (SUPPORTED_LANGUAGES.indexOf(req.language) < 0) {
    return { ok: false, code: 'unsupported-language', message: '不支持的语言：' + String(req.language) };
  }
  if (typeof req.code !== 'string') {
    return { ok: false, code: 'internal', message: 'code 必须是字符串' };
  }
  const bytes = utf8Bytes(req.code);
  if (bytes > MAX_CODE_BYTES) {
    return {
      ok: false,
      code: 'payload-too-large',
      message: '代码超长（' + bytes + ' 字节，上限 ' + MAX_CODE_BYTES + '）',
    };
  }
  if (req.code.trim() === '') {
    return { ok: false, code: 'internal', message: '代码为空' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 把判题结论映射到引擎的 JudgeResult                                   */
/* ------------------------------------------------------------------ */

/** 只依赖结构，不 import 引擎类型，避免契约文件产生依赖 */
export interface JudgeResultLike {
  correct: boolean;
  partial: boolean;
  score: number;
  detail: string;
  layer: 'local' | 'remote';
  strategy: string;
  reveal?: {
    correctKeys?: string[];
    acceptedText?: string[];
    correctText?: string;
    expectedLines?: string[];
    scorePoints?: string[];
  };
}

/**
 * 服务端判题响应 → 引擎判分结果。
 *
 * 放在契约里而不是客户端 service 里，是因为映射口径要和判题结论一起演进；
 * 分家之后很容易出现「服务端加了新 verdict，客户端还是老映射」。
 */
export function toJudgeResult(res: JudgeResponse, limitHint?: { runMs?: number; memoryMB?: number }): JudgeResultLike {
  const strategy = 'sandbox';
  const base = {
    layer: 'remote' as const,
    strategy: strategy,
  };

  if (res.verdict === 'accepted') {
    return {
      ...base,
      correct: true,
      partial: false,
      score: 1,
      detail: '全部测试点通过' + (res.total > 1 ? '（' + res.total + '/' + res.total + '）' : ''),
    };
  }

  // 部分通过：按通过率给分，但**永远不算 fully correct**，
  // 因为「过了 3/5 个测试点」在编程题里就是没做对。
  if (res.passed > 0 && res.total > 0) {
    return {
      ...base,
      correct: false,
      partial: true,
      score: Math.max(0, Math.min(1, res.score)),
      detail: '通过 ' + res.passed + '/' + res.total + ' 个测试点（' + VERDICT_TEXT[res.verdict] + '）',
    };
  }

  return {
    ...base,
    correct: false,
    partial: false,
    score: 0,
    detail: describeVerdict(res, limitHint),
  };
}

function describeVerdict(res: JudgeResponse, limitHint?: { runMs?: number; memoryMB?: number }): string {
  const first = res.cases.filter(function (c) {
    return c.verdict !== 'accepted';
  })[0];

  switch (res.verdict) {
    case 'compile-error':
      return '编译未通过，请看下方编译器信息';
    case 'wrong-answer':
      return first
        ? '第 ' + first.index + ' 个测试点答案不符合预期' + (first.hidden ? '（隐藏测试点）' : '')
        : '答案不符合预期';
    case 'time-limit-exceeded':
      return (
        '运行超时（限 ' +
        (limitHint && limitHint.runMs ? limitHint.runMs : DEFAULT_LIMITS.runMs) +
        ' 毫秒）。检查是否存在死循环或算法复杂度过高。'
      );
    case 'memory-limit-exceeded':
      return (
        '内存超限（限 ' +
        (limitHint && limitHint.memoryMB ? limitHint.memoryMB : DEFAULT_LIMITS.memoryMB) +
        ' MB）。检查是否申请了过大的数组。'
      );
    case 'output-limit-exceeded':
      return '输出内容超过上限，检查是否打印了调试信息或存在死循环输出。';
    case 'runtime-error':
      return first && first.message ? '运行时错误：' + first.message : '运行时错误，检查数组越界或空指针。';
    case 'system-error':
      return '判题服务暂时不可用，请稍后重试。';
    default:
      return '未通过';
  }
}
