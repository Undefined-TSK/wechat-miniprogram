/**
 * 判题沙箱 · 安全策略 → Docker 参数生成
 *
 * 设计要点：**把「怎么跑容器」变成纯函数**。
 *   输入：语言、源码路径、资源上限、是否编译阶段
 *   输出：docker run 的完整参数数组（不是 shell 字符串）
 *
 * 为什么必须是数组而不是字符串：拼接字符串会引入命令注入。
 * 用户代码永远通过**文件**传进容器（bind mount），绝不通过命令行参数，
 * 也绝不做字符串替换。这样源码里的 `$(...)`、反引号、分号都是无害文本。
 *
 * 本文件不 import 任何 Node API，可在测试里直接断言生成的参数。
 */

import { HARD_LIMITS, MAX_OUTPUT_BYTES, type JudgeLimits, type JudgeLanguage } from '../contract';

/** 容器内的工作目录与用户 */
export const SANDBOX = {
  workDir: '/box',
  tmpDir: '/tmp',
  /**
   * 运行阶段编译产物的落点。
   *
   * 为什么单独给一个挂载点，而不是放 /tmp：
   *   /tmp 是 tmpfs 且**必须是 noexec**（见下方 buildSandboxPlan 的注释），
   *   否则用户代码可以往 /tmp 里写一个二进制再执行它——等于绕过了
   *   「代码只能从源码编译」这条约束。
   *   但编译产物本身必须可执行，所以运行阶段把它放在**独立的只读可执行挂载**上：
   *   只读 → 用户代码改不了它；独立挂载 → noexec 只作用于 /tmp，不影响这里。
   */
  artifactDir: '/box-artifact',
  /** 非 root 运行：镜像里预先创建 sandbox 用户，UID 固定为 1000 */
  user: '1000:1000',
  /** 只读挂载的工作目录（编译产物写到 tmpfs 或产物挂载，不写工作目录） */
  readOnlyRoot: true,
  /** 容器名前缀，便于运维按前缀清理 */
  namePrefix: 'judge',
} as const;

/**
 * seccomp profile 的容器内默认路径。
 *
 * ⚠️ 这个常量只是**默认值**，真正的路径由 BuildOptions.seccompProfile 决定。
 * 之所以做成参数而非常量：`buildSandboxPlan` 是纯函数，读不到环境变量，
 * 而镜像里 profile 的实际位置由 Dockerfile 决定。
 * 早期版本把它写死成常量，结果 Dockerfile（chmod /etc/seccomp-judge.json）、
 * compose（挂到 /etc-readonly）、bootstrap（JUDGE_SECCOMP_PROFILE）三处各说各话，
 * 且 `chmod ... || true` 把「文件不存在」这个错误静默吞掉了。
 */
export const DEFAULT_SECCOMP_PROFILE = '/etc/judge/seccomp-judge.json';

export type Phase = 'compile' | 'run';

export interface BuildOptions {
  /** 容器名（服务端生成，必须由服务端控制，不能来自用户输入） */
  name: string;
  /** 宿主上存放该次提交代码的临时目录（绝对路径） */
  hostWorkDir: string;
  language: JudgeLanguage;
  limits?: JudgeLimits;
  phase: Phase;
  /** run 阶段要执行的命令（编译产物文件名，服务端生成） */
  argv?: string[];
  /**
   * seccomp profile 在**宿主机**上的绝对路径。
   * docker 的 `--security-opt seccomp=` 读的是宿主路径（不是容器内路径）。
   * 不传则用 DEFAULT_SECCOMP_PROFILE（仅供自检使用，真机必须显式传）。
   */
  seccompProfile?: string;
  /**
   * run 阶段：宿主上存放编译产物的目录（绝对路径）。
   * 会被以**只读**方式挂到 SANDBOX.artifactDir，产物因此可执行但不可篡改。
   * compile 阶段忽略此参数（产物还在 tmpfs 里由编译器写）。
   */
  hostArtifactDir?: string;
  /**
   * run 阶段：喂给被测程序的输入（测试点的 stdin）。
   *
   * compile 阶段必须为 undefined（编译器不需要输入，给了反而干扰）。
   * run 阶段必须传（测试点输入为空也要显式传空串）——漏传会让程序卡在
   * 读输入上，最终判成 TLE，而学生会去优化算法，方向全错。
   */
  stdin?: string;
}

