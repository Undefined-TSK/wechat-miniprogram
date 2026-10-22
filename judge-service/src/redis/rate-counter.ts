/**
 * 判题服务 · Redis 限流计数器（12 项加固第 11 条的生产实现）
 *
 * 替换 ratelimit.ts 里的 MemoryRateCounter。**多实例部署必须用它**：
 * 内存实现下 N 个实例各自计数，实际放行量是配置值的 N 倍，等于没限流。
 *
 * ── 两个关键设计 ────────────────────────────────────────────────────
 *
 * ① **Lua 脚本做 INCR + PEXPIRE 原子化**
 *
 *    朴素写法：const n = INCR key; if (n === 1) PEXPIRE key ttl;
 *    问题：INCR 与 PEXPIRE 之间断连，key 会**永不过期**——这个用户从此被永久限流。
 *    这是限流实现里最经典的线上事故，而且只在网络抖动时出现，本地测不出来。
 *
 *    另一种朴素写法是「每次都 PEXPIRE」：
 *    问题：窗口被无限续期，用户只要持续提交就永远不重置，等于惩罚。
 *
 *    所以必须一次性原子完成，且**只在首次创建时设过期**。
 *
 * ② **fail-open 降级**
 *
 *    Redis 不可用时：跳过限流，放行，打点告警。
 *    理由（项目决策）：判题算力是**可恢复成本**（多烧点 CPU），
 *    而「所有用户都不能提交代码」是**用户可感知的功能故障**。
 *    两害相权，宁可多花钱也不要让功能全挂。
 *
 *    ⚠️ 这个取舍对**重放拦截**不适用——那里是 fail-closed（见 auth/nonce.ts）。
 *       安全降级与限流降级的正确方向是相反的，不要抄。
 */

import { RATE_LIMIT } from '../contract';
import type { RateCounter } from '../sandbox/ratelimit';
import type { RedisCommandPort } from './client';

/**
 * 原子「自增并在首次创建时设过期」。
 *
 * 返回值：
 *   正数 = 自增后的计数
 *   -1   = Redis 返回了非数字（不该发生，说明有别的程序在写这个 key）
 *
 * 为什么用 EVAL 而不是 Redis 7 的 `INCRBY ... EXPIRE ... NX`：
 * 那个语法是 7.0 才有的，我们不想把最低版本卡这么高（且本身也不能原子地
 * 「仅首次设过期」）。
 */
const INCR_WITH_TTL_LUA = [
  "local n = redis.call('INCR', KEYS[1])",
  "if n == 1 then",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  "end",
  "local ttl = redis.call('PTTL', KEYS[1])",
  // ttl < 0 说明 key 没有过期时间（极端异常：上一次脚本中断在 INCR 与 PEXPIRE 之间）。
  // 这种情况下必须补设，否则该 key 永久存在 → 用户被永久限流。
  "if ttl < 0 then",
  "  redis.call('PEXPIRE', KEYS[1], ARGV[1])",
  "  ttl = redis.call('PTTL', KEYS[1])",
  "end",
  "return {n, ttl}",
].join('\n');

export interface RedisRateCounterOptions {
  redis: RedisCommandPort;
  /** key 前缀，多环境共用一个 Redis 时必须区分 */
  prefix?: string;
  /** 降级告警回调（打点/日志）。fail-open 必须留痕，否则等于静默失效 */
  onDegrade?: (info: { reason: string; bucket?: string }) => void;
  /** 降级恢复回调 */
  onRecover?: () => void;
}

export interface RateCounterStats {
  /** 因 Redis 不可用而放行的次数 */
  degradedPassCount: number;
  /** 命令失败次数 */
  errorCount: number;
  /** 是否处于降级状态 */
  degraded: boolean;
}

export class RedisRateCounter implements RateCounter {
  private redis: RedisCommandPort;
  private prefix: string;
  private onDegrade?: RedisRateCounterOptions['onDegrade'];
  private onRecover?: RedisRateCounterOptions['onRecover'];

  private stats: RateCounterStats = { degradedPassCount: 0, errorCount: 0, degraded: false };

