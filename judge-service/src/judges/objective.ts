/**
 * 判题服务 · 客观题判分（Boss 关 / 挑战关的选择、填空、程序输出题）
 *
 * ═══════════════════════════════════════════════════════════════════
 *  为什么需要这个模块
 * ═══════════════════════════════════════════════════════════════════
 *
 * 客观题的「判分依据」（正确答案）在题库里。它有两种下发方式：
 *
 *   ① 下发客户端（`localJudgeKey`）—— 练习关/复习关的做法。
 *      优点：零延迟、离线可判；代价：`localJudgeKey` 在数学上等价于答案，
 *      所以只能用在**不计入排行榜、不参与 PK** 的场次。
 *
 *   ② 留在服务端 —— 本模块。客户端只送「题号 + 作答」，
 *      服务端取答案比对，全程不泄漏判分依据。
 *
 * Boss 关是「限时综合考」，属于需防作弊的场次，必须走 ②。
 * 而在此之前服务端**只有编程题（sandbox）一条判分入口**，
 * 于是 Boss 关里的选择题会落到客户端的「题目配置异常」分支 ——
 * 用户答对也判 0 分。这是架构缺口，不是配置错误。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ⚠️ 最重要的一条纪律：必须与客户端判分器**逐条对齐**
 * ═══════════════════════════════════════════════════════════════════
 *
 * 客户端 `miniprogram/engine/judges/*` 与这里的实现，对**同一个作答**
 * 必须给出**同一个结论**（correct / partial / score）。
 *
 * 一旦漂移，后果是：同一道题在练习关判对、在 Boss 关判错（或反过来）。
 * 用户会彻底失去对判分的信任，而且这种 bug 极难解释。
 *
 * 所以下面的每个策略都是**照抄**客户端实现的口径，连默认值都一样：
 *
 *   exact     : applyTextRules 归一化后全等（halfWidth+trim+ignoreCase 默认全开）
 *   set       : 选项 key 转大写去重；错选 → 0；漏选 → hit/total（partialCredit 才生效）
 *   normalize : applyTextRules 归一化；multi 逐空判；空位数取 max(答案组数, 作答数)
 *   output    : 行尾空白一律忽略；末尾空行默认忽略；分数 = 匹配行数 / max(期望,实际)
 *   numeric   : 容差比较
 *
 * `tests/judge.test.mjs` 里有一节**交叉一致性自检**：
 * 对每个策略跑同一组向量，断言服务端结论 === 客户端结论。
 * 改了任一边而没改另一边，那一节就会红。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  另外两条纪律
 * ═══════════════════════════════════════════════════════════════════
 *
 * - **答错时绝不回传正确答案**。
 *   客户端本地判分可以显示答案（练习关，用户已经在本地拿到判分依据了，
 *   藏也没意义）；但服务端判分的场次（Boss 关）必须在返回前把答案抹掉，
 *   否则用户提交一次错误答案就能把答案抄出来。见 `sanitizeOutcome()`。
 *
 * - **不存在的题目 → not-found；查不到 → internal**。
 *   两种「拿不到题」的语义必须分开（详见 providers.ts 的文件头）。
 */

import type { JudgeErrorCode } from '../contract';

/** 结构化请求（避免依赖 contract 的完整类型，便于自检构造最小对象） */
export interface ObjectiveJudgeRequestLike {
  submissionId: string;
  questionId: string;
  type: string;
  answer: unknown;
}

/**
 * 服务端支持的客观题判分策略。
 *
 * ⚠️ 必须与客户端 `judge.ts` 的 `SERVER_SIDE_OBJECTIVE` 一致。
 *    两边不一致的后果：客户端把请求发过来了，服务端说不支持 ——
 *    用户看到「判分失败」，而其实只是白名单没对上。
 */
export const OBJECTIVE_STRATEGIES: string[] = ['exact', 'set', 'normalize', 'output', 'numeric'];

/** 题型 → 判分策略。必须与客户端 `TYPE_STRATEGY` 一致 */
export const OBJECTIVE_TYPE_STRATEGY: Record<string, string> = {
  'single-choice': 'exact',
  'multi-choice': 'set',
  'fill-blank': 'normalize',
  'program-output': 'output',
};