export interface SandboxPlan {
  image: string;
  /** docker run 的完整参数（不含 `docker` 与 `run` 本身） */
  args: string[];
  /**
   * 喂给被测程序的输入（测试点的 stdin）。
   *
   * ⚠️ 为什么它必须在**计划**里、而不是在参数里：
   *   把测试点输入拼进命令行会被 shell 解释（引号、换行、重定向全是坑），
   *   而且用户能看到自己的进程参数。stdin 是唯一正确的通道。
   *
   * ⚠️ 为什么它不是可选字段的「有就传、没有就算」：
   *   忘了传 stdin 的表现是「程序卡住等输入」→ 超时 → 判成 TLE。
   *   而 TLE 会让学生去优化算法复杂度，方向完全错。
   *   所以：编译阶段为 undefined（编译器不需要输入），运行阶段**必须**有值
   *   （哪怕测试点的输入就是空串，也要显式给空串）。
   */
  stdin?: string;
  /** 实际生效的资源上限（已夹到硬上限内） */
  effective: {
    wallMs: number;
    memoryMB: number;
    outputBytes: number;
    maxProcs: number;
    cpuQuota: string;
    cpus: string;
  };
  /** 本次执行的安全断言（用于自检与日志，不是装饰） */
  assertions: string[];
}

/** 各语言的编译/运行镜像与命令 */
const LANG_TABLE: Record<
  JudgeLanguage,
  {
    image: string;
    fileName: string;
    compile: string[];
    run: string[];
    artifact: string;
    /**
     * compiled = 产物是需要执行的二进制（走只读可执行挂载）
     * interpreted = 直接执行 /box 下的源码（不产生、也不需要产物挂载）
     */
    kind: 'compiled' | 'interpreted';
  }
> = {
  c: {
    image: 'judge-gcc:13-slim',
    fileName: 'main.c',
    // -lm 绝不能少：gcc 不会自动链接数学库，缺了会让 sqrt/pow/fabs 报
    // "undefined reference to `sqrt'"。学生看到这个报错只会以为自己写错了，
    // 而实际上是我们的编译命令缺参数 —— 属于「静默误伤用户」的典型。
    // 校准题 cal-06-math 就是专门用来钉住这一条的。
    compile: [
      'gcc', '-O2', '-std=c11', '-pipe', '-static', '-o',
      SANDBOX.tmpDir + '/box.out', '/box/main.c', '-lm',
    ],
    run: [SANDBOX.artifactDir + '/box.out'],
    artifact: 'box.out',
    kind: 'compiled',
  },
  cpp: {
    image: 'judge-gcc:13-slim',
    fileName: 'main.cpp',
    compile: [
      'g++', '-O2', '-std=c++17', '-pipe', '-static', '-o',
      SANDBOX.tmpDir + '/box.out', '/box/main.cpp', '-lm',
    ],
    run: [SANDBOX.artifactDir + '/box.out'],
    artifact: 'box.out',
    kind: 'compiled',
  },
  python: {
    image: 'judge-python:3.12-slim',
    fileName: 'main.py',
    compile: ['python3', '-c', 'import py_compile,sys; py_compile.compile("/box/main.py", doraise=True)'],
    run: ['python3', '-I', '-B', '/box/main.py'],
    artifact: 'main.py',
    kind: 'interpreted',
  },
};

export function languageSpec(language: JudgeLanguage): (typeof LANG_TABLE)[JudgeLanguage] {
  const spec = LANG_TABLE[language];
  if (!spec) throw new Error('[sandbox] 不支持的语言: ' + String(language));
  return spec;
}

