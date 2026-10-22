/**
 * 判题服务 · 客观题答案库（选择题 / 填空题 / 程序输出题）
 *
 * ═══════════════════════════════════════════════════════════════════
 *  与 codePlanSource 的关系
 * ═══════════════════════════════════════════════════════════════════
 *
 *   编程题的测试点（`JudgePlan`）→ `plans`        （questions/source.ts）
 *   客观题的答案   （`ObjectiveAnswer`）→ 本文件
 *
 * 两者刻意分成两条通路，而不是合成一个「万能题库」：
 *
 *   ① **数据形态完全不同**。测试点是「输入 → 期望输出」的数组，
 *      需要沙箱去跑；客观题答案是一个标量/数组，直接比对。
 *      合成一个类型只会得到一堆 optional 字段，两边都写得别扭。
 *
 *   ② **缓存纪律不同**。测试点内容基本不变，可以给很长的 TTL；
 *      客观题答案**改一次就影响判分正确性**（运营改了选项 key，
 *      缓存里还是旧答案 → 所有用户都被判错），所以 TTL 要短。
 *
 *   ③ **失败语义相同**（这条是共享的纪律，见下）。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  三态纪律（与 PlanProvider 完全一致）
 * ═══════════════════════════════════════════════════════════════════
 *
 *   getAnswer() 返回 undefined → 「题库明确说没有这道题」→ 404
 *   getAnswer() 抛异常        → 「此刻查不到」           → 500（可重试）
 *
 * 绝不能把「查不到」压成 undefined —— 那会让用户对着
 * 「题目不存在」反复重试，而真实原因只是题库接口抖了一下。
 */

import type { PlanSourceConfig } from './source';

/* ------------------------------------------------------------------ */
/*  数据模型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 客观题的答案记录。
 *
 * ⚠️ 这个对象**绝不能出现在任何 HTTP 响应里**。
 *    它是「答案 + 判分依据」的合体，泄漏任何一个都等于泄漏答案。
 *    唯一合法的消费路径是 `judges/objective.ts` 的 `judgeObjective()`，
 *    且它的输出还要再过一道 `sanitizeOutcome()`。
 */
export interface ObjectiveAnswer {
  questionId: string;
  /** 题型，用于与客户端上报的题型交叉校验（防客户端版本与题库不同步） */
  type: string;
  /** 判分策略：exact / set / normalize / output / numeric */
  strategy: string;
  /** 正确答案。结构随策略而异，与客户端 localJudgeKey.key 同构 */
  answer: unknown;
  /** 判分选项（ignoreCase / partialCredit / tolerance …） */
  options?: Record<string, unknown>;
  /** 题库侧备注（仅日志用） */
  note?: string;
}

export interface AnswerLookup {
  ok: boolean;
  value?: ObjectiveAnswer;
  error?: string;
  /** 该错误是否值得客户端重试 */
  retryable?: boolean;
}

/**
 * 客观题答案来源。
 * 与 `PlanSource` 接口同形，便于两种实现共用一套「注入假实现做自检」的思路。
 */
export interface ObjectiveAnswerSource {
  readonly name: string;
  fetchAnswer(questionId: string): Promise<AnswerLookup>;
}

/* ------------------------------------------------------------------ */
/*  内存实现（开发 + 自检）                                             */
/* ------------------------------------------------------------------ */

export class MemoryAnswerSource implements ObjectiveAnswerSource {
  readonly name = 'memory';
  private answers = new Map<string, ObjectiveAnswer>();

  constructor(seed?: ObjectiveAnswer[]) {
    if (seed) for (let i = 0; i < seed.length; i++) this.add(seed[i]);
  }

  add(a: ObjectiveAnswer): void {
    this.answers.set(a.questionId, a);
  }

  fetchAnswer(questionId: string): Promise<AnswerLookup> {
    const hit = this.answers.get(questionId);
    // 内存样例里没有就是真的没有 —— 与 http 的 404 语义一致
    return Promise.resolve({ ok: true, value: hit });
  }

