/**
 * 判题服务 · Redis 结果缓存（幂等的生产实现）
 *
 * 替换 adapters.ts 的 MemoryResultCache。**多实例部署必须用它**：
 * 内存实现下「同一 submissionId 落在哪个实例」决定能不能命中，
 * 用户点两次重试可能排在两个实例上，于是同一份代码被判两次、
 * 烧两份算力，还可能出现两次结果不一致（例如一次 AC 一次 SE）。
 *
 * ── 三件事必须做对 ──────────────────────────────────────────────────
 *
 * ① **降级方向：无缓存重跑，而不是拒服务**
 *
 *    Redis 挂了的时候有两条路：
 *      a) 拒掉请求（fail-closed）→ 所有用户都不能提交代码 = 功能全挂
 *      b) 退回内存/不缓存（fail-open）→ 多烧点 CPU，用户无感
 *
 *    选 b。这和限流是同族取舍（算力是可恢复成本），
 *    与 nonce 重放拦截**相反**（那是安全事件，必须 fail-closed）。
 *    三处的降级方向不要抄来抄去，见各文件头部的说明。
 *
 * ② **读到的内容必须当不可信输入校验**
 *
 *    Redis 里的值可能来自旧版本代码、可能被人手工改过、可能被截断。
 *    直接 `JSON.parse` 当 JudgeResponse 用，会让一个坏值一路穿透到
 *    HTTP 响应体里。所以这里做**形状校验**：不像就当作没缓存。
 *    代价是少命中一次，收益是不会把脏数据当结果发给用户。
 *
 * ③ **不缓存「非终态」**
 *
 *    只有 ok 的终态结果才写。特别是 system-error：那是设施故障，
 *    把它缓存下来等于让用户永远看到同一个错误，即使故障已经恢复。
 *    这一点与内核的「错误结果也缓存（同一份错误代码应得同结论）」不冲突 ——
 *    内核缓存的是**用户代码导致的**错误，这里过滤的是**设施导致的**错误。
 */

import type { JudgeResponse } from '../contract';
import type { ResultCache } from '../judges/types-internal';
import type { RedisCommandPort } from './client';

export interface RedisResultCacheOptions {
  redis: RedisCommandPort;
  /** key 前缀，多环境共用一个 Redis 时必须区分 */
  prefix?: string;
  /** 结果保留时长（毫秒）。默认 24 小时 —— 足够覆盖「用户重试」与「重复回调」 */
  ttlMs?: number;
  /**
   * 单条结果序列化上限（字节）。超了就**不写**。
   * 判题结果里带测试点 preview，正常情况下几 KB；
   * 给一个上限是为了防止某个畸形结果把 Redis 内存打满。
   */
  maxValueBytes?: number;
  /** 降级回调（fail-open 必须留痕） */
  onDegrade?: (info: { reason: string; op: 'get' | 'set' }) => void;
  /** 恢复回调 */
  onRecover?: () => void;
}

/** 不该被缓存的结论：设施故障，缓存了会让故障「看起来永远没好」 */
const NON_CACHEABLE_VERDICTS: string[] = ['system-error'];

export class RedisResultCache implements ResultCache {
  private redis: RedisCommandPort;
  private prefix: string;
  private ttlMs: number;
  private maxValueBytes: number;
  private onDegrade?: RedisResultCacheOptions['onDegrade'];
  private onRecover?: RedisResultCacheOptions['onRecover'];

  /**
   * 本地兜底缓存。
   *
   * ⚠️ 它**不是**为了「提升命中率」——Redis 通的时候根本不参与，只有两种情况用：
   *    1. Redis 不可用（降级期），同一实例上的重提仍能秒回
   *    2. **本项被判定为不适合进 Redis**（超过 maxValueBytes）
   *       这种情况必须靠 localOnly 标记让 get() 知道要来这里找，
   *       否则会写进去一份、却永远读不到 —— 纯内存泄漏。
   *       这个坑是真实踩到的：写本地 + 跳过 Redis，而 get() 见 Redis 返回
   *       null 就直接判未命中。
   */
  private local = new Map<string, { value: JudgeResponse; expiresAt: number; localOnly: boolean }>();

  private stats = { hits: 0, misses: 0, degradedPass: 0, errors: 0, skipped: 0 };
  private degraded = false;

  constructor(opts: RedisResultCacheOptions) {
    this.redis = opts.redis;
    this.prefix = opts.prefix || 'judge:result:';
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : 24 * 60 * 60 * 1000;
    this.maxValueBytes = opts.maxValueBytes && opts.maxValueBytes > 0 ? opts.maxValueBytes : 512 * 1024;
    this.onDegrade = opts.onDegrade;
    this.onRecover = opts.onRecover;
  }

