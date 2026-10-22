/**
 * 判题沙箱 · 以「可注入执行器」的方式驱动容器
 *
 * 为什么要做依赖注入而不是直接调 docker：
 *   沙箱逻辑里最值钱的部分是「计划生成 + 结果分类」，
 *   而这两块完全不需要真的跑到 docker 才能验证。
 *   把 docker 调用抽成接口后，测试可以注入假执行器，
 *   在不装 docker 的机器上验证：超时是否判 TLE、内存是否判 MLE、
 *   输出超限是否判 OLE、编译失败是否判 CE 并且**不进入运行阶段**。
 *
 * 真机实现见 docker-executor.ts（同一接口）。
 */

import type { JudgeLanguage } from '../contract';
import {
  ARTIFACT_HANDOFF,
  DEFAULT_SECCOMP_PROFILE,
  buildSandboxPlan,
  languageSpec,
  needsArtifactMount,
  type BuildOptions,
  type SandboxPlan,
} from './policy';

/** 一次容器执行的原始结果 */
export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** 宿主视角的墙钟耗时 */
  wallMs: number;
  /** docker inspect 取到的峰值内存（KB）；取不到为 0 */
  peakMemoryKB: number;
  /** 是否因为墙钟超时被服务端 kill */
  wallTimeout: boolean;
  /** 执行器自身的错误（例如 docker 不存在） */
  execError?: string;
}

export interface Executor {
  /** 执行一个容器计划 */
  exec(plan: SandboxPlan, timeoutMs: number): Promise<ExecResult>;
}

/**
 * 沙箱的部署环境配置（构造期注入，不随每次提交变化）。
 */
export interface SandboxRunConfig {
  /** seccomp profile 在**宿主机**上的绝对路径 */
  seccompProfile?: string;
  /** 产物中转目录后缀（挂在 workDir 同级，默认 `.artifacts`） */
  artifactDirSuffix?: string;
}

/** 按 workDir 推导产物中转目录的宿主路径。目录名带后缀，与 workDir 平级。 */
export function artifactDirFor(hostWorkDir: string, suffix: string): string {
  return hostWorkDir.replace(/[\\/]+$/, '') + suffix;
}

export interface CompileOutcome {
  ok: boolean;
  /** 编译器 stderr（截断后），CE 时给用户看 */
  message: string;
  wallMs: number;
  plan: SandboxPlan;
  /**
   * 本次编译容器的名字。
   * 编排层需要它来执行 `docker cp <name>:<产物> <宿主>`——
   * 「编译与运行分容器」的产物中转必须知道去哪个容器拿东西。
   */
  containerName: string;
}

export interface RunOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wallMs: number;
  peakMemoryKB: number;
  timedOut: boolean;
  outputTruncated: boolean;
  plan: SandboxPlan;
  /** 本次运行容器的名字。目前用于日志与将来按容器名 inspect 峰值内存 */
  containerName: string;
}

/** 从计划里取容器名。计划由本模块生成，`--name` 必然存在 */
export function containerNameOf(plan: SandboxPlan): string {
  const idx = plan.args.indexOf('--name');
  return idx >= 0 ? plan.args[idx + 1] : '';
}

/** 输出截断标记：wrapperCommand 在超限时会带上它 */
export const TRUNCATE_MARK = '---STDERR---';

export class SandboxRunner {
  private executor: Executor;
  /**
   * 沙箱编排的静态配置。
   *
   * 为什么这些不进 BuildOptions：它们是**部署环境属性**（profile 装在哪、
   * 产物中转目录叫什么），与「这一次提交怎么跑」无关。
   * 放在构造期注入，避免每次 exec 都要调用方记着传。
   */
  private sandbox: SandboxRunConfig;

  constructor(executor: Executor, sandbox?: SandboxRunConfig) {
    this.executor = executor;
    this.sandbox = {
      seccompProfile: (sandbox && sandbox.seccompProfile) || DEFAULT_SECCOMP_PROFILE,
      artifactDirSuffix: (sandbox && sandbox.artifactDirSuffix) || ARTIFACT_HANDOFF.hostStagingDirSuffix,
    };
  }

  buildPlan(opts: BuildOptions): SandboxPlan {
    return buildSandboxPlan(opts);
  }