  /**
   * 本地兜底计数：Redis 不可用时用这个保证**同一实例内**的粗暴限流仍然生效。
   *
   * 为什么不纯放行：Redis 挂掉的瞬间，单实例上的高频攻击仍然能被挡住，
   * 而跨实例的绕过我们接受（毕竟这是降级状态，已经告警了）。
   * 这个选择比「完全放行」好，比「fail-closed 全拒」也好——后者在 Redis
   * 重启的 5 秒里会把全部正常用户拒掉。
   */
  private local = new Map<string, { count: number; resetAt: number }>();

  constructor(opts: RedisRateCounterOptions) {
    this.redis = opts.redis;
    this.prefix = opts.prefix || 'judge:rl:';
    this.onDegrade = opts.onDegrade;
    this.onRecover = opts.onRecover;
  }

  getStats(): RateCounterStats {
    return Object.assign({}, this.stats);
  }

  /**
   * 同步版 incr —— RateCounter 接口是同步的，而 Redis 是异步的。
   *
   * 这个接口不匹配是个**已知张力**，处理方式必须显式：
   *   - Redis 通：发起异步命令，**当次请求用本地兜底值返回**（可能偏乐观），
   *              下一次请求读到的就是准确的 Redis 计数。
   *   - Redis 挂：直接返回本地值，并累加 degradedPassCount。
   *
   * 为什么不把 RateCounter 改成异步：那会牵动 RateLimiter 与整个 JudgeService.submit
   * 的调用链，而底层存储的同步/异步是实现细节，不该泄漏到业务层。
   * 代价是「多实例下第一个瞬间的计数可能偏乐观」，对 30 次/分的量级完全可接受。
   */
  incr(bucket: string, windowMs: number, now: number): number {
    const localCount = this.incrLocal(bucket, windowMs, now);
    this.dispatchIncr(bucket, windowMs);
    return localCount;
  }

  /**
   * 读数以 Redis 为准；取不到就用本地值。
   *
   * ⚠️ 这里刻意**不做「恢复」判定**。
   *    最初想用 `if (redis.available()) markRecovered()`，但这是个语义错误：
   *    连接层可用 ≠ 命令层能成功。Redis 连接正常而命令持续失败时，
   *    这个写法会把 stats.degraded 立刻抹平，于是降级告警永远等不到阈值、
   *    运维看不到任何异常。恢复判定只应由**真的成功的命令**触发（见 prefetch
   *    与 dispatchIncr 的成功回调）。
   */
  get(bucket: string, now: number): number {
    // 同步接口没法等 Redis，所以只能返回本地兜底值。
    // 权威读数由 prefetch() 在进入判题流程前异步回填。
    return this.readLocal(bucket, now);
  }

  ttl(bucket: string, now: number): number {
    return this.readLocalTtl(bucket, now);
  }

  /**
   * 异步预热：在请求进入判题流程**之前**把权威计数拉回本地。
   *
   * 这是对上面同步接口张力的补偿方案。server.js 在调用 JudgeService 之前
   * await 一次这个，于是限流判定用的就是 Redis 的真实计数。
   * 这样既保留了同步接口（不侵蚀业务层），又拿到了多实例正确的限流。
   */
  async prefetch(userId: string, now: number): Promise<void> {
    if (!this.redis.available()) {
      this.markDegraded('未连接');
      return;
    }
    try {
      // ⚠️ 这里有一个很容易写错、且**不会报错**的地方：
      //    RateLimiter 传给 incr()/get()/ttl() 的是「bucket = rl:m:<userId>」，
      //    而本地兜底表（this.local）必须用**同一个 bucket 字符串**做键。
      //    如果本地表用「加了前缀的 Redis key」做键，那么：
      //      prefetch 写入 local['judge:rl:rl:m:u9']
      //      get() 去读 local['rl:m:u9']  → 永远读不到
      //    表现就是「限流永远放行」，而且没有任何报错。所以：
      //      - 本地表键 = bucket（业务口径）
      //      - Redis 键   = prefix + bucket（存储口径）
      const minuteBucket = 'rl:m:' + userId;
      const dayBucket = 'rl:d:' + userId;
      const res = await this.redis.command(['MGET', this.redisKey(minuteBucket), this.redisKey(dayBucket)]);
      const arr = Array.isArray(res) ? res : [];
      this.syncFromRedis(minuteBucket, arr[0], 60 * 1000, now);
      this.syncFromRedis(dayBucket, arr[1], 24 * 60 * 60 * 1000, now);
      this.markRecoveredIfNeeded();
    } catch (e) {
      this.stats.errorCount++;
      this.markDegraded(e instanceof Error ? e.message : String(e));
    }
  }

