/**
 * 判题服务 · 题库来源适配层
 *
 * ── 这层解决什么问题 ────────────────────────────────────────────────
 *
 * 判题服务需要「某道题在某语言下的测试点」（JudgePlan）。这些数据最终住在
 * 云开发数据库里（题库后台录入 + 人工审核 + 版权台账），但现在云服务还没搭。
 *
 * 于是把「怎么拿到原始计划」抽成一个端口 `PlanSource`，再往上包一层
 * `PlanProvider`（内核只认这个，见 judges/types-internal.ts）：
 *
 *     MemoryPlanProvider ← PlanSource ← { HttpPlanSource, CloudPlanSource, ... }
 *                              ↑
 *                         normalizeJudgePlan（脏数据在这里被挡住）
 *
 * 云服务搭好之后，**只需要实现/配置一个 PlanSource**，主流程一行都不用改。
 * 这一点是刻意的：判题链路是所有业务里最不该被基础设施变更牵连的一段。
 *
 * ── 三个必须做对的地方 ─────────────────────────────────────────────
 *
 * ① **绝不把网络错误说成「题目不存在」**
 *    两者对用户的含义完全相反：前者应该「稍后重试」，后者应该「这题还没配好」。
 *    混在一起会让用户对着一个「题目不存在」的提示反复重试 —— 白等。
 *    所以 PlanSource 用 `{ ok: true, value | undefined }` 而不是 `T | undefined`
 *    来表达结果：undefined 只表示「题库明确答复没有这道题」。
 *
 * ② **一次性加载后靠版本号失效，不要缓存失败**
 *    判题是高 QPS 路径，每道题都打一次题库接口等于把题库拖垮。
 *    但「缓存空结果」会把一个瞬时抖动固化成「这题永远是坏了」，
 *    必须等到 TTL 才恢复。所以：只有成功才写缓存，失败一律不留。
 *
 * ③ **规范化不是可选项**
 *    题库是人工录入的，脏数据一定会出现。而脏数据会一路突破到
 *    测试点比对上，表现为「用户答案全对但判错」—— 最贵的那种 bug。
 *    所以在**进入内核之前**先规范化：夹住配额、补全 index、剥掉多余字段。
 *    注意这里是「就地修复能修的，修不了才拒」，不是「不合格就整条扔掉」：
 *    扔掉等于用户答了一道好题却拿不到分。
 */

import { MAX_OUTPUT_BYTES, type JudgeLanguage } from '../contract';
import { validatePlan, type CompareMode, type JudgePlan, type TestCase } from './testcases';

/* ------------------------------ 端口 ------------------------------ */

/**
 * 一次「原始计划」查询的结果。
 *
 * 为什么不用 `JudgePlan | undefined`：见文件头 ①。
 * 把「没有」和「查不到」压成同一个值，是这个项目里最容易发生、
 * 又最难在联调阶段发现的一类错误。
 */
export interface PlanLookup {
  ok: boolean;
  /** 仅当 ok === true 且题库确实有这道题时存在 */
  value?: JudgePlan;
  /** 失败原因（会进日志，不回传用户） */
  error?: string;
  /** 是否值得重试：网络抖动为 true，题库明确报 404 为 false */
  retryable?: boolean;
}

export interface PlanSource {
  /** 实现名，用于日志与自检断言 */
  readonly name: string;
  fetchPlan(questionId: string, language: string): Promise<PlanLookup>;
}

/* ------------------------------ 配置 ------------------------------ */

export interface PlanSourceConfig {
  /** 'memory' | 'http' | 'cloud' —— 未知值一律退回 memory 并告警 */
  kind: string;
  /** http / cloud 用：题库接口基址 */
  baseUrl: string;
  /** 云开发通道用：环境 ID（cloud:// 之类由实现决定，这里只存字符串） */
  envId: string;
  /** 服务端凭据（题库后台 API token）。**绝不放到客户端** */
  token: string;
  /** 单次查询超时（毫秒）。题库慢不能让判题请求一起卡住 */
  timeoutMs: number;
  /** 成功后结果缓存多久（毫秒）。因为测试点内容基本不变，可以给得比较宽 */
  cacheTtlMs: number;
}

export const DEFAULT_PLAN_SOURCE: PlanSourceConfig = {
  kind: 'memory',
  baseUrl: '',
  envId: '',
  token: '',
  timeoutMs: 3000,
  cacheTtlMs: 5 * 60 * 1000,
};

/* --------------------------- 规范化 --------------------------- */

/** 单题测试点数量上限。防的是「题库被写坏 / 被塞」导致一次提交跑上千个容器 */
export const MAX_CASES_PER_PLAN = 50;

