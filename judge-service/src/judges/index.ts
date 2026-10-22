/**
 * 判题服务 · 主流程编排
 *
 * 一次提交的完整生命周期：
 *   precheck → 限流 → 建工作区 → 写源码 → 编译 → (编译不过即返回 CE)
 *   → 逐个测试点运行 → 分类 → 比对 → 汇总 → 清理
 *
 * 三条不能破的纪律：
 *   1. **编译不过就不跑**。共用容器时最容易犯的错就是跑出上一次的残留产物。
 *   2. **无论如何都清理临时目录**（try/finally）。判题服务被撑爆磁盘是最常见的线上事故。
 *   3. **结果幂等**：同一 submissionId 必须返回同一结果，且是服务端缓存，不是重跑。
 */

import {
  clampLimits,
  precheck,
  toJudgeResult,
  type JudgeCaseResult,
  type JudgeErrorCode,
  type JudgeRequest,
  type JudgeResponse,
  type JudgeResultLike,
  type JudgeVerdict,
} from '../contract';
import { aggregateVerdict, classify } from './classify';
import { buildPreviews, compareOutput, validatePlan, type JudgePlan } from '../questions/testcases';
import { ARTIFACT_HANDOFF, needsArtifactMount } from '../sandbox/policy';
import { artifactDirFor, type SandboxRunner } from '../sandbox/runner';
import type { PlanProvider, ResultCache, WorkspacePort, FileNamePort, Prefetchable } from './types-internal';
import { RateLimiter } from '../sandbox/ratelimit';

export interface JudgeServiceDeps {
  runner: SandboxRunner;
  plans: PlanProvider;
  cache: ResultCache;
  workspace: WorkspacePort;
  files: FileNamePort;
  limiter: RateLimiter;
  /**
   * 可选：限流计数预热（Redis 计数器用）。
   * 不传则跳过 —— 内存计数器不需要预热。
   */
  prefetchCounter?: Prefetchable;
  /** 返回当前毫秒时间戳，测试可注入固定时钟 */
  now?: () => number;
}

export interface JudgeOutcome {
  ok: boolean;
  response?: JudgeResponse;
  result?: JudgeResultLike;
  error?: { code: JudgeErrorCode; message: string; retryAfterMs?: number };
}

/**
 * 汇总阶段用的草稿。
 * 用显式类型而不是 Omit<JudgeResponse>，是因为汇总时有 finishedAt 尚不存在、
 * 但 startedAt 需要保留的中间态；用 Omit 会逼着调用方伪造字段。
 */
interface JudgeResponseDraft {
  verdict: JudgeVerdict;
  score: number;
  passed: number;
  total: number;
  compileMessage?: string;
  cases: JudgeCaseResult[];
  totalMs: number;
  startedAt: number;
  now: number;
  cacheHit: boolean;
}

/** 工作区路径解析：编译产物在容器内 /tmp，宿主侧需要中转目录 */
function artifactStagingPath(hostWorkDir: string, artifactName: string): string {
  return hostWorkDir + '/' + artifactName;
}

export class JudgeService {
  private deps: JudgeServiceDeps;

  constructor(deps: JudgeServiceDeps) {
    this.deps = deps;
  }