export function objectiveStrategyOf(type: string): string | undefined {
  return OBJECTIVE_TYPE_STRATEGY[type];
}

/* ------------------------------------------------------------------ */
/*  与客户端 shared.ts 完全一致的文本归一化                             */
/* ------------------------------------------------------------------ */

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

export interface TextRules {
  trim?: boolean;
  ignoreCase?: boolean;
  collapseSpaces?: boolean;
  stripAllSpace?: boolean;
  halfWidth?: boolean;
}

/**
 * 按统一规则归一化文本。默认：全角转半角 + 去首尾空白 + 忽略大小写。
 * ⚠️ 这是 `engine/judges/shared.ts` 的 `applyTextRules` 的**逐行对照实现**。
 */
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

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString);
  const s = asString(v);
  return s === '' ? [] : [s];
}

function clamp01(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function unique(list: string[]): string[] {
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

/* ------------------------------------------------------------------ */
/*  请求预检                                                            */
/* ------------------------------------------------------------------ */

export interface ObjectivePrecheck {
  ok: boolean;
  code?: JudgeErrorCode;
  message?: string;
}

/**
 * 客观题请求的结构预检。
 *
 * ⚠️ 与编程题的 precheck 分开：编程题要求 `code` 是非空字符串，
 *    客观题的作答形态是 string / string[] / 对象，硬套编程题的 precheck
 *    会把所有客观题都拒掉（「必须是字符串」）。
 */
export function precheckObjective(req: Partial<ObjectiveJudgeRequestLike>): ObjectivePrecheck {
  if (!req || typeof req !== 'object') {
    return { ok: false, code: 'internal', message: '缺少请求体' };
  }
  if (typeof req.submissionId !== 'string' || req.submissionId === '') {
    return { ok: false, code: 'internal', message: '缺少 submissionId' };
  }
  if (typeof req.questionId !== 'string' || req.questionId === '') {
    return { ok: false, code: 'internal', message: '缺少 questionId' };
  }
  if (typeof req.type !== 'string' || req.type === '') {
    return { ok: false, code: 'internal', message: '缺少题型 type' };
  }
  if (!objectiveStrategyOf(req.type)) {
    return {
      ok: false,
      code: 'unsupported-language',
      // 用 unsupported-language 承载「题型不支持」：它的 HTTP 语义是 400（请求方错误），
      // 与「题库里没这个题型」这种服务端问题区分开。
      message: '该题型不支持服务端客观题判分：' + req.type,
    };
  }
  if (req.answer === undefined) {
    return { ok: false, code: 'internal', message: '缺少作答 answer' };
  }
  // 空作答：拒掉。否则会走到判分器返回 false，
  // 而「空作答」和「答错了」在用户视角完全是两件事（前者是 bug、后者是学习信号）。
  if (isEmptyAnswer(req.answer)) {
    return { ok: false, code: 'internal', message: '作答为空' };
  }
  return { ok: true };
}

function isEmptyAnswer(a: unknown): boolean {
  if (a === null || a === undefined) return true;
  if (typeof a === 'string') return a.trim() === '';
  if (Array.isArray(a)) {
    return a.length === 0 || a.every((x) => typeof x === 'string' && x.trim() === '');
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  判分                                                                */
/* ------------------------------------------------------------------ */

export interface ObjectiveJudgeOutcome {
  correct: boolean;
  partial: boolean;
  score: number;
  /** 给用户看的说明。**返回客户端前会经过 sanitizeOutcome 抹掉答案** */
  detail: string;
  /** 判分依据的展示文本（服务端内部用，绝不下发） */
  revealAccepted?: string[];
}

/**
 * 执行判分。
 *
 * @param strategy   判分策略（由题型推出，已过白名单校验）
 * @param userAnswer 用户作答
 * @param answer     题库里的正确答案（**只在服务端内存里流转**）
 * @param options    题目声明的判分选项（如 ignoreCase / partialCredit）
 */
export function judgeObjective(
  strategy: string,
  userAnswer: unknown,
  answer: unknown,
  options?: Record<string, unknown>
): ObjectiveJudgeOutcome {
  const opts = options || {};

  switch (strategy) {
    case 'exact':
      return judgeExact(userAnswer, answer, opts);
    case 'set':
      return judgeSet(userAnswer, answer, opts);
    case 'normalize':
      return judgeNormalize(userAnswer, answer, opts);
    case 'output':
      return judgeOutput(userAnswer, answer, opts);
    case 'numeric':
      return judgeNumeric(userAnswer, answer, opts);
    default:
      // 理论上到不了这里（precheck 已挡），但保留兜底而不是静默返回 correct=false
      // —— 静默失败会让「策略没实现」看起来像「用户答错了」。
      return {
        correct: false,
        partial: false,
        score: 0,
        detail: '判分策略未实现：' + strategy,
      };
  }
}

/**
 * 与客户端 `finalizeScore` 同口径的收口。
 *
 * 规则：**未开启 partialCredit 时强制二值化** —— 部分匹配不给分，
 *      避免「蒙对一半」被计为得分。
 */
function finalize(
  rawScore: number,
  options: Record<string, unknown>,
  detail: string,
  reveal?: string[]
): ObjectiveJudgeOutcome {
  const partialCredit = !!options.partialCredit;
  const score = partialCredit ? clamp01(rawScore) : rawScore >= 1 ? 1 : 0;
  const correct = score >= 1 - 1e-9;
  return {
    correct,
    partial: !correct && score > 0,
    score,
    detail,
    revealAccepted: reveal,
  };
}

/* ---- exact：单选题（对照 engine/judges/exact.ts） ---- */
export function judgeExact(
  userAnswer: unknown,
  answer: unknown,
  options: Record<string, unknown>
): ObjectiveJudgeOutcome {
  const user = applyTextRules(asString(userAnswer), options);
  const expect = asString(answer);
  const target = applyTextRules(expect, options);
  const hit = user !== '' && user === target;
  return finalize(hit ? 1 : 0, options, hit ? '回答正确' : '正确答案：' + expect, [expect]);
}

/* ---- set：多选题（对照 engine/judges/set.ts） ---- */
export function judgeSet(
  userAnswer: unknown,
  answer: unknown,
  options: Record<string, unknown>
): ObjectiveJudgeOutcome {
  const upper = (list: string[]): string[] => list.map((k) => k.trim().toUpperCase());
  const selected = unique(upper(asStringArray(userAnswer)));
  const correctKeys = unique(upper(asStringArray(answer)));
  const total = correctKeys.length;

  if (total === 0) {
    return finalize(0, options, '题目配置异常：未提供正确选项', []);
  }

  const hit = selected.filter((k) => correctKeys.indexOf(k) >= 0);
  const wrong = selected.filter((k) => correctKeys.indexOf(k) < 0);
  const missed = correctKeys.filter((k) => selected.indexOf(k) < 0);

  let raw = 0;
  let detail = '';

  if (wrong.length > 0) {
    // ⚠️ 错选直接 0 分（不允许蒙），且这一条**优先于**漏选的部分给分
    raw = 0;
    detail = '多选了错误项：' + wrong.join('、') + '。正确答案：' + correctKeys.join('、');
  } else if (missed.length === 0) {
    raw = 1;
    detail = '回答完全正确';
  } else {
    raw = hit.length / total;
    detail = '漏选 ' + missed.join('、') + '。正确答案：' + correctKeys.join('、');
  }

  return finalize(raw, options, detail, correctKeys);
}

/* ---- normalize：填空题（对照 engine/judges/normalize.ts） ---- */
export function judgeNormalize(
  userAnswer: unknown,
  answer: unknown,
  options: Record<string, unknown>
): ObjectiveJudgeOutcome {
  const key = (answer || {}) as { mode?: string; accepted?: unknown; pattern?: string };
  const multi = key.mode === 'multi';

  const userVals = asStringArray(userAnswer);
  const acceptedGroups: string[][] = multi
    ? Array.isArray(key.accepted)
      ? (key.accepted as unknown[]).map((g) => asStringArray(g))
      : []
    : [asStringArray(key.accepted)];

  // ⚠️ 空位数取 max(答案组数, 作答数) —— 与客户端一致。
  //    取两者最大值意味着「多填的空也算进分母」，这是刻意的：
  //    否则用户多填一堆空反而更容易满分。
  const blankCount = multi ? Math.max(acceptedGroups.length, userVals.length) : 1;
  if (blankCount === 0) {
    return finalize(0, options, '题目配置异常：未提供可接受答案', []);
  }

  const matchOne = (normalizedUser: string, rawUser: string, group: string[]): boolean => {
    if (normalizedUser === '') return false;
    for (let i = 0; i < group.length; i++) {
      if (applyTextRules(group[i], options) === normalizedUser) return true;
    }
    if (key.pattern) {
      try {
        const flags = options.ignoreCase === false ? '' : 'i';
        const re = new RegExp(key.pattern, flags);
        if (re.test(rawUser.trim())) return true;
      } catch (e) {
        // 题目配置了非法正则：忽略兜底通道，不让脏配置炸掉判分
      }
    }
    return false;
  };

  let hitCount = 0;
  const revealAccepted: string[] = [];

  for (let i = 0; i < blankCount; i++) {
    const rawUser = userVals[i] || '';
    const normalizedUser = applyTextRules(rawUser, options);
    const group = acceptedGroups[i] || [];
    if (matchOne(normalizedUser, rawUser, group)) hitCount++;
    revealAccepted.push(group.length > 0 ? group[0] : key.pattern || '');
  }

  const raw = hitCount / blankCount;
  const allHit = hitCount === blankCount;
  const detail = allHit ? '回答正确' : '正确答案：' + revealAccepted.join(' / ');

  return finalize(raw, options, detail, revealAccepted);
}

/* ---- output：程序阅读输出题（对照 engine/judges/output.ts） ---- */
export function judgeOutput(
  userAnswer: unknown,
  answer: unknown,
  options: Record<string, unknown>
): ObjectiveJudgeOutcome {
  const key = (answer || {}) as { expected?: unknown };

  const splitLines = (raw: unknown): string[] => {
    const s = Array.isArray(raw) ? raw.map(asString).join('\n') : asString(raw);
    return s
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''));
  };

  const dropTrailingBlank = (lines: string[]): string[] => {
    const out = lines.slice();
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  };

  const ignoreTrailingBlank = options.ignoreTrailingBlank !== false;
  const trimStart = !!options.trimStart;
  const ignoreCase = !!options.ignoreCase;
  const collapseSpaces = !!options.collapseSpaces;

  let expected = splitLines(key ? key.expected : []);
  let actual = splitLines(userAnswer);

  if (ignoreTrailingBlank) {
    expected = dropTrailingBlank(expected);
    actual = dropTrailingBlank(actual);
  }

  if (expected.length === 0) {
    return finalize(0, options, '题目配置异常：未提供期望输出', []);
  }

  const norm = (line: string): string => {
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
    detail = '输出行数不一致：期望 ' + expected.length + ' 行，实际 ' + actual.length + ' 行';
  } else {
    detail = '第 ' + (firstDiff + 1) + ' 行不符合预期';
  }

  // reveal 带期望输出 —— 服务端判分场次不会下发（见 sanitizeOutcome）
  return finalize(raw, options, detail, expected);
}

/* ---- numeric：数值题（对照 engine/judges/numeric.ts 的容差口径） ---- */

/**
 * 去掉千分位、单位与全角空格，只留下数字与科学计数法符号。
 *
 * ⚠️ 必须与客户端 `engine/judges/numeric.ts` 的 `extractNumber` **逐字一致**。
 *    两端不一致就会出现「练习关判对、Boss 关判错」。
 */
function extractNumber(input: string): number {
  const cleaned = input
    .replace(/[，,\s]/g, '')
    .replace(/[^\d.eE+\-]/g, '');
  return Number(cleaned);
}

/**
 * 答案对象形态：`{ value, tolerance?, mode? }` —— 与客户端 `NumericKey` 同形。
 *
 * ⚠️ 这里刻意**不接受裸数值**：`exact` 的答案是裸值、`numeric` 的答案是对象，
 *    形态不统一会让「录题时写 `answer: 3.14`」在练习关正常、在 Boss 关静默判错
 *    （`key.value` 为 undefined → NaN → 判 0）。宁可在这里显式报配置异常。
 */
export function judgeNumeric(
  userAnswer: unknown,
  answer: unknown,
  options: Record<string, unknown>
): ObjectiveJudgeOutcome {
  const key = (answer === null || typeof answer !== 'object'
    ? {}
    : answer) as { value?: unknown; tolerance?: unknown; mode?: unknown };

  const target = Number(key.value);
  if (!isFinite(target)) {
    return finalize(0, options, '题目配置异常：未提供有效数值答案', []);
  }

  const got = extractNumber(asString(userAnswer));
  const correctText = String(target);

  if (!isFinite(got)) {
    return finalize(0, options, '无法识别为数值。正确答案：' + correctText, [correctText]);
  }

  // 容差来源：答案对象优先，其次 options（兼容旧配置），最后默认 1e-6
  const rawTol =
    typeof key.tolerance === 'number' ? (key.tolerance as number) : options.tolerance;
  const tol = typeof rawTol === 'number' && (rawTol as number) >= 0 ? (rawTol as number) : 1e-6;

  const mode = key.mode === 'rel' ? 'rel' : 'abs';
  const limit = mode === 'rel' ? Math.abs(target) * tol : tol;
  const hit = Math.abs(got - target) <= limit + 1e-12;

  const detail = hit
    ? '回答正确'
    : '正确答案：' + correctText + '（容差 ' + limit + '）';

  return finalize(hit ? 1 : 0, options, detail, [correctText]);
}

/* ------------------------------------------------------------------ */
/*  返回客户端前的净化（服务端判分场次的关键一步）                       */
/* ------------------------------------------------------------------ */

/**
 * 抹掉 detail 里的正确答案。
 *
 * ⚠️ 这是**必须做**的一步，不是可选优化。
 *
 * 客户端判分器（`engine/judges/*`）设计上会把正确答案写进 detail
 * （例如 exact 的「正确答案：B」），因为练习关里用户本来就拿到了
 * `localJudgeKey`，答案对他不是秘密。
 *
 * 但服务端判分的场次（Boss 关）**答案从不下发**。如果原样把
 * 「正确答案：B」返回给客户端，用户只要故意答错一次就能拿到答案，
 * 整个「服务端判分防作弊」的设计直接失效。
 *
 * 做法：把答案片段替换成中性文案。用替换而不是丢弃，是为了保留
 * 「这道题确实判错了」这一信息（用户需要知道判分发生了）。
 */
export function sanitizeOutcome(outcome: ObjectiveJudgeOutcome): {
  correct: boolean;
  partial: boolean;
  score: number;
  detail: string;
} {
  let detail = outcome.detail;

  // 1. 逐条抹掉题库里的正确答案文本
  const secrets = outcome.revealAccepted || [];
  for (const s of secrets) {
    if (typeof s !== 'string' || s === '') continue;
    // 转义正则特殊字符，避免答案里带 . * ( ) 之类的字符把替换搞坏
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    detail = detail.replace(new RegExp(esc, 'g'), '（略）');
  }

  // 2. 兜底：万一答案文本没出现在 detail 里（例如多选答案是用「、」拼接的），
  //    仍然要把「正确答案：」这个前缀整段裁掉。
  //    宁可丢掉整句提示，也不能漏一个答案出去。
  detail = detail.replace(/正确答案[：:][^。\n]*/g, '');

  // 3. 清洗后如果只剩空白，给一句中性提示，避免用户看到空白
  detail = detail.trim();
  if (detail === '') {
    detail = outcome.correct ? '回答正确' : '回答不正确，再想想';
  }

  return {
    correct: outcome.correct,
    partial: outcome.partial,
    score: outcome.score,
    detail,
  };
}