  /**
   * ① 编译阶段。
   * 关键行为：**编译失败必须立刻返回，绝不进入运行阶段**。
   * 共用容器时最容易犯的错误就是「编译失败还去跑产物」，那会跑出上一次的残留二进制。
   */
  async compile(opts: {
    name: string;
    hostWorkDir: string;
    language: JudgeLanguage;
    limits?: BuildOptions['limits'];
  }): Promise<CompileOutcome> {
    const plan = this.buildPlan({
      name: opts.name + '-compile',
      hostWorkDir: opts.hostWorkDir,
      language: opts.language,
      limits: opts.limits,
      phase: 'compile',
      seccompProfile: this.sandbox.seccompProfile,
    });

    const res = await this.executor.exec(plan, plan.effective.wallMs + 2000);
    const containerName = containerNameOf(plan);

    if (res.execError) {
      return { ok: false, message: '执行器不可用：' + res.execError, wallMs: res.wallMs, plan: plan, containerName: containerName };
    }

    if (res.wallTimeout) {
      return {
        ok: false,
        message: '编译超时（限 ' + plan.effective.wallMs + ' 毫秒），已终止',
        wallMs: res.wallMs,
        plan: plan,
        containerName: containerName,
      };
    }

    const stderr = splitStreams(res.stderr).stderr;
    const ok = res.exitCode === 0;
    return {
      ok: ok,
      message: ok ? '' : truncate(stderr || '编译器未输出信息（退出码 ' + String(res.exitCode) + '）', 4096),
      wallMs: res.wallMs,
      plan: plan,
      containerName: containerName,
    };
  }

  /**
   * ② 运行阶段（单个测试点）。
   * 注意：这里吃的是**编译产物的宿主路径**，不是容器路径——产物已经过宿主中转，
   *      运行容器里没有编译器。
   */
  async run(opts: {
    name: string;
    hostWorkDir: string;
    language: JudgeLanguage;
    limits?: BuildOptions['limits'];
    argv?: string[];
    /**
     * 产物中介目录的宿主路径（编译产物已被 docker cp 到这里）。
     * 编译型语言不传会让容器里找不到产物而失败——刻意 fail-loud。
     * 解释型语言（python）不需要，传了也不挂载。
     */
    hostArtifactDir?: string;
    /**
     * 该测试点的输入（stdin）。
     *
     * ⚠️ 必须传。漏传 = 程序卡在等输入 = 超时 = 判成 TLE，
     *    而学生会去优化算法复杂度，方向完全错。
     *    空输入也要显式传空串 —— 缺失和空是两回事，这里刻意不做默认值。
     */
    stdin?: string;
  }): Promise<RunOutcome> {
    // 只有编译型语言才挂产物；解释型直接执行 /box 下的源码
    const mountArtifact = needsArtifactMount(opts.language);
    const plan = this.buildPlan({
      name: opts.name + '-run',
      hostWorkDir: opts.hostWorkDir,
      language: opts.language,
      limits: opts.limits,
      phase: 'run',
      argv: opts.argv || languageSpec(opts.language).run,
      seccompProfile: this.sandbox.seccompProfile,
      hostArtifactDir: mountArtifact ? opts.hostArtifactDir : undefined,
      stdin: opts.stdin === undefined ? '' : opts.stdin,
    });

    const res = await this.executor.exec(plan, plan.effective.wallMs + 1500);
    const streams = splitStreams(res.stderr);

    return {
      exitCode: res.exitCode,
      stdout: clipBytes(res.stdout, plan.effective.outputBytes),
      stderr: clipBytes(streams.stderr, plan.effective.outputBytes),
      wallMs: res.wallMs,
      peakMemoryKB: res.peakMemoryKB,
      timedOut: res.wallTimeout,
      outputTruncated: res.stdout.length > plan.effective.outputBytes || streams.stderr.length > plan.effective.outputBytes,
      plan: plan,
      containerName: containerNameOf(plan),
    };
  }
}

/**
 * 拆开 wrapperCommand 合流后的输出。
 * 为什么不直接分开取：docker 只有一条 stdout 通道能可靠拿到（我们没开 tty），
 * 所以包装脚本里用 `---STDERR---` 作分隔符，在宿主侧拆。
 */
export function splitStreams(raw: string): { stdout: string; stderr: string } {
  const idx = raw.indexOf(TRUNCATE_MARK);
  if (idx < 0) return { stdout: raw, stderr: '' };
  return {
    stdout: raw.slice(0, idx).replace(/\n$/, ''),
    stderr: raw.slice(idx + TRUNCATE_MARK.length).replace(/^\n/, ''),
  };
}

function clipBytes(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit);
}

function truncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '\n…（编译器信息已截断）';
}
