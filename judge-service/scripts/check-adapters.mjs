/**
 * 判题服务 · 外部依赖入口体检
 *
 * 用途：在真正搭建云服务（题库、Redis、云开发）之前和之后，各跑一次。
 *
 *   搭建前 → 看清楚「现在跑在什么默认值上」「哪些依赖还没接」，避免误以为已经在用云服务
 *   搭建后 → 确认配置真的生效（读了配置但没传下去，是本地测不出来的那类 bug）
 *
 * 它不做任何网络请求，也不起容器 —— 只做「配置 → 装配」这一步，
 * 然后把每一项依赖的当前实现、缺口、以及**该填哪个环境变量**列出来。
 *
 * 运行：node judge-service/scripts/check-adapters.mjs
 */

import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

register(pathToFileURL(path.join(ROOT, 'tests/ts-resolver.mjs')).href, import.meta.url);

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** 不真跑容器的执行器：这个体检只关心装配，不关心执行 */
const NOOP_EXECUTOR = {
  exec: async function () {
    return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 0, peakMemoryKB: 0, wallTimeout: false };
  },
};

/**
 * 每一项外部依赖的描述。
 *
 * `env` 是「搭建时要填的环境变量」——这是这份体检报告最有用的部分：
 * 搭云服务的人不用去翻代码找配置项名。
 */
export const ADAPTER_TABLE = [
  {
    key: 'plans',
    label: '题库（测试点来源）',
    env: ['JUDGE_PLAN_SOURCE', 'JUDGE_PLAN_BASE_URL', 'JUDGE_CLOUD_ENV_ID', 'JUDGE_PLAN_TOKEN'],
    why: '判题必须知道每道题的测试点。现在默认用内置样例题，只能判演示题。',
  },
  {
    key: 'resultCache',
    label: '结果缓存（幂等）',
    env: ['JUDGE_RESULT_CACHE', 'JUDGE_REDIS_URL', 'JUDGE_RESULT_CACHE_TTL_MS'],
    why: '同一份提交只该判一次。多实例部署必须有 Redis，否则可能判两次或结果不一致。',
  },
  {
    key: 'counter',
    label: '限流计数',
    env: ['JUDGE_REDIS_URL', 'JUDGE_PER_MINUTE', 'JUDGE_PER_DAY', 'JUDGE_COOLDOWN_MS'],
    why: '多实例内存计数会让实际放行量 = 配置值 × 实例数，等于没限流。',
  },
  {
    key: 'nonceStore',
    label: '重放拦截',
    env: ['JUDGE_REDIS_URL', 'JUDGE_NONCE_TTL_MS', 'JUDGE_AUTH_WINDOW_MS'],
    why: '单实例内存实现拦截不到跨实例重放。这一项与限流的降级方向相反，必须是 Redis。',
  },
  {
    key: 'executor',
    label: '沙箱执行器',
    env: ['JUDGE_SECCOMP_PROFILE', 'JUDGE_WORKSPACE_ROOT'],
    why: '判题必须真跑代码。需要宿主机装 docker 并构建沙箱镜像。',
  },
];

/** 判断某项依赖「是不是还没接上」 */
export function classify(entry, bundle, config) {
  switch (entry.key) {
    case 'plans':
      if (config.planSource.kind === 'memory') return 'default';
      return bundle.plans && bundle.plans.constructor.name === 'PlanRepository' ? 'wired' : 'broken';
    case 'resultCache':
      return bundle.resultCache && bundle.resultCache.constructor.name === 'RedisResultCache' ? 'wired' : 'default';
    case 'counter':
      return bundle.rateLimiterDegraded ? 'default' : 'wired';
    case 'nonceStore':
      return bundle.nonceStore && bundle.nonceStore.constructor.name === 'MemoryNonceStore' ? 'default' : 'wired';
    case 'executor':
      return config.dryRun ? 'default' : 'wired';
    default:
      return 'unknown';
  }
}

export function describe(bundle, config) {
  return {
    plans: config.planSource.kind === 'memory' ? '内置样例题' : '题库来源 ' + config.planSource.kind,
    resultCache: bundle.resultCache ? bundle.resultCache.constructor.name : '(无)',
    counter: bundle.rateLimiterDegraded ? '单实例内存' : 'Redis',
    nonceStore: bundle.nonceStore ? bundle.nonceStore.constructor.name : '(无)',
    executor: config.dryRun ? '不执行容器（dry-run）' : 'Docker',
  };
}

async function main() {
  const boot = await import(pathToFileURL(path.join(ROOT, 'judge-service/src/bootstrap.ts')).href);

  const loaded = boot.loadConfig();
  const bundle = boot.buildJudge({
    config: loaded.config,
    executor: NOOP_EXECUTOR,
    logger: function () {},
  });
  const config = bundle.config;
  const impl = describe(bundle, config);

  console.log('判题服务 · 外部依赖入口体检');
  console.log('='.repeat(64));
  console.log('');

  let pending = 0;
  for (let i = 0; i < ADAPTER_TABLE.length; i++) {
    const e = ADAPTER_TABLE[i];
    const state = classify(e, bundle, config);
    if (state === 'default') pending++;
    const mark = state === 'wired' ? '已接入' : state === 'default' ? '用默认值' : '异常';
    console.log(mark + '  ' + e.label + '  →  ' + (impl[e.key] || '?'));
    if (state !== 'wired') {
      console.log('      ' + e.why);
      console.log('      搭建时要填：' + e.env.join(', '));
    }
    console.log('');
  }

  console.log('-'.repeat(64));
  console.log('启动告警（这些是运行时会打进日志的内容）：');
  if (loaded.warnings.length === 0) {
    console.log('  （无）');
  } else {
    for (let i = 0; i < loaded.warnings.length; i++) console.log('  · ' + loaded.warnings[i]);
  }

  console.log('');
  console.log('-'.repeat(64));
  console.log('结论：还有 ' + pending + ' 项外部依赖在用默认值（本地开发可以，上线前必须接齐）。');
  console.log('本命令不发网络请求、不起容器，可以随时安全重跑。');

  await bundle.shutdown();
}

if (IS_MAIN) {
  main().catch(function (e) {
    console.error('体检失败：' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}
