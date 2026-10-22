/**
 * 判题服务 · PlanProvider 实现
 *
 * 内核（judges/index.ts）只认 `PlanProvider.getPlan(): Promise<JudgePlan | undefined>`。
 * 这个文件负责把那三个字 `undefined` 用对：
 *
 *     undefined  == 「题库明确没有这道题」  → 用户看到「题目未配置」（404 语义）
 *     throw      == 「我现在查不到」        → 用户看到「判题服务暂时不可用」（5xx 语义）
 *
 * ── 为什么必须分开 ──────────────────────────────────────────────────
 *
 * 如果网络抖动也返回 undefined，用户会看到「题目不存在或未配置判题计划」，
 * 于是反复重试、甚至去后台问运营「这题是不是下架了」。而真实原因只是
 * 题库接口抖了一下。**把可重试错误说成永久性错误，是对用户时间的浪费。**
 *
 * ── 缓存纪律 ────────────────────────────────────────────────────────
 *
 *   写缓存：只在**成功且确实有这道题**时写。
 *   不写缓存：查询失败、以及「题库明确说没有」。
 *
 * 「没有」也不写的理由：题库是人工审核后才发布的，但存在「先建题、后录测试点」
 * 的窗口期。把这个空结果缓存 5 分钟，意味着运营刚录好测试点、用户还得再等
 * 5 分钟才判得动，而运营那边看起来「已经好了」。宁可多查一次。
 */

import type { PlanProvider } from '../judges/types-internal';
import type { JudgePlan } from './testcases';
import {
  keyOf,
  normalizeJudgePlan,
  type PlanSource,
  type PlanSourceConfig,
} from './source';

export interface PlanRepositoryOptions {
  source: PlanSource;
  /** 成功结果缓存时长（毫秒）。0 或负数 = 不缓存 */
  cacheTtlMs: number;
  /** 规范化告警回调（题库质量信号，建议记日志） */
  onFix?: (info: { questionId: string; language: string; fixes: string[] }) => void;
  /** 查询失败回调（设施问题，建议打点告警） */
  onError?: (info: { questionId: string; language: string; error: string; retryable: boolean }) => void;
  /** 注入时钟，便于自检 */
  now?: () => number;
}

/**
 * 把任意 PlanSource 变成内核可用的 PlanProvider。
 *
 * 这一层是**唯一**允许知道「题库可能失败」的地方。
 * 内核拿到的要么是合法计划，要么是「确实没有」。
 */
export class PlanRepository implements PlanProvider {
  private source: PlanSource;
  private cacheTtlMs: number;
  private onFix?: PlanRepositoryOptions['onFix'];
  private onError?: PlanRepositoryOptions['onError'];
  private now: () => number;

  /** key → { plan, expiresAt }。只存成功结果，见文件头的缓存纪律 */
  private cache = new Map<string, { plan: JudgePlan; expiresAt: number }>();

  /** 统计数据，给自检和运维看 */
  private stats = {
    hits: 0,
    misses: 0,
    notFound: 0,
    failures: 0,
    fixed: 0,
  };

  constructor(opts: PlanRepositoryOptions) {
    this.source = opts.source;
    this.cacheTtlMs = opts.cacheTtlMs;
    this.onFix = opts.onFix;
    this.onError = opts.onError;
    this.now = opts.now || function () {
      return Date.now();
    };
  }

  async getPlan(questionId: string, language: string): Promise<JudgePlan | undefined> {
    const key = keyOf(questionId, language);

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.stats.hits++;
      return hit.plan;
    }
    if (hit) this.cache.delete(key); // 过期即删，防内存随题目数无限增长

    this.stats.misses++;

    const lookup = await this.source.fetchPlan(questionId, language);
    if (!lookup.ok) {
      this.stats.failures++;
      // 抛错而不是返回 undefined —— 让上层区分「设施故障」与「题目不存在」。
      // 上层（judges/index.ts）会把这里抛出的错包成 internal，走 5xx 语义。
      if (this.onError) {
        this.onError({
          questionId: questionId,
          language: language,
          error: lookup.error || '未知错误',
          retryable: !!lookup.retryable,
        });
      }
      throw new Error('[plans] 题库查询失败：' + (lookup.error || '未知错误'));
    }

    if (!lookup.value) {
      this.stats.notFound++;
      // 明确「没有」：不缓存、抛不抛错由上层决定 → 这里返回 undefined
      return undefined;
    }

    // ── 规范化：脏数据在这里被挡住，绝不带着问题进沙箱 ──
    const normalized = normalizeJudgePlan(lookup.value, questionId, language);
    if (!normalized.plan) {
      this.stats.failures++;
      // 计划本身坏了 —— 这是**设施/内容问题**，不是用户问题。
      // 与「没有这道题」分开：抛错让上层记日志并给 5xx，
      // 否则用户会以为自己代码写错了。
      const detail = normalized.errors.join('；');
      if (this.onError) {
        this.onError({
          questionId: questionId,
          language: language,
          error: '判题计划不合法：' + detail,
          retryable: false,
        });
      }
      throw new Error('[plans] 判题计划不合法：' + detail);
    }

    if (normalized.fixes.length > 0) {
      this.stats.fixed++;
      if (this.onFix) {
        this.onFix({ questionId: questionId, language: language, fixes: normalized.fixes });
      }
    }

    if (this.cacheTtlMs > 0) {
      this.cache.set(key, { plan: normalized.plan, expiresAt: this.now() + this.cacheTtlMs });
    }
    return normalized.plan;
  }

  getStats(): { hits: number; misses: number; notFound: number; failures: number; fixed: number; cached: number } {
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      notFound: this.stats.notFound,
      failures: this.stats.failures,
      fixed: this.stats.fixed,
      cached: this.cache.size,
    };
  }

  /** 清空缓存。运维用（例如题库刚更新了测试点） */
  invalidate(questionId?: string, language?: string): void {
    if (questionId === undefined) {
      this.cache.clear();
      return;
    }
    const prefix = String(questionId) + '::';
    if (language === undefined) {
      // 语言未指定：把这题在所有语言下的缓存都清掉。
      // 理由：运营改测试点时通常只说「改了 q_c_0005」，不会说「改了它的 C 计划」；
      // 只清一个语言会让另一语言的用户继续拿旧测试点判分。
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(prefix) === 0) this.cache.delete(keys[i]);
      }
      return;
    }
    this.cache.delete(keyOf(questionId, language));
  }

  get sourceName(): string {
    return this.source.name;
  }
}

/** 便捷构造：从配置直接造一个仓储 */
export function createPlanRepository(
  cfg: PlanSourceConfig,
  source: PlanSource,
  hooks?: Pick<PlanRepositoryOptions, 'onFix' | 'onError' | 'now'>
): PlanRepository {
  return new PlanRepository({
    source: source,
    cacheTtlMs: cfg.cacheTtlMs,
    onFix: hooks && hooks.onFix,
    onError: hooks && hooks.onError,
    now: hooks && hooks.now,
  });
}