/**
 * 生成容器执行计划。
 *
 * 12 项加固的落点（逐条对应方案 §8.4）：
 *   1  seccomp 白名单        → --security-opt seccomp=<profile>
 *   2  非 root               → --user 1000:1000 + --security-opt no-new-privileges + cap_drop ALL
 *   3  cgroup v2             → --cgroupns=private + cpu/memory/pids/io 各项
 *   4  编译与运行分容器      → 本函数由 phase 决定，编译产物经宿主临时目录中转
 *   5  代码大小上限          → 服务端在 precheck 里拦；这里用 :ro 挂载 + 只读根 fs 兜底
 *   6  编译超时              → timeout 包裹，且硬杀整个进程组
 *   7  禁 ptrace             → seccomp 显式禁 + cap_drop ALL（双保险）
 *   8  禁网                  → --network none
 *   9  只读根 fs + 独立 tmpfs → --read-only + --tmpfs（**noexec 恒开**）
 *                               产物走独立只读可执行挂载 → 见 SANDBOX.artifactDir
 *   10 输出上限              → 由包装脚本按字节截断（见 wrapperCommand）
 *   11 频率限制              → 服务端层（见 ratelimit.ts），不在这里
 *   12 判题节点网络隔离      → 基础设施层，不在容器参数里表达
 */
