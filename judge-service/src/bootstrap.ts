/**
 * 判题服务 · 组装入口
 *
 * 把环境变量翻译成一个个适配器，再把适配器装配成 JudgeService。
 *
 * 为什么要单独一个文件而不是写在 server.js 里：
 *   自检需要能在**不起 HTTP 服务、不连 Redis、不装 docker** 的前提下
 *   构造出一套完整的依赖。把这些组装逻辑集中在这里之后，
 *   tests/judge-http.test.mjs 可以注入假 Redis / 假执行器，
 *   而 server.js 只负责 HTTP 语义（路由、状态码、超时、优雅退出）。
 *
 * 配置全部走环境变量，且每一项都有默认值——**默认值必须能安全跑起来**：
 * 缺 token 时不是「跳过鉴权」，而是直接拒绝启动（见 assertConfig）。
 * 一个「没配 token 就全放行」的默认值，是最容易漏到生产的鉴权漏洞。
 */

import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_LIMITS,
  RATE_LIMIT,
  type JudgeErrorCode,
  type JudgeRequest,
  type JudgeResponse,
} from './contract';
import { AUTH_WINDOW_MS, NONCE_TTL_MS } from './auth';
import { MemoryNonceStore, RedisNonceStore, FailoverNonceStore, type NonceStore } from './auth/nonce';
import { RedisClient } from './redis/client';
import { RedisRateCounter, DEGRADE_ALERT_THRESHOLD } from './redis/rate-counter';
import { RedisResultCache } from './redis/result-cache';
import { MemoryRateCounter, RateLimiter, type RateCounter } from './sandbox/ratelimit';
import { SandboxRunner, type Executor } from './sandbox/runner';
import { DockerExecutor } from './sandbox/docker-executor';
import { LocalExecutor, LOCAL_MODE_WARNING, probeLocalToolchain } from './sandbox/local-executor';
import { JudgeService } from './judges/index';
import { canPrefetch } from './judges/types-internal';
import { MemoryResultCache, LocalWorkspace, defaultFileNames } from './adapters';
import { JUDGE_PLANS } from './questions/mock-plans';
import { OBJECTIVE_ANSWERS } from './questions/mock-answers';
import { createPlanSource, type PlanSourceConfig } from './questions/source';
import { PlanRepository } from './questions/providers';
import { AnswerRepository, createAnswerSource } from './questions/answers';
import type { PlanProvider, ResultCache } from './judges/types-internal';

export interface JudgeConfig {
  port: number;
  host: string;
  token: string;
  redisUrl: string;
  workspaceRoot: string;
  seccompProfile: string;
  perMinute: number;
  perDay: number;
  cooldownMs: number;
  maxBodyBytes: number;
  maxConcurrent: number;
  requestTimeoutMs: number;
  authWindowMs: number;
  nonceTtlMs: number;
  /** 无 docker 的本地/自检模式：不真的执行容器 */
  dryRun: boolean;
  /* ---- 外部依赖入口（云服务搭好前先用默认值跑通） ---- */
  /** 题库来源配置。kind=memory 时用内置样例题 */
  planSource: PlanSourceConfig;
  /** 结果缓存后端：'memory' | 'redis'。redis 但没配 REDIS_URL 会自动退回 memory */
  resultCacheBackend: string;
  /** 结果缓存保留时长（毫秒） */
  resultCacheTtlMs: number;
  /**
   * 客观题答案缓存时长（毫秒）。
   *
   * ⚠️ 明显短于测试点缓存：运营改一次答案要立刻生效，
   *    否则那段时间内所有用户都在被判错的答案上。
   */
  objectiveAnswerCacheTtlMs: number;
  /**
   * 判题沙箱后端：'docker'（默认，生产必须） | 'local'（仅本机开发，无隔离）
   *
   * 为什么要有 local：项目早期自己开发/录题验证时，不该为了跑通判题链路
   * 先装一整套 Docker。local 模式能在零成本下验证整条链路。
   * ⚠️ 它没有任何隔离，用户代码以你的身份在本机直接跑 —— 见 local-executor.ts。
   */
  sandboxBackend: string;
}

