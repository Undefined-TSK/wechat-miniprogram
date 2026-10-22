/**
 * 判题服务 · 提交频率限制（12 项加固第 11 条）
 *
 * 为什么必须做：判题是整套系统里唯一「用户能让服务器干活」的入口。
 * 不限制的话，自动化脚本会把判题队列打满，合法用户全部排队超时。
 *
 * 口径：
 *   单用户 30 次/分钟、300 次/日，超限返回 rate-limited 并给冷却时长。
 *
 * 实现是注入式（存储用接口），因为生产要用 Redis：
 *   单机内存实现在多实例部署下会各算各的，等于没限流。
 */

import { RATE_LIMIT, type JudgeErrorCode } from '../contract';

export interface RateLimitDecision {
  allowed: boolean;
  code?: JudgeErrorCode;
  /** 冷却剩余毫秒 */
  retryAfterMs?: number;
  /** 给用户看的一句话 */
  message?: string;
  /** 当前窗口计数，便于埋点 */
  minuteCount: number;
  dayCount: number;
}

export interface RateCounter {
  /** 计数 +1 并返回当前窗口内的计数；ttlMs 用于首次创建时设过期 */
  incr(bucket: string, windowMs: number, now: number): number;
  /** 仅读取，不增加 */
  get(bucket: string, now: number): number;
  /** 距窗口重置还有多久 */
  ttl(bucket: string, now: number): number;
}

/**
 * 可预热计数器。
 *
 * 同步接口 + 异步存储（Redis）之间有张力。这个接口给存储实现一个
 * 「在判定之前先把权威读数拉回本地」的机会，于是同步的 get()/ttl()
 * 也能给出多实例下正确的判定。
 *
 * 声明在这里而不是 redis/ 下：它是**限流语义的一部分**，
 * 不是某个存储的私事。内存实现不实现它（它本来就是权威的）。
 */
export interface PrefetchableRateCounter extends RateCounter {
  prefetch(userId: string, now: number): Promise<void>;
}

export function isPrefetchable(c: RateCounter): c is PrefetchableRateCounter {
  return typeof (c as PrefetchableRateCounter).prefetch === 'function';
}

export interface RateLimitConfig {
  perMinute: number;
  perDay: number;
  cooldownMs: number;
}

export class RateLimiter {
  private counter: RateCounter;
  private config: RateLimitConfig;

  constructor(counter: RateCounter, config?: Partial<RateLimitConfig>) {
    this.counter = counter;
    this.config = {
      perMinute: (config && config.perMinute) || RATE_LIMIT.perMinute,
      perDay: (config && config.perDay) || RATE_LIMIT.perDay,
      cooldownMs: (config && config.cooldownMs) || RATE_LIMIT.cooldownMs,
    };
  }

  /**
   * 先检查后计数（而不是先计数后检查）。
   * 理由：先计数会把被拒绝的请求也算进配额，用户越重试恢复得越慢——
   * 那不是限流，那是惩罚。被拒绝的请求不应该消耗配额。
   */
  check(userId: string, now: number): RateLimitDecision {
    const minuteBucket = 'rl:m:' + userId;
    const dayBucket = 'rl:d:' + userId;

    const minuteCount = this.counter.get(minuteBucket, now);
    const dayCount = this.counter.get(dayBucket, now);

    if (minuteCount >= this.config.perMinute) {
      const ttl = this.counter.ttl(minuteBucket, now);
      return {
        allowed: false,
        code: 'rate-limited',
        retryAfterMs: ttl > 0 ? ttl : this.config.cooldownMs,
        message: '提交过于频繁（每分钟上限 ' + this.config.perMinute + ' 次），请稍后再试',
        minuteCount: minuteCount,
        dayCount: dayCount,
      };
    }

    if (dayCount >= this.config.perDay) {
      const ttl = this.counter.ttl(dayBucket, now);
      return {
        allowed: false,
        code: 'rate-limited',
        retryAfterMs: ttl > 0 ? ttl : this.config.cooldownMs,
        message: '今日提交次数已达上限（' + this.config.perDay + ' 次），明天再来',
        minuteCount: minuteCount,
        dayCount: dayCount,
      };
    }

    const mc = this.counter.incr(minuteBucket, 60 * 1000, now);
    const dc = this.counter.incr(dayBucket, 24 * 60 * 60 * 1000, now);

    return { allowed: true, minuteCount: mc, dayCount: dc };
  }

  /** 供运维查询，不消耗配额 */
  peek(userId: string, now: number): { minuteCount: number; dayCount: number } {
    return {
      minuteCount: this.counter.get('rl:m:' + userId, now),
      dayCount: this.counter.get('rl:d:' + userId, now),
    };
  }
}

/**
 * 单机内存计数器。
 *
 * ⚠️ 仅用于开发/单实例。多实例部署必须换成 Redis 实现，
 *    否则 N 个实例各自计数，实际放行量是配置值的 N 倍。
 */
export class MemoryRateCounter implements RateCounter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  incr(bucket: string, windowMs: number, now: number): number {
    const cur = this.buckets.get(bucket);
    if (!cur || cur.resetAt <= now) {
      this.buckets.set(bucket, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }

  get(bucket: string, now: number): number {
    const cur = this.buckets.get(bucket);
    if (!cur || cur.resetAt <= now) return 0;
    return cur.count;
  }

  ttl(bucket: string, now: number): number {
    const cur = this.buckets.get(bucket);
    if (!cur || cur.resetAt <= now) return 0;
    return cur.resetAt - now;
  }

  /** 定期清理过期桶，避免内存随用户数无限增长 */
  sweep(now: number): number {
    let removed = 0;
    this.buckets.forEach(function (v, k) {
      if (v.resetAt <= now) {
        removed++;
      }
    });
    // Map 不能在遍历中删，所以二遍
    const keys = Array.from(this.buckets.keys());
    for (let i = 0; i < keys.length; i++) {
      const v = this.buckets.get(keys[i]);
      if (v && v.resetAt <= now) this.buckets.delete(keys[i]);
    }
    return removed;
  }
}