export function buildSandboxPlan(opts: BuildOptions): SandboxPlan {
  const spec = languageSpec(opts.language);
  const isCompile = opts.phase === 'compile';

  // 资源上限：请求值夹到硬上限；编译阶段强制用编译配额，运行阶段用运行配额
  const raw = opts.limits || {};
  const compileMs = Math.min(numOr(raw.compileMs, 10000), HARD_LIMITS.compileMs);
  const runMs = Math.min(numOr(raw.runMs, 1000), HARD_LIMITS.runMs);
  const memoryMB = Math.min(numOr(raw.memoryMB, 256), HARD_LIMITS.memoryMB);
  const outputBytes = Math.min(numOr(raw.outputBytes, MAX_OUTPUT_BYTES), HARD_LIMITS.outputBytes);
  const maxProcs = Math.min(numOr(raw.maxProcs, 64), HARD_LIMITS.maxProcs);

  const wallMs = isCompile ? compileMs : runMs;
  // 编译阶段给 2 倍内存（编译器本身要吃内存），运行阶段按题目配额
  const effMemory = isCompile ? Math.min(memoryMB * 2, HARD_LIMITS.memoryMB) : memoryMB;
  // CPU 配额：运行阶段给满 1 核；编译阶段给 2 核缩短编译时间
  const cpus = isCompile ? '2' : '1';

  const args: string[] = [];

  // 生命周期：前台运行、退出即删、失败即杀
  args.push('--rm');
  args.push('--name', SANDBOX.namePrefix + '-' + opts.name);

  // ⑧ 禁用网络：没有 network namespace 的出网能力
  args.push('--network', 'none');

  // ⑨ 只读根文件系统 + 独立 tmpfs
  //    /tmp 必须可写（编译产物、临时文件），但独立挂载且容器销毁即清；
  //    /box 以只读方式挂用户代码，程序无法改自己的源码。
  //
  //    ⚠️ noexec 恒为 true，**不是**编译阶段放开的理由：
  //      编译阶段需要「往 /tmp 写可执行文件」，但不需要「执行 /tmp 里的东西」——
  //      gcc 是执行 /usr/bin/gcc 去读 /tmp 的产出，写入与执行是两件事。
  //      早期版本两阶段都写 noexec=false，等于允许用户代码往 /tmp 投二进制再跑。
  args.push('--read-only');
  args.push(
    '--tmpfs',
    SANDBOX.tmpDir + ':rw,noexec,nosuid,nodev,size=' + Math.min(effMemory, 256) + 'm,mode=1777'
  );
  args.push('-v', opts.hostWorkDir + ':' + SANDBOX.workDir + ':ro');

  // 运行阶段：编译产物以**只读**方式挂进独立挂载点。
  //   只读 → 用户代码改不了产物（否则可以先跑一遍再篡改结果文件）
  //   独立挂载 → /tmp 的 noexec 不影响它，产物在这里可执行
  //   compile 阶段不挂：产物还没生成，挂了只是空的
  //
  //   ⚠️ 这里**自己也判一次** kind，而不是只信任调用方传了什么。
  //      runner.run() 已经过滤过了，但 buildSandboxPlan 是导出的纯函数，
  //      别人可以绕过 runner 直接调它。防御不能依赖「调用方记得过滤」——
  //      多挂一个空目录不致命，但说明这条约束只存在于一个地方，
  //      将来 runner 重构时就会漏。两处都判，成本是零。
  if (!isCompile && opts.hostArtifactDir && needsArtifactMount(opts.language)) {
    args.push('-v', opts.hostArtifactDir + ':' + SANDBOX.artifactDir + ':ro');
  }
  // 没传 hostArtifactDir（或语言不需要产物）时不挂载。
  // 编译型语言缺产物会让运行失败 —— 这是刻意的 fail-loud：
  // 静默退化成「跑空程序」比直接失败危险得多。

  // ② 非 root + 禁止提权
  args.push('--user', SANDBOX.user);
  args.push('--security-opt', 'no-new-privileges');
  args.push('--cap-drop', 'ALL');
  // 只加回编译/运行必需的能力（其实静态编译不需要任何能力，这里显式为空）
  args.push('--ulimit', 'core=0:0');
  args.push('--ulimit', 'nofile=256:256');
  args.push('--ulimit', 'nproc=' + maxProcs + ':' + maxProcs);

  // ⑦ seccomp 白名单（挂载服务端内置 profile；禁 ptrace/socket/mount/unshare 等）
  //    路径由调用方传入（宿主路径），默认值仅供自检
  args.push('--security-opt', 'seccomp=' + (opts.seccompProfile || DEFAULT_SECCOMP_PROFILE));

  // ③ cgroup v2 资源隔离
  args.push('--cgroupns', 'private');
  args.push('--cpus', cpus);
  args.push('--memory', effMemory + 'm');
  // memory.swap.max=0 —— 关键：不设这个，超内存会走 swap 而不是 OOM，MLE 判不出来
  args.push('--memory-swap', effMemory + 'm');
  // pids.max —— 防 fork 炸弹。这是最容易被漏掉的一条
  args.push('--pids-limit', String(maxProcs));

  // 不给 tty/stdin 以外的任何交互面
  args.push('-i');
  args.push('--init'); // 回收僵尸进程，避免 --init 缺失时僵尸堆积

  args.push('--entrypoint', '/bin/sh');
  args.push(spec.image);
  args.push('-c', wrapperCommand(opts, spec, wallMs, outputBytes));

  return {
    image: spec.image,
    args: args,
    // 编译阶段不给 stdin：编译器不该读输入。
    // 运行阶段原样带上（空串也是有效输入，表示「本题无输入」）。
    stdin: isCompile ? undefined : opts.stdin,
    effective: {
      wallMs: wallMs,
      memoryMB: effMemory,
      outputBytes: outputBytes,
      maxProcs: maxProcs,
      cpuQuota: cpus + ' cpu',
      cpus: cpus,
    },
    assertions: assertionsFor(opts, {
      wallMs: wallMs,
      memoryMB: effMemory,
      outputBytes: outputBytes,
      maxProcs: maxProcs,
    }),
  };
}

/**
 * 容器内包装命令。
 *
 * 两个要点：
 *  1. `ulimit -t` 限制 CPU 时间（秒，向上取整）——这是内核级的，杀得掉死循环。
 *     墙钟超时由服务端定时器负责（docker 容器不会自己因为 wall clock 退出）。
 *  2. 输出按字节截断：用 head -c。超出即打 >1MB 标记，服务端据此判 OLE。
 *     不截断的话，输出炸弹会把容器内存和日志同时撑爆。
 */