export interface JudgeBundle {
  config: JudgeConfig;
  service: JudgeService;
  limiter: RateLimiter;
  counter: RateCounter;
  nullRateCounter: boolean;
  rateLimiterDegraded: boolean;
  nonceStore: NonceStore;
  redis: RedisClient | null;
  /** 编程题测试点提供者。运维/自检可以直接用它读统计、失效缓存 */
  plans: PlanProvider;
  /** 客观题答案仓储（Boss 关 / 挑战关的选择、填空、程序输出题） */
  objectivePlans: AnswerRepository;
  /** 结果缓存。同上 */
  resultCache: ResultCache;
  shutdown: () => Promise<void>;
  /** 启动时的配置告警（会打进日志，也是自检的断言对象） */
  warnings: string[];
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 读取配置并做**启动阻断式**校验。
 *
 * 校验的取舍：
 *   - 缺 token → 直接抛错，服务不启动。生产里宁可起不来，也不要裸奔。
 *   - 缺 Redis → 只告警，降级到内存实现。因为单实例内测时没 Redis 是常态。
 */
export function loadConfig(): { config: JudgeConfig; warnings: string[] } {
  const warnings: string[] = [];

  const token = env('JUDGE_INTERNAL_TOKEN', '');
  const isProd = env('NODE_ENV', 'development') === 'production';

  if (!token) {
    if (isProd) {
      // 这个抛错是刻意的：production 下没有 token 就绝对不启动
      throw new Error(
        '[judge] 生产环境必须配置 JUDGE_INTERNAL_TOKEN。' +
          '拒绝以「无鉴权」状态启动——判题服务会执行任意用户代码，裸奔等于把服务器交出去。'
      );
    }
    warnings.push('未配置 JUDGE_INTERNAL_TOKEN，当前使用开发用默认 token（仅限本机开发）');
  }

  const effectiveToken = token || 'dev-only-token-do-not-use-in-production';

  const redisUrl = env('JUDGE_REDIS_URL', '');
  if (!redisUrl) {
    warnings.push(
      '未配置 JUDGE_REDIS_URL：限流与 nonce 将退化为单实例内存实现。' +
        '多实例部署下实际放行量 = 配置值 × 实例数，且重放拦截只在单实例内有效。'
    );
  }

  const workspaceRoot = env('JUDGE_WORKSPACE_ROOT', path.join(os.tmpdir(), 'judge-workspace'));
  const maxBodyBytes = envInt('JUDGE_MAX_BODY_BYTES', 512 * 1024);
  const maxConcurrent = envInt('JUDGE_MAX_CONCURRENT', Math.max(2, os.cpus().length));
  const requestTimeoutMs = envInt('JUDGE_REQUEST_TIMEOUT_MS', 60 * 1000);

  /* ------------------- 题库来源（外部依赖入口） ------------------- */

  const planKind = env('JUDGE_PLAN_SOURCE', 'memory').toLowerCase();
  const planBaseUrl = env('JUDGE_PLAN_BASE_URL', '');
  const planEnvId = env('JUDGE_CLOUD_ENV_ID', '');
  const planToken = env('JUDGE_PLAN_TOKEN', '');

  if (planKind !== 'memory' && planKind !== 'http' && planKind !== 'cloud') {
    warnings.push(
      'JUDGE_PLAN_SOURCE=' + planKind + ' 不是已知取值（memory/http/cloud），已按 memory（内置样例题）启动'
    );
  }
  if (planKind === 'http' || planKind === 'cloud') {
    if (!planBaseUrl) {
      warnings.push('题库来源为 ' + planKind + ' 但未配置 JUDGE_PLAN_BASE_URL：所有题目查询都会失败');
    }
    if (!planToken) {
      warnings.push('未配置 JUDGE_PLAN_TOKEN：若题库接口需要鉴权，查询会被拒（401）');
    }
  }
  if (planKind === 'cloud' && !planEnvId) {
    warnings.push('题库来源为 cloud 但未配置 JUDGE_CLOUD_ENV_ID：所有题目查询都会失败');
  }

  /* ------------------- 判题沙箱后端（外部依赖入口） ------------------- */

  const sandboxBackend = env('JUDGE_SANDBOX', 'docker').toLowerCase();
  if (sandboxBackend !== 'docker' && sandboxBackend !== 'local') {
    warnings.push(
      'JUDGE_SANDBOX=' + sandboxBackend + ' 不是已知取值（docker/local），已按 docker 处理'
    );
  } else if (sandboxBackend === 'local') {
    // ⚠️ 这条告警刻意写得最醒目：它是本项目唯一一处「功能能用但安全边界消失」的降级。
    //    不知道边界的降级，比明确的降级危险得多。
    warnings.push(
      '⚠️ 判题沙箱为【本地不设防模式】：用户代码会以你的身份在本机直接运行，' +
        '没有内存上限/进程数上限/网络隔离/只读文件系统。仅限独自开发与录题验证，' +
        '有第二个人能提交代码或小程序要连本机时，必须改回 JUDGE_SANDBOX=docker。'
    );
    if (isProd) {
      // 生产环境绝不允许无隔离跑陌生人代码。这个抛错是刻意的，不给「先上线再说」的机会。
      throw new Error(
        '[judge] 生产环境禁止 JUDGE_SANDBOX=local。' +
          '该模式没有任何隔离，等于把服务器交给任意提交代码的人。请使用 docker。'
      );
    }
  }

  const cacheBackend = env('JUDGE_RESULT_CACHE', 'auto').toLowerCase();
  if (['memory', 'redis', 'auto'].indexOf(cacheBackend) < 0) {
    warnings.push(
      'JUDGE_RESULT_CACHE=' + cacheBackend + ' 不是已知取值（auto/memory/redis），已按 auto 处理'
    );
  }
  // 幂等结果缓存跨实例共享的前提是 Redis。单实例内测时可以显式设 memory。
  if (cacheBackend === 'redis' && !redisUrl) {
    warnings.push(
      'JUDGE_RESULT_CACHE=redis 但未配置 JUDGE_REDIS_URL：结果缓存已退回单实例内存，' +
        '多实例部署下同一 submissionId 可能被判两次（幂等失效）'
    );
  }

  // 并发上限必须 ≥ 1，且不应该超过 CPU 数太多：判题是 CPU 密集的，
  // 超订只会让所有请求一起变慢，用户感知为「全都超时」。
  const cpuCount = os.cpus().length || 2;
  if (maxConcurrent > cpuCount * 4) {
    warnings.push(
      'JUDGE_MAX_CONCURRENT=' + maxConcurrent + ' 超过 CPU 数(' + cpuCount + ')的 4 倍，' +
        '判题是 CPU 密集任务，超订会让全部请求一起变慢'
    );
  }

  return {
    config: {
      port: envInt('JUDGE_PORT', 8600),
      host: env('JUDGE_HOST', '0.0.0.0'),
      token: effectiveToken,
      redisUrl: redisUrl,
      workspaceRoot: workspaceRoot,
      seccompProfile: env('JUDGE_SECCOMP_PROFILE', '/etc/judge/seccomp-judge.json'),
      perMinute: envInt('JUDGE_PER_MINUTE', RATE_LIMIT.perMinute),
      perDay: envInt('JUDGE_PER_DAY', RATE_LIMIT.perDay),
      cooldownMs: envInt('JUDGE_COOLDOWN_MS', RATE_LIMIT.cooldownMs),
      maxBodyBytes: maxBodyBytes,
      maxConcurrent: maxConcurrent,
      requestTimeoutMs: requestTimeoutMs,
      authWindowMs: envInt('JUDGE_AUTH_WINDOW_MS', AUTH_WINDOW_MS),
      nonceTtlMs: envInt('JUDGE_NONCE_TTL_MS', NONCE_TTL_MS),
      dryRun: env('JUDGE_DRY_RUN', '0') === '1',
      objectiveAnswerCacheTtlMs: envInt('JUDGE_ANSWER_CACHE_TTL_MS', 60 * 1000),
      planSource: {
        kind: planKind,
        baseUrl: planBaseUrl,
        envId: planEnvId,
        token: planToken,
        timeoutMs: envInt('JUDGE_PLAN_TIMEOUT_MS', 3000),
        cacheTtlMs: envInt('JUDGE_PLAN_CACHE_TTL_MS', 5 * 60 * 1000),
      },
      resultCacheBackend: cacheBackend,
      resultCacheTtlMs: envInt('JUDGE_RESULT_CACHE_TTL_MS', 24 * 60 * 60 * 1000),
      sandboxBackend: sandboxBackend === 'local' ? 'local' : 'docker',
    },
    warnings: warnings,
  };
}

export interface BuildOptions {
  config: JudgeConfig;
  /** 注入自定义执行器（自检用）。不传则按 dryRun 决定 */
  executor?: Executor;
  /** 注入自定义 Redis（自检用） */
  redis?: RedisClient;
  /**
   * 注入自定义题库提供者（自检用）。
   * 不传则按 config.planSource 造一个：memory 用内置样例题，http/cloud 走网络。
   */
  plans?: PlanProvider;
  /**
   * 注入客观题答案仓储（自检用）。
   * 不传则按 config.planSource 造一个：memory 用内置样例答案，http/cloud 走网络。
   */
  objectivePlans?: AnswerRepository;
  /** 注入自定义结果缓存（自检用）。不传则按 config 决定 memory 还是 Redis */
  resultCache?: ResultCache;
  logger?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * 装配出一套可用的判题服务。
 *
 * 注意这里**不启动 HTTP**，也不做 docker 探测——
 * 「能不能用」与「能不能提供 HTTP」是两件事。
 */
export function buildJudge(opts: BuildOptions): JudgeBundle {
  const config = opts.config;
  const log = opts.logger || defaultLogger;
  const warnings: string[] = [];

  /* ---------------------------- Redis ---------------------------- */

  let redis: RedisClient | null = null;

  if (config.redisUrl) {
    redis = opts.redis || new RedisClient({ url: config.redisUrl, onLog: function (m) { log('info', m); } });
  } else {
    warnings.push('未配置 Redis：限流与重放拦截都退化为单实例内存实现');
  }

  /* ---------------------------- 限流 ---------------------------- */

  let counter: RateCounter;
  let rateLimiterDegraded: boolean;

  if (redis) {
    const rc = new RedisRateCounter({
      redis: redis,
      onDegrade: function (info) {
        // fail-open 是决策，但**必须留痕**：静默失效等于没有限流
        log('warn', '[rate] Redis 不可用，本次放行（fail-open）：' + info.reason);
      },
      onRecover: function () {
        log('info', '[rate] Redis 已恢复，限流回到权威计数');
      },
    });
    counter = rc;
    rateLimiterDegraded = false;
    warnings.push('限流使用 Redis 权威计数；Redis 不可用时按 fail-open 放行并告警（阈值 ' + DEGRADE_ALERT_THRESHOLD + ' 次）');
  } else {
    counter = new MemoryRateCounter();
    rateLimiterDegraded = true;
    warnings.push('限流使用单实例内存计数（多实例下实际放行量 = 配置值 × 实例数）');
  }

  const limiter = new RateLimiter(counter, {
    perMinute: config.perMinute,
    perDay: config.perDay,
    cooldownMs: config.cooldownMs,
  });

  /* --------------------- nonce（重放拦截） --------------------- */

  const memoryNonce = new MemoryNonceStore();
  let nonceStore: NonceStore;
  if (redis) {
    const redisNonce = new RedisNonceStore(redis);
    nonceStore = new FailoverNonceStore(redisNonce, memoryNonce, function (reason) {
      // 重放拦截的降级方向与限流**相反**：这里宁可退回单实例内存，
      // 也不能什么都不做——放行重放是安全事件，不是成本事件。
      log('warn', '[nonce] 重放拦截降级到单实例内存实现：' + reason);
    });
  } else {
    nonceStore = memoryNonce;
  }

  /* ---------------------------- 判题 ---------------------------- */

  const executor = opts.executor || createExecutor(config, log);
  // seccomp profile 路径从配置注入。**不要再让 policy.ts 去猜路径**——
  // 早期写死常量导致 Dockerfile / compose / bootstrap 三处各说各话。
  const runner = new SandboxRunner(executor, { seccompProfile: config.seccompProfile });

  /* ---------------------------- 题库 ---------------------------- */
  //
  // 判题服务这里刻意**不**区分「谁的题库」：内存样例、HTTP 接口、
  // 云开发 HTTP 访问服务，最终都落在同一组接口上：
  //     PlanSource.fetchPlan() → PlanLookup → PlanRepository → PlanProvider
  // 云服务搭好之后，只有 PlanSource 的实现会变，判题主流程一行不动。
  let plans: PlanProvider;
  if (opts.plans) {
    plans = opts.plans;
  } else {
    const built = createPlanSource(config.planSource);
    for (let i = 0; i < built.warnings.length; i++) warnings.push(built.warnings[i]);

    // 内置样例题：直接灌进 source（保持「一条数据通路」——
    // 样例数据和线上数据都从 PlanSource 出来，避免两套写法）。
    if (built.source.name === 'memory') {
      const memSource = built.source as unknown as { add(plan: (typeof JUDGE_PLANS)[number]): void };
      for (let i = 0; i < JUDGE_PLANS.length; i++) memSource.add(JUDGE_PLANS[i]);
    } else {
      warnings.push('题库来源：' + built.source.name + '（测试点缓存 ' + config.planSource.cacheTtlMs + 'ms）');
    }

    plans = new PlanRepository({
      source: built.source,
      cacheTtlMs: config.planSource.cacheTtlMs,
      onFix: function (info) {
        // 规范化是「题库质量信号」：说明有人的题录得不规范，应该去看一眼
        log('warn', '[plans] 测试点已就地修复 ' + info.questionId + '/' + info.language + '：' + info.fixes.join('；'));
      },
      onError: function (info) {
        log('error', '[plans] 题库查询失败 ' + info.questionId + '/' + info.language + '：' + info.error);
      },
    });
  }

  /* ------------------------ 客观题答案库 ------------------------ */
  //
  // 与编程题的测试点分开两条通路，理由见 questions/answers.ts 的文件头：
  //   ① 数据形态不同（测试点是「输入→期望输出」的数组，答案是标量）
  //   ② 缓存 TTL 语义不同（测试点几乎不变；答案改一次就影响判分正确性）
  //   ③ 失败语义相同（都是「没有」vs「查不到」的三态纪律）
  let objectivePlans: AnswerRepository;
  if (opts.objectivePlans) {
    objectivePlans = opts.objectivePlans;
  } else {
    const builtAnswers = createAnswerSource(config.planSource);
    for (let i = 0; i < builtAnswers.warnings.length; i++) warnings.push(builtAnswers.warnings[i]);

    // 与 planSource 同理：内置样例直接灌进 source，保持「一条数据通路」
    if (builtAnswers.source.name === 'memory') {
      const memSource = builtAnswers.source as unknown as {
        add(a: (typeof OBJECTIVE_ANSWERS)[number]): void;
      };
      for (let i = 0; i < OBJECTIVE_ANSWERS.length; i++) memSource.add(OBJECTIVE_ANSWERS[i]);
    } else {
      warnings.push(
        '客观题答案来源：' + builtAnswers.source.name +
          '（答案缓存 ' + config.objectiveAnswerCacheTtlMs + 'ms）'
      );
    }

    objectivePlans = new AnswerRepository({
      source: builtAnswers.source,
      // ⚠️ 客观题答案的 TTL 明显短于测试点：运营改一次答案要立刻生效，
      //    否则那段时间内所有用户都在被判错的答案。
      cacheTtlMs: config.objectiveAnswerCacheTtlMs,
      onError: function (info) {
        log('error', '[answers] 题库查询失败 ' + info.questionId + '：' + info.error);
      },
    });
  }

  /* ---------------------------- 结果缓存 ---------------------------- */

  let resultCache: ResultCache;
  const wantRedisCache = config.resultCacheBackend === 'redis' || config.resultCacheBackend === 'auto';

  if (opts.resultCache) {
    resultCache = opts.resultCache;
  } else if (redis && wantRedisCache) {
    resultCache = new RedisResultCache({
      redis: redis,
      ttlMs: config.resultCacheTtlMs,
      onDegrade: function (info) {
        // 与限流同族：算力是可恢复成本，用户无感优先。
        // ⚠️ 与 nonce 重放拦截方向相反，见 redis/result-cache.ts 文件头。
        log('warn', '[cache] Redis 不可用，幂等缓存降级（fail-open，可能重跑）：' + info.reason);
      },
      onRecover: function () {
        log('info', '[cache] Redis 已恢复，结果缓存回到跨实例共享');
      },
    });
    warnings.push('结果缓存使用 Redis（保留 ' + Math.round(config.resultCacheTtlMs / 1000) + 's）');
  } else {
    resultCache = new MemoryResultCache();
    warnings.push('结果缓存使用单实例内存：多实例下次重提可能重跑判题（配 Redis 可解决）');
  }

  const service = new JudgeService({
    runner: runner,
    plans: plans,
    cache: resultCache,
    workspace: new LocalWorkspace(config.workspaceRoot, { localMode: config.sandboxBackend === 'local' }),
    files: defaultFileNames,
    limiter: limiter,
    // 只有 Redis 计数器需要预热；内存计数器不传，走「跳过」分支
    prefetchCounter: canPrefetch(counter) ? counter : undefined,
  });

  const bundle: JudgeBundle = {
    config: config,
    service: service,
    limiter: limiter,
    counter: counter,
    nullRateCounter: rateLimiterDegraded,
    rateLimiterDegraded: rateLimiterDegraded,
    nonceStore: nonceStore,
    redis: redis,
    plans: plans,
    objectivePlans: objectivePlans,
    resultCache: resultCache,
    warnings: warnings,
    shutdown: async function () {
      // 关闭顺序：先 nonce（可能持有 Redis 命令），再 Redis 连接
      try {
        if (nonceStore.close) await nonceStore.close();
      } catch (e) {
        log('warn', '[shutdown] 关闭 nonce 存储出错：' + String(e));
      }
      if (redis) {
        try {
          await redis.quit();
        } catch (e) {
          log('warn', '[shutdown] 关闭 Redis 出错：' + String(e));
        }
      }
    },
  };

  return bundle;
}

function defaultLogger(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = '[judge] ' + msg;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * 按配置造执行器。
 *
 * 抽成函数而不是内联三元，是为了让「本地模式会和哪些东西一起变」集中在一处：
 *   - docker：完整 12 项隔离，生产唯一选择
 *   - local ：**无隔离**，仅本机开发。工具链缺失时会明确报错并给出补救建议
 */
function createExecutor(config: JudgeConfig, log: (level: 'info' | 'warn' | 'error', msg: string) => void): Executor {
  if (config.sandboxBackend !== 'local') {
    return new DockerExecutor({ workspaceRoot: config.workspaceRoot });
  }

  // 本地模式下先把工具链探测一遍。**在这里报错比在用户提交时才发现好得多**：
  // 提交那一刻的失败会让人以为是「我的代码写错了」，而真实原因是「机器上没装 gcc」。
  const toolchain = probeLocalToolchain();
  if (!toolchain.gcc && !toolchain.python) {
    log(
      'warn',
      '本地沙箱模式已启用，但本机既没有 gcc/g++ 也没有 python3：' +
        '任何 C/C++/Python 提交都会失败。请装好工具链，或改用 JUDGE_SANDBOX=docker。'
    );
  } else {
    const have: string[] = [];
    if (toolchain.gcc) have.push('gcc/g++');
    if (toolchain.python) have.push('python3');
    log('warn', '本地沙箱可用工具链：' + have.join('、') + '。缺失的语言提交会明确报错。');
  }
  log('warn', LOCAL_MODE_WARNING);

  return new LocalExecutor({ workspaceRoot: config.workspaceRoot });
}

/** 供自检断言：默认配置下的资源上限必须与服务端硬上限一致 */
export const BOOTSTRAP_LIMITS = DEFAULT_LIMITS;