  async get(submissionId: string): Promise<JudgeResponse | undefined> {
    if (this.redis.available()) {
      try {
        const raw = await this.redis.command(['GET', this.key(submissionId)]);
        const parsed = parseResponse(raw);
        if (parsed) {
          this.stats.hits++;
          this.markRecoveredIfNeeded();
          // 命中时标记 cacheHit，方便前端区分「秒回」是不是真的判过了
          return Object.assign({}, parsed, { cacheHit: true });
        }
        this.stats.misses++;
        this.markRecoveredIfNeeded();
        // Redis 明确答复「没有」，就**不能**再退回本地兜底了：
        // 本地那份可能是降级期间写进去的旧值，也可能是被清理过的结果，
        // 用它会从本地「复活」一个 Redis 已删除的数据 —— 幂等就变成了「随机返回旧结果」。
        //
        // 唯一的例外是 localOnly 项（超过 maxValueBytes 的结果，我们主动没写 Redis）。
        // 那些项的存在本身就是「Redis 里注定没有」，所以必须查本地，
        // 否则它们会被写进去却永远读不到（纯内存泄漏）—— 这个坑真实踩过。
        const localOnly = this.readLocalIfOnly(submissionId);
        return localOnly;
      } catch (e) {
        this.stats.errors++;
        this.markDegraded(e, 'get');
      }
    } else {
      this.markDegraded(new Error('未连接'), 'get');
    }

    // ── 降级路径 ──
    this.stats.degradedPass++;
    return this.readLocal(submissionId);
  }

  async set(submissionId: string, res: JudgeResponse): Promise<void> {
    // 设施故障不缓存 —— 见文件头 ③
    if (!res || NON_CACHEABLE_VERDICTS.indexOf(String(res.verdict)) >= 0) {
      this.stats.skipped++;
      return;
    }

    let encoded: string;
    try {
      encoded = JSON.stringify(Object.assign({}, res, { cacheHit: false }));
    } catch (e) {
      // 循环引用等序列化失败：不能让它把判题流程带崩
      this.stats.errors++;
      this.markDegraded(e, 'set');
      return;
    }

    if (encoded.length > this.maxValueBytes) {
      this.stats.skipped++;
      // 超大结果只放本地（不占共享内存），并**不告警**：
      // 结果大小是题目属性，不是异常。
      //
      // ⚠️ 必须标记 localOnly=true。标记的意义是告诉 get()：
      //    「这一项 Redis 里**注定**没有，你得来本地找」。
      //    没有这个标记，get() 会按「Redis 权威」的原则直接判未命中，
      //    于是这份本地数据被写进去却永远读不到 —— 纯内存泄漏，且难以发现。
      this.writeLocal(submissionId, res, true);
      return;
    }

    // 本地也写一份：Redis 挂掉的瞬间，同一实例上的重提仍能秒回。
    // 标记 localOnly=false —— Redis 里会有权威副本，get() 应以 Redis 为准。
    this.writeLocal(submissionId, res, false);

    if (!this.redis.available()) {
      this.markDegraded(new Error('未连接'), 'set');
      return;
    }

    try {
      // ⚠️ 参数必须走数组（防 RESP 注入），且 key 由服务端拼 —— 见 redis/client.ts。
      // submissionId 已经过服务端白名单校验，但仍过一道净化：
      // 它最终会进 Redis key，含空格/换行会让 key 语义变得难以排查。
      await this.redis.command([
        'SET',
        this.key(submissionId),
        encoded,
        'PX',
        String(Math.max(1000, Math.round(this.ttlMs))),
      ]);
      this.markRecoveredIfNeeded();
    } catch (e) {
      this.stats.errors++;
      this.markDegraded(e, 'set');
      // fail-open：写失败不影响本次返回结果给用户。
      // 用户拿到的是「正确的判题结果」，只是下次重提会重跑一次。
    }
  }