  async submit(userId: string, req: JudgeRequest): Promise<JudgeOutcome> {
    const now = this.deps.now || function () { return Date.now(); };

    // ① 静态预检：明显非法的请求不发到沙箱，省一次容器启动
    const pre = precheck(req);
    if (!pre.ok) {
      return { ok: false, error: { code: pre.code || 'internal', message: pre.message || '请求不合法' } };
    }

    // ② 幂等：同一 submissionId 直接回缓存结果，不重跑
    const cached = await this.deps.cache.get(req.submissionId);
    if (cached) {
      return {
        ok: true,
        response: cached,
        result: toJudgeResult(cached, req.limits),
      };
    }

    // ③ 限流（先检查后计数）
    //
    // 计数器的 incr/get/ttl 是同步的，但 Redis 是异步的 —— 这里在判定之前
    // 先把权威读数拉回本地（`prefetch`）。不拉的话，多实例部署下每个实例
    // 都只看到自己的计数，实际放行量 = 配置值 × 实例数。
    // 内存实现没有 prefetch，跳过即可（它本来就是权威的）。
    if (this.deps.prefetchCounter) {
      try {
        await this.deps.prefetchCounter.prefetch(userId, now());
      } catch (e) {
        // prefetch 失败不能让判题挂掉：限流器会退回本地兜底计数
        console.warn('[judge] 限流计数预热失败', e);
      }
    }

    const decision = this.deps.limiter.check(userId, now());
    if (!decision.allowed) {
      return {
        ok: false,
        error: {
          code: decision.code || 'rate-limited',
          message: decision.message || '提交过于频繁',
          retryAfterMs: decision.retryAfterMs,
        },
      };
    }

    // ④ 取判题计划（测试点永不下发客户端，只在这里使用）
    //
    // ⚠️ 这里必须把「题库说没有这道题」和「题库查不到」分成两件事：
    //    前者是 404（用户去反馈「这题是不是下架了」），
    //    后者是 5xx（用户该稍后重试）。
    //    PlanRepository 用「返回 undefined」与「抛错」表达这个区别 —— 见 providers.ts。
    //    把两者混成一个 undefined，是这类服务最常见、也最浪费用户时间的一处偷懒。
    let plan: JudgePlan | undefined;
    try {
      plan = await this.deps.plans.getPlan(req.questionId, req.language);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[judge] 题库查询失败', req.questionId, req.language, message);
      return {
        ok: false,
        error: { code: 'internal', message: '题库暂时不可用，请稍后重试' },
      };
    }
    if (!plan) {
      return { ok: false, error: { code: 'question-not-found', message: '题目不存在或未配置判题计划' } };
    }
    const validation = validatePlan(plan);
    if (!validation.ok) {
      // 配置错误属于设施问题：返回 system-error，并记日志，不要让用户背锅
      console.error('[judge] 判题计划不合法', req.questionId, validation.errors);
      return { ok: false, error: { code: 'internal', message: '题目判题配置异常，已通知运营' } };
    }

    const limits = clampLimits({
      // 题目级配额优先，请求只能收紧
      compileMs: plan.judgeMs,
      runMs: plan.judgeMs,
      memoryMB: plan.memoryMB,
      outputBytes: req.limits && req.limits.outputBytes,
      maxProcs: req.limits && req.limits.maxProcs,
    });

    const startedAt = now();
    let hostWorkDir = '';

    try {
      // ⑤ 独立工作区（每次提交一个目录，容器销毁即清）
      hostWorkDir = await this.deps.workspace.prepare(req.submissionId);
      const fileName = this.deps.files.fileNameFor(req.language);
      await this.deps.workspace.writeSource(hostWorkDir, fileName, req.code);

      // ⑥ 编译（独立容器）
      const compileOut = await this.deps.runner.compile({
        name: sanitize(req.submissionId),
        hostWorkDir: hostWorkDir,
        language: req.language,
        limits: limits,
      });

      if (!compileOut.ok) {
        return this.finish(req, {
          verdict: 'compile-error',
          score: 0,
          passed: 0,
          total: plan.cases.length,
          compileMessage: compileOut.message,
          cases: [],
          totalMs: now() - startedAt,
          startedAt: startedAt,
          now: now(),
          cacheHit: false,
        } satisfies JudgeResponseDraft, limits);
      }

      // 编译产物经宿主中转，运行容器里没有编译器。
      // 容器名由 runner 从计划里取回后显式传递——见 WorkspacePort.collectArtifact 的注释。
      //
      // ⚠️ 产物落在 **workDir 的同级** `.artifacts` 目录，不是 workDir 里：
      //    workDir 以只读方式挂进容器，而产物需要「可执行」；
      //    如果产物放 workDir，就必须把整个 workDir 挂成可执行 —— 没必要扩大范围。
      //
      // ⚠️ **只有编译型语言才需要收产物**。
      //    Python 这类解释型语言「编译」只是语法检查（py_compile），
      //    不产生可执行文件，运行阶段直接执行 /box 下的源码。
      //    早期版本无条件调用 collectArtifact，结果是：
      //      - docker 模式：docker cp 去拷一个不存在的文件 → 报错
      //      - local  模式：明确报「编译产物未生成」
      //    两者都表现为「Python 题的判题服务坏了」，而题目和代码都没问题。
      //    判据必须与 policy.ts 里决定「要不要挂产物」的那个判断**同源**，
      //    否则两处会漂移（挂载说不需要、收集说需要）。
      let artifactDir: string | undefined;
      if (needsArtifactMount(req.language)) {
        artifactDir = artifactDirFor(hostWorkDir, ARTIFACT_HANDOFF.hostStagingDirSuffix);
        await this.deps.workspace.mkdirp(artifactDir);
        await this.deps.workspace.collectArtifact(
          artifactDir,
          this.deps.files.artifactNameFor(req.language),
          compileOut.containerName
        );
      }

      // ⑦ 逐测试点运行（每个测试点一个全新的运行容器）
      const cases: JudgeCaseResult[] = [];
      let passed = 0;

      for (let i = 0; i < plan.cases.length; i++) {
        const tc = plan.cases[i];
        const caseLimits = clampLimits({
          compileMs: limits.compileMs,
          runMs: tc.runMs || limits.runMs,
          memoryMB: tc.memoryMB || limits.memoryMB,
          outputBytes: limits.outputBytes,
          maxProcs: limits.maxProcs,
        });

        const runOut = await this.deps.runner.run({
          name: sanitize(req.submissionId) + '-c' + tc.index,
          hostWorkDir: hostWorkDir,
          language: req.language,
          limits: caseLimits,
          argv: this.deps.files.runArgvFor(req.language),
          hostArtifactDir: artifactDir,
          // ⚠️ 必须传测试点输入。漏了它，任何需要读输入的程序都会卡住 →
          //    超时 → 判成 TLE，而学生会去优化算法复杂度，方向完全错。
          //    这正是「用假执行器测不出来、只有真跑才暴露」的典型 ——
          //    自检里的假执行器不读 stdin，所以永远不会发现漏传。
          stdin: tc.stdin,
        });

        // 比对必须基于未截断的输出来判「超限」，所以先算 truncated，再比内容
        const matched =
          !runOut.outputTruncated &&
          compareOutput(runOut.stdout, tc.expected, plan.compare || 'exact-lines');

        const classified = classify(
          {
            compiled: true,
            exitCode: runOut.exitCode,
            signal: null,
            stdout: runOut.stdout,
            stderr: runOut.stderr,
            wallMs: runOut.wallMs,
            peakMemoryKB: runOut.peakMemoryKB,
            timedOut: runOut.timedOut,
            outputTruncated: runOut.outputTruncated,
            expected: tc.expected,
            outputMatched: matched,
          },
          caseLimits
        );

        if (classified.verdict === 'accepted') passed++;

        const previews = buildPreviews(tc, runOut.stdout, classified.verdict === 'accepted');
        cases.push({
          index: tc.index,
          verdict: classified.verdict,
          hidden: !!tc.hidden,
          costMs: runOut.wallMs,
          memoryKB: runOut.peakMemoryKB,
          stdinPreview: previews.stdinPreview,
          expectedPreview: previews.expectedPreview,
          actualPreview: previews.actualPreview,
          message: buildCaseMessage(classified.verdict, runOut.stderr),
        });

        // 设施错误（system-error）之后继续跑只是浪费算力，且大概率还会错 → 提前结束。
        // 用户代码的错误（WA/TLE/RE）则继续跑完：让用户看到「通过 3/5」比只看到「第 1 个点错」有用得多。
        if (classified.verdict === 'system-error') break;
      }

      const verdict = aggregateVerdict(cases);
      const score = plan.cases.length === 0 ? 0 : passed / plan.cases.length;

      return this.finish(req, {
        verdict: verdict,
        score: score,
        passed: passed,
        total: plan.cases.length,
        cases: cases,
        totalMs: now() - startedAt,
        startedAt: startedAt,
        now: now(),
        cacheHit: false,
      } satisfies JudgeResponseDraft, limits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[judge] 判题流程异常', req.submissionId, err);
      return {
        ok: false,
        error: { code: 'internal', message: '判题服务内部错误：' + message },
      };
    } finally {
      // ⑧ 无论如何都清理。临时目录泄漏比判题慢严重得多。
      if (hostWorkDir) {
        try {
          await this.deps.workspace.cleanup(hostWorkDir);
        } catch (e) {
          console.error('[judge] 清理失败', hostWorkDir, e);
        }
      }
    }
  }

  private async finish(
    req: JudgeRequest,
    partial: JudgeResponseDraft,
    limits: ReturnType<typeof clampLimits>
  ): Promise<JudgeOutcome> {
    const response: JudgeResponse = {
      submissionId: req.submissionId,
      verdict: partial.verdict,
      score: partial.score,
      passed: partial.passed,
      total: partial.total,
      compileMessage: partial.compileMessage,
      cases: partial.cases,
      totalMs: partial.totalMs,
      finishedAt: partial.now,
      cacheHit: false,
    };

    // 结果缓存：错误结果也缓存（同一份错误代码重提应该得到同一结论，不该再烧一次算力）
    await this.deps.cache.set(req.submissionId, response);

    const result: JudgeResultLike = toJudgeResult(response, limits);
    // CE 时把编译器信息挂到 detail 里，用户才知道哪一行错
    if (response.verdict === 'compile-error' && response.compileMessage) {
      result.detail = '编译未通过\n' + response.compileMessage;
    }
    return { ok: true, response: response, result: result };
  }
}

function buildCaseMessage(verdict: JudgeVerdict, stderr: string): string | undefined {
  if (verdict === 'accepted' || verdict === 'wrong-answer') return undefined;
  if (!stderr) return undefined;
  const first = stderr.split('\n')[0];
  return first.length > 200 ? first.slice(0, 200) + '…' : first;
}

function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'sub';
}