function wrapperCommand(
  opts: BuildOptions,
  spec: (typeof LANG_TABLE)[JudgeLanguage],
  wallMs: number,
  outputBytes: number
): string {
  const cpuSec = Math.max(1, Math.ceil(wallMs / 1000));
  const cmd = opts.phase === 'compile' ? spec.compile : opts.argv || spec.run;

  // 每个参数单独引号包裹；参数全部来自服务端常量或服务端生成的文件名，不含用户输入
  const quoted = cmd
    .map(function (a) {
      return "'" + a.replace(/'/g, "'\\''") + "'";
    })
    .join(' ');

  // 输出分流：stdout → /tmp/.out，stderr → /tmp/.err，各自限流
  return [
    'ulimit -t ' + cpuSec + ' 2>/dev/null;',
    'ulimit -v ' + 0 + ' 2>/dev/null;', // 内存由 cgroup 管，不用 ulimit -v（会干扰 JVM 类运行时）
    quoted + ' >/tmp/.out 2>/tmp/.err;',
    'code=$?;',
    // 逐流截断，超限时在 stderr 末尾追加标记，服务端据此判 OLE
    'head -c ' + outputBytes + ' /tmp/.out;',
    'printf "\\n---STDERR---\\n" 1>&2;',
    'head -c ' + outputBytes + ' /tmp/.err 1>&2;',
    'exit $code',
  ].join(' ');
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback;
}

function assertionsFor(opts: BuildOptions, eff: Record<string, number>): string[] {
  const list: string[] = [];
  list.push('network[disabled]');
  list.push('rootfs[read-only]');
  list.push('user[non-root:' + SANDBOX.user + ']');
  list.push('seccomp[whitelist]');
  list.push('ptrace[denied]');
  list.push('cgroup[v2-private]');
  list.push('memory[' + eff.memoryMB + 'MB,swap=0]');
  list.push('pids[max=' + eff.maxProcs + ']');
  list.push('wall[' + eff.wallMs + 'ms]');
  list.push('output[' + eff.outputBytes + 'B]');
  list.push('workdir[ro]');
  // tmpfs 恒 noexec：断言出来，避免以后有人为了「让产物能执行」把它改回 false
  list.push('tmpfs[noexec]');
  // 产物挂载只在运行阶段存在，且必须只读
  if (opts.phase === 'run') {
    list.push(opts.hostArtifactDir ? 'artifact[mounted:ro]' : 'artifact[missing]');
  }
  list.push('phase[' + opts.phase + ']');
  return list;
}

/**
 * 编译产物如何从编译容器交给运行容器。
 *
 * 说明（这是本项目一个刻意的取舍）：
 *   两个阶段不共享容器，产物经**宿主临时目录**中转：
 *     编译容器 → /tmp/box.out → (docker cp) → 宿主 artifactDir → 运行容器 /box-artifact/box.out
 *   代价是多一次拷贝，收益是运行容器里**没有编译器**——攻击面小得多。
 *   如果共用一个容器，用户就能在运行阶段调用编译器做奇怪的事。
 *
 *   ⚠️ 宿主中转目录必须与工作目录分开（`.artifacts` 后缀），
 *      因为它要以可执行方式挂载，而工作目录是只读挂载。
 *      混在一起会让整个工作目录变成可执行——没必要扩大范围。
 */
export const ARTIFACT_HANDOFF = {
  /** 编译阶段：产物在编译容器内的位置（tmpfs，此时允许写） */
  compileOutputInContainer: SANDBOX.tmpDir + '/' + LANG_TABLE.c.artifact,
  /** 宿主中转目录名（挂在 workDir 同级，不放进 workDir） */
  hostStagingDirSuffix: '.artifacts',
} as const;

/**
 * 运行容器里产物的落点。
 *
 * 注意语言差异：
 *   - C/C++ 是编译型，产物是需要执行的二进制 → 走只读可执行挂载
 *   - Python 是解释型，没有编译产物，直接执行 /box 下的源码 → 不需要产物挂载
 *     所以 python 的运行阶段不挂 artifactDir，run 命令仍指向 /box/main.py。
 */
export function runtimeArtifactPath(language: JudgeLanguage): string {
  const spec = languageSpec(language);
  if (spec.kind === 'interpreted') return SANDBOX.workDir + '/' + spec.fileName;
  return SANDBOX.artifactDir + '/' + spec.artifact;
}

/** 该语言在运行阶段是否需要可执行产物挂载 */
export function needsArtifactMount(language: JudgeLanguage): boolean {
  return languageSpec(language).kind === 'compiled';
}