export interface NormalizeResult {
  /** 规范化后的计划；null = 有一条坏到无法修复的理由 */
  plan?: JudgePlan;
  /** 就地修掉的问题（要进日志：这是题库质量信号，不是正常运行噪音） */
  fixes: string[];
  errors: string[];
}

/**
 * 把题库里的原始记录整理成内核能安全消费的 JudgePlan。
 *
 * 设计取舍：**能修的修，不能修的拒**。
 *   - 能修：缺 index（按顺序补）、字符串化的数字、缺少 compare（用默认）、
 *           stdin/expected 里的 \r\n（Windows 上录题很容易带进来）、
 *           期望输出超长（截断会让比对永远失败 → 直接拒而不是静默截断；
 *           注意这里选择拒，因为截断后「用户答案对但判错」更难排查）
 *   - 拒：没有 cases、语言不支持、配额无效
 */
export function normalizeJudgePlan(
  raw: unknown,
  questionId: string,
  language: string
): NormalizeResult {
  const fixes: string[] = [];
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { fixes, errors: ['题库返回的计划不是对象'] };
  }

  const src = raw as Record<string, unknown>;

  const plan: JudgePlan = {
    questionId: typeof src.questionId === 'string' && src.questionId ? src.questionId : questionId,
    language: coerceLanguage(src.language, language, errors),
    cases: normalizeCases(src.cases, fixes, errors),
    judgeMs: posInt(src.judgeMs),
    memoryMB: posInt(src.memoryMB),
    compare: coerceCompare(src.compare, fixes),
  };

  if (typeof src.note === 'string' && src.note) plan.note = src.note;

  if (!(plan.judgeMs > 0)) errors.push('judgeMs 缺失或非法');
  if (!(plan.memoryMB > 0)) errors.push('memoryMB 缺失或非法');

  // 最后再过一次内核自己的校验器 —— 复用同一套规则，避免两处口径漂移。
  // 这里不重复实现，只是多一道闸。
  const v = validatePlan(plan);
  for (let i = 0; i < v.errors.length; i++) {
    if (errors.indexOf(v.errors[i]) < 0) errors.push(v.errors[i]);
  }

  if (errors.length > 0) return { fixes, errors };
  return { plan, fixes, errors };
}

function normalizeCases(raw: unknown, fixes: string[], errors: string[]): TestCase[] {
  if (!Array.isArray(raw)) {
    errors.push('cases 不是数组');
    return [];
  }
  if (raw.length === 0) {
    errors.push('至少需要一个测试点');
    return [];
  }

  const out: TestCase[] = [];
  const limit = Math.min(raw.length, MAX_CASES_PER_PLAN);
  if (raw.length > limit) {
    fixes.push('测试点超过 ' + MAX_CASES_PER_PLAN + ' 个，已截断（题库侧应拆分题目）');
  }

  for (let i = 0; i < limit; i++) {
    const c = raw[i] as Record<string, unknown> | null | undefined;
    if (!c || typeof c !== 'object') {
      errors.push('第 ' + (i + 1) + ' 个测试点不是对象');
      continue;
    }

    const stdin = toText(c.stdin);
    const expected = toText(c.expected);

    if (expected.length > MAX_OUTPUT_BYTES) {
      // 不截断：截断后的期望输出会让「输出正确的用户」判错，属于静默误伤
      errors.push('第 ' + (i + 1) + ' 个测试点期望输出超过上限（' + MAX_OUTPUT_BYTES + 'B）');
      continue;
    }

    const index = Number(c.index);
    const tc: TestCase = {
      index: isFinite(index) && index > 0 ? Math.floor(index) : i + 1,
      stdin: stdin,
      expected: expected,
    };
    if (!isFinite(index) || index <= 0) {
      fixes.push('第 ' + (i + 1) + ' 个测试点缺少 index，已按顺序补为 ' + (i + 1));
    }
    if (c.hidden === true || c.hidden === 1 || c.hidden === 'true') tc.hidden = true;
    const rm = Number(c.runMs);
    if (isFinite(rm) && rm > 0) tc.runMs = Math.floor(rm);
    const mm = Number(c.memoryMB);
    if (isFinite(mm) && mm > 0) tc.memoryMB = Math.floor(mm);

    out.push(tc);
  }

  return out;
}

function coerceLanguage(raw: unknown, fallback: string, errors: string[]): JudgeLanguage {
  const v = typeof raw === 'string' && raw ? raw : fallback;
  if (v === 'c' || v === 'cpp' || v === 'python') return v;
  errors.push('不支持的语言：' + String(v));
  return fallback as JudgeLanguage;
}

