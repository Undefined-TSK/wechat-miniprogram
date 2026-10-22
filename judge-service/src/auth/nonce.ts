/**
 * 判题服务 · nonce 重放拦截
 *
 * 签名本身只能证明「这个请求确实由持 token 的人构造过」，**不能**阻止
 * 攻击者把抓到的请求原样再发一次（时间窗内的合法签名）。拦住重放要靠 nonce：
 * 同一个 nonce 在一个时间窗内只允许成功登记一次。
 *
 * ⚠️ 实现上最容易犯错的地方：**不能先查后写**。
 *
 *     错误写法：if (await has(nonce)) return replay;  await set(nonce);
 *     问题：两个并发请求可以同时通过 has()，然后都 set() 成功 —— 重放成功。
 *
 *     正确写法：把「写入并独占」当成唯一原语（Redis 的 SET NX / Map 的单线程 set），
 *              写入失败即视为重放。并发安全由存储本身的原子性保证。
 *
 * 内存实现之所以在单进程里也是安全的：Node 是单线程事件循环，
 * 只要这个 check-and-set 之间**没有 await**，就不会被打断。
 * 这不是巧合，是刻意把整个操作压成一个同步块。
 */

import type { RedisCommandPort } from '../redis/client';

export interface NonceStore {
  /**
   * 尝试独占该 nonce。
   * @returns true = 首次使用（放行）；false = 已被用过（重放，拒绝）
   */
  claim(nonce: string, ttlMs: number): Promise<boolean>;
  /** 存储是否可用。不可用时按「fail-closed」处理：宁可拒也别放行重放 */
  available(): boolean;
  close?(): Promise<void>;
}

/**
 * 单实例内存实现。
 *
 * ⚠️ 多实例部署下**不安全**：请求轮到 A 实例登记、重放到 B 实例时会各自放行一次。
 *    生产必须用 RedisNonceStore（见下），并在启动日志里显式提示。
 */
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts?: { sweepIntervalMs?: number }) {
    const interval = opts && opts.sweepIntervalMs ? opts.sweepIntervalMs : 60 * 1000;
    // unref：不要让这个定时器把进程钉住，否则 SIGTERM 后进程不退出
    this.timer = setInterval(() => this.sweep(), interval);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  async claim(nonce: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // 关键：check 与 set 之间没有任何 await
    const existing = this.seen.get(nonce);
    if (existing !== undefined && existing > now) return false;
    this.seen.set(nonce, now + ttlMs);
    return true;
  }

  available(): boolean {
    return true;
  }

  /** 清理过期项，避免内存随请求数无限增长 */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    const keys = Array.from(this.seen.keys());
    for (let i = 0; i < keys.length; i++) {
      const exp = this.seen.get(keys[i]);
      if (exp !== undefined && exp <= now) {
        this.seen.delete(keys[i]);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.seen.size;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Redis 实现。
 *
 * `SET key value NX PX ttl` 是 Redis 的原子原语：
 *   返回 OK   → 我们抢到了这个 key（首次使用）
 *   返回 nil  → key 已存在（重放）
 *
 * ⚠️ 不用 INCR + EXPIRE 两步：两个命令之间会断，且 INCR 无法表达「保留 ttl」。
 */
export class RedisNonceStore implements NonceStore {
  private redis: RedisCommandPort;
  private prefix: string;

  constructor(redis: RedisCommandPort, prefix?: string) {
    this.redis = redis;
    this.prefix = prefix || 'judge:nonce:';
  }

  async claim(nonce: string, ttlMs: number): Promise<boolean> {
    const ttl = Math.max(1000, Math.round(ttlMs));
    const res = await this.redis.command(['SET', this.prefix + nonce, '1', 'NX', 'PX', String(ttl)]);
    // redis 返回 nil 时我们的客户端表示为 null
    return res !== null && res !== undefined;
  }

  available(): boolean {
    return this.redis.available();
  }

  async close(): Promise<void> {
    // 不主动断连接：redis 客户端由 bootstrap 统一管理生命周期
  }
}

/**
 * 组合存储：主存储不可用时降级到内存，并打点。
 *
 * 为什么这里**可以**降级而限流那里是 fail-open：
 *   - 限流降级的代价 = 多烧一点 CPU（可恢复）
 *   - 重放拦截降级的代价 = 攻击者能用抓到的签名重放（安全事件）
 *   所以重放拦截的降级方向相反：宁可退回单实例内存实现（仍能挡住绝大多数
 *   非并发重放），也不要什么都不做。
 *
 * 但如果连内存都不可用（不可能），则 fail-closed 拒掉请求。
 */
export class FailoverNonceStore implements NonceStore {
  private primary: NonceStore;
  private fallback: NonceStore;
  private onDegrade?: (reason: string) => void;
  private degraded = false;

  constructor(primary: NonceStore, fallback: NonceStore, onDegrade?: (reason: string) => void) {
    this.primary = primary;
    this.fallback = fallback;
    this.onDegrade = onDegrade;
  }

  async claim(nonce: string, ttlMs: number): Promise<boolean> {
    if (this.primary.available()) {
      try {
        const got = await this.primary.claim(nonce, ttlMs);
        if (this.degraded) {
          this.degraded = false;
          if (this.onDegrade) this.onDegrade('redis 已恢复');
        }
        return got;
      } catch (e) {
        this.markDegraded(e);
      }
    } else {
      this.markDegraded('redis 不可用');
    }

    // 降级路径：主存储不可用，用内存顶住
    return this.fallback.claim(nonce, ttlMs);
  }

  available(): boolean {
    return this.primary.available() || this.fallback.available();
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  async close(): Promise<void> {
    if (this.fallback.close) await this.fallback.close();
    if (this.primary.close) await this.primary.close();
  }

  private markDegraded(reason: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    if (this.onDegrade) this.onDegrade(String(reason));
  }
}