  /** 给运维/自检用：清掉本地兜底状态 */
  resetLocal(): void {
    this.local.clear();
  }

  get prefixUsed(): string {
    return this.prefix;
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** bucket（业务层口径）→ Redis key。只此一处拼法，避免 prefetch 与 incr 漂移 */
  private redisKey(bucket: string): string {
    return this.prefix + bucket;
  }

  private dispatchIncr(bucket: string, windowMs: number): void {
    if (!this.redis.available()) {
      this.markDegraded('未连接');
      return;
    }
    const self = this;
    // 不 await：incr 是同步接口。失败只记数，不影响本次请求。
    this.redis
      .command(['EVAL', INCR_WITH_TTL_LUA, '1', this.redisKey(bucket), String(Math.round(windowMs))])
      .then(function (res) {
        self.markRecoveredIfNeeded();
        void res;
      })
      .catch(function (e: unknown) {
        self.stats.errorCount++;
        self.markDegraded(e instanceof Error ? e.message : String(e));
      });
  }

  private syncFromRedis(key: string, raw: unknown, windowMs: number, now: number): void {
    const count = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 0;
    if (!isFinite(count) || count <= 0) {
      // ⚠️ 依据是「**缺失**」即归零，而不是「解析出 0」。
      //    MGET 对不存在的 key 返回 null（不是 0），所以 null 明确表示「窗口已过」。
      //    但假如将来换成返回 '0' 的实现，也应当归零 —— 所以这里统一按
      //    hasValue 判断，避免把 null/0 混为一谈导致陈旧计数永不清除。
      this.local.delete(key);
      return;
    }
    const existing = this.local.get(key);
    // 本地重置时间保持不动：Redis 的 TTL 我们这里不查（省一次往返），
    // 用「最近一次写入时间 + 窗口」近似。偏保守方向是「不重置」——
    // 本地窗口只会比 Redis 窗口更晚结束，不会提前放开。
    const resetAt = existing && existing.resetAt > now ? existing.resetAt : now + windowMs;
    this.local.set(key, { count: count, resetAt: resetAt });
  }

  private incrLocal(bucket: string, windowMs: number, now: number): number {
    const cur = this.local.get(bucket);
    if (!cur || cur.resetAt <= now) {
      this.local.set(bucket, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }

  private readLocal(bucket: string, now: number): number {
    const cur = this.local.get(bucket);
    if (!cur || cur.resetAt <= now) return 0;
    return cur.count;
  }

  private readLocalTtl(bucket: string, now: number): number {
    const cur = this.local.get(bucket);
    if (!cur || cur.resetAt <= now) return 0;
    return cur.resetAt - now;
  }

  private markDegraded(reason: string): void {
    // ⚠️ 统计先加，early-return 只控制**告警**的去重。
    //    如果 return 写在自增之前，degradedPassCount 会永远停在 1，
    //    告警阈值（shouldAlertDegrade）就永远不会触发 —— 一个「看起来在打点
    //    其实什么都没打」的静默失效。
    this.stats.degradedPassCount++;
    if (this.stats.degraded) return;
    this.stats.degraded = true;
    if (this.onDegrade) this.onDegrade({ reason: reason });
  }

  private markRecoveredIfNeeded(): void {
    if (!this.stats.degraded) return;
    this.stats.degraded = false;
    if (this.onRecover) this.onRecover();
  }
}

/**
 * 把判定「是否要 alert」的逻辑抽出来，方便自检。
 *
 * 告警阈值：降级放行次数超过 100 次就说明 Redis 真的挂了，而不是一次瞬时抖动。
 * 瞬时抖动不该半夜叫人起来。
 */
export const DEGRADE_ALERT_THRESHOLD = 100;

export function shouldAlertDegrade(stats: RateCounterStats): boolean {
  return stats.degraded && stats.degradedPassCount >= DEGRADE_ALERT_THRESHOLD;
}