  get size(): number {
    return this.answers.size;
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP 实现（生产）                                                   */
/* ------------------------------------------------------------------ */

export interface HttpAnswerSourceDeps {
  /** 注入 fetch（自检用）。不传则用全局 fetch（Node 18+ 内置，无需依赖） */
  fetchImpl?: typeof fetch;
}

/**
 * 通过 HTTP 从题库后台读客观题答案。
 *
 * 复用 `PlanSourceConfig` 的 baseUrl / token / timeoutMs / cacheTtlMs ——
 * 因为**它们是同一个题库后台的两个接口**，配置当然应该共用。
 * （用同一份配置也避免了「编程题读得动、客观题读不动」这种
 *   「其实是 token 没传过去」的问题。）
 */
export class HttpAnswerSource implements ObjectiveAnswerSource {
  readonly name: string;
  private cfg: PlanSourceConfig;
  private fetchImpl: typeof fetch;

  constructor(cfg: PlanSourceConfig, deps?: HttpAnswerSourceDeps) {
    this.cfg = cfg;
    this.name = 'http:' + redactUrl(cfg.baseUrl);
    const f = deps && deps.fetchImpl ? deps.fetchImpl : (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) {
      throw new Error('[answers] 当前 Node 没有全局 fetch，请注入 fetchImpl');
    }
    this.fetchImpl = f;
  }

  async fetchAnswer(questionId: string): Promise<AnswerLookup> {
    const url = trimSlash(this.cfg.baseUrl) + '/answers/' + encodeURIComponent(questionId);
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, this.cfg.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + this.cfg.token,
        },
        signal: ctrl.signal,
      });
    } catch (e) {
      // 网络层异常 → 可重试
      return {
        ok: false,
        error: '题库请求失败：' + (e instanceof Error ? e.message : String(e)),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }

    // ⚠️ 404 是「确实没有」，200 是「有」，其余一律当「查不到」
    //    5xx / 429 / 401 都不是「题目不存在」，把它当 404 会让用户白等。
    if (res.status === 404) {
      return { ok: true, value: undefined };
    }
    if (res.status !== 200) {
      return {
        ok: false,
        error: '题库返回 ' + res.status,
        retryable: res.status >= 500 || res.status === 429,
      };
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (e) {
      return { ok: false, error: '题库返回的不是合法 JSON', retryable: true };
    }

    return { ok: true, value: normalizeAnswer(raw, questionId) };
  }
}

/* ------------------------------------------------------------------ */
/*  规范化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 把题库返回的裸对象规范化成 `ObjectiveAnswer`。
 *
 * 纪律（与 normalizeJudgePlan 一致）：
 *   - **能修的修**：未知 strategy 退回按 type 推断；options 不是对象就丢成空
 *   - **不能修的返回 undefined**：缺 answer、缺 type、题型不在白名单
 *     宁可判「题目不存在」，也不要把脏数据当答案 —— 后者会让用户
 *     被判一个毫无意义的结论，且没有任何日志指向题库。
 */
export function normalizeAnswer(raw: unknown, questionId: string): ObjectiveAnswer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;

  const type = typeof src.type === 'string' ? src.type : '';
  if (!type) return undefined;

  const KNOWN: Record<string, string> = {
    'single-choice': 'exact',
    'multi-choice': 'set',
    'fill-blank': 'normalize',
    'program-output': 'output',
  };
  const byType = KNOWN[type];
  if (!byType) return undefined;

  if (src.answer === undefined || src.answer === null) return undefined;

  let strategy = typeof src.strategy === 'string' ? src.strategy : byType;
  // 策略与题型不匹配 → 以题型为准（题型是渲染器的 tag，比 strategy 更可信）
  const ALLOWED: string[] = ['exact', 'set', 'normalize', 'output', 'numeric'];
  if (ALLOWED.indexOf(strategy) < 0 || (type !== 'fill-blank' && strategy !== byType)) {
    strategy = byType;
  }

  const options =
    src.options && typeof src.options === 'object' && !Array.isArray(src.options)
      ? (src.options as Record<string, unknown>)
      : undefined;

  return {
    questionId: questionId,
    type: type,
    strategy: strategy,
    answer: src.answer,
    options: options,
    note: typeof src.note === 'string' ? src.note : undefined,
  };
}