  getStats(): {
    hits: number;
    misses: number;
    degradedPass: number;
    errors: number;
    skipped: number;
    degraded: boolean;
    localSize: number;
  } {
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      degradedPass: this.stats.degradedPass,
      errors: this.stats.errors,
      skipped: this.stats.skipped,
      degraded: this.degraded,
      localSize: this.local.size,
    };
  }

  get prefixUsed(): string {
    return this.prefix;
  }

  /* ------------------------------ 内部 ------------------------------ */

  private key(submissionId: string): string {
    return this.prefix + sanitizeKeyPart(submissionId);
  }

  /** 本地命中的统一出口：过期即删，命中时标记 cacheHit */
  private readLocal(submissionId: string): JudgeResponse | undefined {
    const hit = this.local.get(submissionId);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.local.delete(submissionId);
      return undefined;
    }
    return Object.assign({}, hit.value, { cacheHit: true });
  }

  /**
   * 只读 localOnly 项。
   *
   * 用于「Redis 明确说没有」之后的那一次兜底 ——
   * 见 get() 里的说明：普通本地副本在这里**不能**读（会复活已删除的数据），
   * 只有我们主动决定「不进 Redis」的那些项才允许从这里取。
   */
  private readLocalIfOnly(submissionId: string): JudgeResponse | undefined {
    const hit = this.local.get(submissionId);
    if (!hit || !hit.localOnly) return undefined;
    return this.readLocal(submissionId);
  }

  private writeLocal(submissionId: string, res: JudgeResponse, localOnly: boolean): void {
    // 本地兜底也带 TTL，否则长跑实例上的 Map 会无限增长
    this.local.set(submissionId, {
      value: Object.assign({}, res, { cacheHit: false }),
      expiresAt: Date.now() + this.ttlMs,
      localOnly: localOnly,
    });
    // 简易容量控制：超过 1000 条就清掉已过期的，仍超就丢最老的。
    // 不做 LRU —— 这不是缓存层该承担的责任，Redis 才是。
    if (this.local.size > 1000) this.sweepLocal();
  }

  private sweepLocal(): void {
    const now = Date.now();
    const keys = Array.from(this.local.keys());
    for (let i = 0; i < keys.length; i++) {
      const v = this.local.get(keys[i]);
      if (!v || v.expiresAt <= now) this.local.delete(keys[i]);
    }
    while (this.local.size > 1000) {
      const oldest = this.local.keys().next();
      if (oldest.done) break;
      this.local.delete(oldest.value);
    }
  }

  private markDegraded(reason: unknown, op: 'get' | 'set'): void {
    // ⚠️ 统计先加，early-return 只控制**告警**去重（与 rate-counter.ts 同款坑）
    if (this.degraded) return;
    this.degraded = true;
    if (this.onDegrade) {
      this.onDegrade({ reason: reason instanceof Error ? reason.message : String(reason), op: op });
    }
  }

  private markRecoveredIfNeeded(): void {
    if (!this.degraded) return;
    this.degraded = false;
    if (this.onRecover) this.onRecover();
  }
}

/**
 * 校验从 Redis 读回来的东西「像不像」一个 JudgeResponse。
 *
 * 刻意写得偏严格：宁可少命中一次，也不要把脏值发给用户。
 * 只校验对外可见的必需字段，不做深层校验（深层校验属于 contract 的职责）。
 */
export function parseResponse(raw: unknown): JudgeResponse | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    // Redis 客户端在 RESP 层已经解好了类型；非字符串说明不是我们写的值
    return undefined;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;

  const o = obj as Record<string, unknown>;
  if (typeof o.submissionId !== 'string' || !o.submissionId) return undefined;
  if (typeof o.verdict !== 'string' || !o.verdict) return undefined;
  if (typeof o.score !== 'number' || !isFinite(o.score)) return undefined;
  if (typeof o.passed !== 'number' || typeof o.total !== 'number') return undefined;
  if (!Array.isArray(o.cases)) return undefined;
  if (typeof o.finishedAt !== 'number') return undefined;

  return obj as JudgeResponse;
}

/** Redis key 片段净化：只留安全字符。纯防御，调用方已经做过白名单 */
export function sanitizeKeyPart(s: string): string {
  const v = String(s).replace(/[^a-zA-Z0-9_.:-]/g, '');
  return v.slice(0, 128) || 'unknown';
}

/**
 * 结果缓存的降级方向说明常量 —— 给自检和文档一个可引用的锚点。
 *
 * 这三处降级方向是全项目最容易「顺手抄错」的地方，
 * 所以把结论摆在代码里，而不是只写在文档里。
 */
export const DEGRADE_POLICY = {
  /** 限流：放行，多烧算力 */
  rateLimit: 'fail-open',
  /** 重放拦截：退回单实例内存，宁可少挡不放行 */
  nonce: 'fail-degraded',
  /** 结果缓存：不缓存、重跑一次 */
  resultCache: 'fail-open',
} as const;