function coerceCompare(raw: unknown, fixes: string[]): CompareMode {
  if (raw === 'exact-lines' || raw === 'collapse' || raw === 'numeric') return raw;
  if (raw !== undefined && raw !== null && raw !== '') {
    fixes.push('未知的比对口径 ' + JSON.stringify(raw) + '，已退回 exact-lines');
  }
  return 'exact-lines';
}

function posInt(raw: unknown): number {
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * 把 stdin / expected 统一成本服务端认定的字符串。
 *
 * 三个细节都是踩过的坑：
 *   - \r\n：录题的人在 Windows 上复制粘贴会带进来，导致逐行比对永远不等
 *   - 数字/布尔：题库里写成 `expected: 15` 而不是 `"15\n"` 很常见
 *   - '' 与 null 的区别：null 表示「这题不该有输入」，转成 undefined 会
 *     破坏 TestCase 的 string 契约，所以统一成空串
 */
function toText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const s = typeof raw === 'string' ? raw : String(raw);
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/* --------------------------- HTTP 实现 --------------------------- */

export interface PlanSourceDeps {
  /** 注入 fetch（自检用）。不传则用全局 fetch（Node 18+ 内置，无需依赖） */
  fetchImpl?: typeof fetch;
}

/**
 * 通过 HTTP 从题库后台读测试点。
 *
 * 适合两种部署：
 *   - 题库后台在自建服务里（和判题服务同网段）
 *   - 走云开发的 HTTP 触发器 / 云函数 HTTP 访问服务（见 CloudPlanSource）
 *
 * 请求形态刻意极简：`GET {baseUrl}/plans/{questionId}/{language}`，
 * 只带一个 Bearer token。题库接口长什么样由题库侧决定，但
 * **判题侧只认「一个能返回 JudgePlan 的 URL」** —— 这样换实现不用改判题。
 */
export class HttpPlanSource implements PlanSource {
  readonly name: string;
  private cfg: PlanSourceConfig;
  private fetchImpl: typeof fetch;

  constructor(cfg: PlanSourceConfig, deps?: PlanSourceDeps) {
    this.cfg = cfg;
    this.name = 'http:' + redactUrl(cfg.baseUrl);
    const f = deps && deps.fetchImpl ? deps.fetchImpl : (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) {
      // Node 18 以下没有全局 fetch。不做 polyfill：判题服务是零依赖项目，
      // 引一个 fetch 库不值得。直接说明清楚比静默出错好。
      throw new Error('[plans] 当前运行时没有全局 fetch，无法使用 HttpPlanSource');
    }
    this.fetchImpl = f;
  }

  async fetchPlan(questionId: string, language: string): Promise<PlanLookup> {
    if (!this.cfg.baseUrl) {
      return { ok: false, error: '题库接口地址未配置', retryable: false };
    }

    const url =
      this.cfg.baseUrl.replace(/\/+$/, '') +
      '/plans/' +
      encodeURIComponent(questionId) +
      '/' +
      encodeURIComponent(language);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(function () {
          controller.abort();
        }, this.cfg.timeoutMs)
      : null;

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.cfg.token) headers.authorization = 'Bearer ' + this.cfg.token;

      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: headers,
        signal: controller ? controller.signal : undefined,
      });

      // 404 是**明确答复**：这道题在题库里没有计划。
      // 它与「请求失败」必须分开，否则用户会对着「题目不存在」反复重试。
      if (res.status === 404) return { ok: true, value: undefined };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: '题库接口鉴权失败（' + res.status + '）', retryable: false };
      }
      if (!res.ok) {
        return { ok: false, error: '题库接口返回 ' + res.status, retryable: res.status >= 500 };
      }

      const body = (await res.json()) as unknown;
      // 题库可能把计划包一层（{ plan: {...} } / { data: {...} }），两种都认
      const unwrapped = unwrap(body);
      if (unwrapped === undefined) return { ok: true, value: undefined };
      return { ok: true, value: unwrapped as JudgePlan };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const aborted = /abort/i.test(msg);
      return {
        ok: false,
        error: aborted ? '题库接口超时（' + this.cfg.timeoutMs + 'ms）' : '题库接口请求失败：' + msg,
        retryable: true,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function unwrap(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, unknown>;
  if (b.plan) return b.plan;
  if (b.data) return b.data;
  return body;
}

/** 打日志时把 token/query 去掉，只留 host —— 免得凭据进日志 */
function redactUrl(url: string): string {
  if (!url) return '(未配置)';
  return url.replace(/\?.*$/, '').replace(/\/\/[^@/]*@/, '//');
}

/* ----------------------- 云开发通道实现 ----------------------- */

/**
 * 通过云开发的「HTTP 访问服务 / 云函数 HTTP 触发器」读测试点。
 *
 * 为什么不直接在判题服务里引 @cloudbase/node-sdk：
 *   判题服务是**唯一主动执行陌生人代码**的组件，依赖越少攻击面越小
 *   （见 redis/client.ts 的同类决策）。而云开发的 HTTP 访问服务本身
 *   就提供了 HTTPS 入口，用 fetch 走它就够，不需要再引 SDK。
 *   代价是我们得自己拼 URL —— 这个代价是值得的。
 *
 * 与 HttpPlanSource 的差别只有 URL 形状：
 *   `{baseUrl}/{envId}/plans/{questionId}/{language}`
 * `baseUrl` 填云开发 HTTP 访问服务的域名即可。
 *
 * ⚠️ 云函数侧必须做两件事（等真正搭云服务时落地）：
 *   1. 校验调用方身份，**不能裸奔**（判题服务带 Bearer token，云函数侧要验）
 *   2. 只读题库、且只返回 judge_plans 集合 —— 不要复用一个通用查询函数
 */
export class CloudPlanSource implements PlanSource {
  readonly name = 'cloud';
  private inner: HttpPlanSource;
  private cfg: PlanSourceConfig;

  constructor(cfg: PlanSourceConfig, deps?: PlanSourceDeps) {
    this.cfg = cfg;
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const withEnv = cfg.envId ? base + '/' + encodeURIComponent(cfg.envId) : base;
    this.inner = new HttpPlanSource(Object.assign({}, cfg, { baseUrl: withEnv }), deps);
  }

  fetchPlan(questionId: string, language: string): Promise<PlanLookup> {
    if (!this.cfg.envId) {
      return Promise.resolve({
        ok: false,
        error: '云开发环境 ID 未配置（JUDGE_CLOUD_ENV_ID）',
        retryable: false,
      });
    }
    return this.inner.fetchPlan(questionId, language);
  }
}

/* --------------------------- 工厂 --------------------------- */

/**
 * 按配置造一个 PlanSource。
 *
 * 未知 kind **不静默退回** ：退回去会让生产环境悄悄跑在内存样例上，
 * 表现为「所有真实题目都判成题目不存在」，而运维看配置以为接的是云开发。
 * 所以这里退回内存的同时，把「配置写错了」这件事说出来。
 */
export function createPlanSource(
  cfg: PlanSourceConfig,
  deps?: PlanSourceDeps
): { source: PlanSource; warnings: string[] } {
  const warnings: string[] = [];
  const kind = (cfg.kind || 'memory').toLowerCase();

  if (kind === 'http') {
    if (!cfg.baseUrl) warnings.push('JUDGE_PLAN_SOURCE=http 但未配置 JUDGE_PLAN_BASE_URL，题库查询会全部失败');
    return { source: new HttpPlanSource(cfg, deps), warnings };
  }
  if (kind === 'cloud') {
    if (!cfg.baseUrl) warnings.push('JUDGE_PLAN_SOURCE=cloud 但未配置 JUDGE_PLAN_BASE_URL（云开发 HTTP 访问服务域名）');
    if (!cfg.envId) warnings.push('JUDGE_PLAN_SOURCE=cloud 但未配置 JUDGE_CLOUD_ENV_ID');
    return { source: new CloudPlanSource(cfg, deps), warnings };
  }
  if (kind !== 'memory') {
    warnings.push('未知的 JUDGE_PLAN_SOURCE=' + cfg.kind + '，已退回内置样例题（生产环境请修正配置）');
  }
  return { source: new MemoryPlanSource(), warnings };
}

/* --------------------------- 内存实现 --------------------------- */

/**
 * 内置样例题。**开发与自检用**，不要在生产打开。
 *
 * 它同时是 PlanSource 的参考实现：任何新接的题库只要能让
 * 「fetchPlan → PlanLookup」成立，就能替换掉它而不动主流程。
 */
export class MemoryPlanSource implements PlanSource {
  readonly name = 'memory';
  private plans = new Map<string, JudgePlan>();

  constructor(seed?: JudgePlan[]) {
    if (seed) for (let i = 0; i < seed.length; i++) this.add(seed[i]);
  }

  add(plan: JudgePlan): void {
    this.plans.set(keyOf(plan.questionId, plan.language), plan);
  }

  fetchPlan(questionId: string, language: string): Promise<PlanLookup> {
    const hit = this.plans.get(keyOf(questionId, language));
    // 内存样例里没有就是真的没有 —— 与 http 的 404 语义一致
    return Promise.resolve({ ok: true, value: hit });
  }

  get size(): number {
    return this.plans.size;
  }
}

/** 计划的存储键。**只此一处拼法**，避免各实现漂移出「查不到但不报错」 */
export function keyOf(questionId: string, language: string): string {
  return String(questionId) + '::' + String(language);
}