function trimSlash(s: string): string {
  let out = s;
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * 按配置装配答案来源。
 *
 * ⚠️ 与 `createPlanSource` 的关键差异：这里的警告文案指的是
 *    **客观题**（选择题/填空题/程序输出题），不是编程题的测试点。
 *    分开命名是为了让运维一眼看出「是编程题读不到，还是客观题读不到」——
 *    这两种故障的用户表现完全不同（前者是编程关提交失败，
 *    后者是 Boss 关选项判错）。
 */
export function createAnswerSource(
  cfg: PlanSourceConfig,
  deps?: HttpAnswerSourceDeps
): { source: ObjectiveAnswerSource; warnings: string[] } {
  const warnings: string[] = [];
  const kind = (cfg.kind || 'memory').toLowerCase();

  if (kind === 'http' || kind === 'cloud') {
    // cloud 与 http 对客观题是同一条通路：都是 GET 一个 JSON。
    // 云开发的 HTTP 访问服务与普通 HTTP 接口在这件事上没有区别
    // （鉴权差异由 token 头承担，不需要两套实现）。
    if (!cfg.baseUrl) {
      warnings.push(
        '客观题题库来源为 ' + kind + ' 但未配置 baseUrl，客观题判分会全部返回「题目不存在」'
      );
    }
    return { source: new HttpAnswerSource(cfg, deps), warnings };
  }

  if (kind !== 'memory') {
    warnings.push(
      '未知的题库来源=' + cfg.kind + '（客观题），已退回内置样例答案（生产环境请修正配置）'
    );
  }
  return { source: new MemoryAnswerSource(), warnings };
}

/** 日志里不出现完整 URL（可能含内网地址）。只留主机名 */
function redactUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.host;
  } catch (e) {
    return '(非法URL)';
  }
}

/* ------------------------------------------------------------------ */
/*  带缓存的仓储（内核唯一可见的入口）                                   */
/* ------------------------------------------------------------------ */

/**
 * 客观题答案仓储。
 *
 * ⚠️ 缓存纪律（与 PlanRepository 完全一致，但 TTL 语义有差异）：
 *
 *   写缓存：只在**成功且确实有这道题**时写。
 *   不写缓存：查询失败、以及「题库明确说没有」。
 *
 *   「没有」也不写的理由与编程题相同：存在「先建题、后录答案」的窗口期。
 *
 *   **额外**：编程题的测试点几乎不变，可以给 10 分钟 TTL；
 *   但客观题答案**改一次就影响判分正确性**，TTL 必须短得多
 *   （生产建议 60 秒）。原因：运营发现某题答案错了，改完希望立刻生效；
 *   如果 TTL 是 10 分钟，那 10 分钟内所有用户都还在被判错的答案。
 */
export class AnswerRepository {
  private source: ObjectiveAnswerSource;
  private cacheTtlMs: number;
  private cache = new Map<string, { value: ObjectiveAnswer; expiresAt: number }>();
  private now: () => number;
  private onError?: (info: { questionId: string; error: string; retryable: boolean }) => void;

  private hits = 0;
  private misses = 0;
  private absent = 0;
  private errors = 0;

  constructor(opts: {
    source: ObjectiveAnswerSource;
    cacheTtlMs: number;
    now?: () => number;
    onError?: (info: { questionId: string; error: string; retryable: boolean }) => void;
  }) {
    this.source = opts.source;
    this.cacheTtlMs = opts.cacheTtlMs;
    this.now = opts.now || function () {
      return Date.now();
    };
    this.onError = opts.onError;
  }

  /**
   * 取答案。
   *
   * @returns 找到 → ObjectiveAnswer；题库明确说没有 → undefined
   * @throws  查询失败（网络/5xx）—— 调用方必须把它转成 500，不能吞成 undefined
   */
  async getAnswer(questionId: string): Promise<ObjectiveAnswer | undefined> {
    if (this.cacheTtlMs > 0) {
      const hit = this.cache.get(questionId);
      if (hit && hit.expiresAt > this.now()) {
        this.hits++;
        return hit.value;
      }
      if (hit) this.cache.delete(questionId);
    }

    const look = await this.source.fetchAnswer(questionId);

    if (!look.ok) {
      this.errors++;
      if (this.onError) {
        this.onError({
          questionId: questionId,
          error: look.error || '未知错误',
          retryable: look.retryable !== false,
        });
      }
      // ⚠️ 抛错而不是返回 undefined —— 这是「查不到」，不是「没有」
      throw new Error(look.error || '题库查询失败');
    }

    if (!look.value) {
      this.absent++;
      return undefined;
    }

    this.misses++;
    if (this.cacheTtlMs > 0) {
      this.cache.set(questionId, { value: look.value, expiresAt: this.now() + this.cacheTtlMs });
    }
    return look.value;
  }

  /** 统计。与 PlanRepository.getStats 同形，避免两套可观测性 */
  getStats(): { hits: number; misses: number; absent: number; errors: number; size: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      absent: this.absent,
      errors: this.errors,
      size: this.cache.size,
    };
  }

  /** 清缓存（运营改了答案后手动失效用） */
  invalidate(questionId?: string): void {
    if (questionId) this.cache.delete(questionId);
    else this.cache.clear();
  }
}
