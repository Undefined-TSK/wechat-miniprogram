/**
 * 判题沙箱 · 本地执行器（**仅用于开发/演示，绝不上线**）
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ⚠️ 安全警告：这个执行器**没有任何隔离**
 * ═══════════════════════════════════════════════════════════════════
 *
 * 它会把你机器上写的用户代码，用你的身份、在你的文件系统上直接跑。
 * 一段 `system("rm -rf ~")` 或者 `while(1) fork();` 就能毁掉这台电脑。
 *
 * 那为什么还要有它：
 *   判题服务最贵的一环是「跑代码」。而项目在最早期（自己开发、自己测题、
 *   内容还没上线）根本不该为此付服务器钱 —— 也不该为此先装一整套 Docker。
 *   有了这个执行器，**零成本就能验证整条判题链路是通的**：
 *   提交 → 编译 → 逐测试点运行 → 比对 → 出结论。
 *
 * 什么时候它够用：
 *   - 自己一个人在本机试做题流程
 *   - 录题时验证「我写的测试点是对的」
 *   - 调整题型/判分逻辑时不用每次起容器
 *
 * 什么时候必须换回 Docker（`JUDGE_SANDBOX=docker`）：
 *   - 有任何第二个人会提交代码（哪怕只是同学试用）
 *   - 手机上的小程序能连到这台机器
 *   - 上线前 **必须** 切回 docker，没有例外
 *
 * ── 它在「行为上」与 docker 执行器保持一致的地方 ──
 *
 * 为了不让你「本地测通了、上服务器就变样」，这些行为刻意对齐：
 *   1. 输出分隔符 `---STDERR---`（宿主侧据此拆分 stdout/stderr）
 *   2. 输出按字节截断（否则输出炸弹会撑爆内存）
 *   3. 墙钟超时由 Node 侧计时器 kill（docker 容器也不会自己退出）
 *   4. 退出码原样透传（分类器据此判 AC/WA/RE）
 *   5. 编译失败立刻返回、不进运行阶段
 *
 * ── 它有意做不到的地方（会明确告警，不假装做到） ──
 *
 *   - 内存上限：没有 cgroup，拿不到真实峰值内存 → 一律报 0
 *     影响：**内存超限（MLE）判不出来**，只会表现为「跑得慢」或「被系统杀」
 *   - 进程数上限：没有 pids.max → fork 炸弹会真的炸掉你的机器
 *   - 网络隔离：没有 network namespace → 用户代码能联网
 *   - CPU 时间限制：用 ulimit -t 近似（Linux/macOS 有效，Windows 上无效）
 *
 * 所以它会往启动日志里打一条**醒目告警**。这不是「差不多能用就行」，
 * 而是「明确知道哪里不设防」——不知道边界的降级比明确的降级危险得多。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { SandboxPlan } from './policy';
import { languageSpec, SANDBOX, ARTIFACT_HANDOFF } from './policy';
import { containerNameOf, type ExecResult, type Executor } from './runner';

/** 输出分隔符：与 policy.ts 的 wrapperCommand 必须一致，宿主侧靠它拆流 */
const STDERR_MARK = '---STDERR---';

export interface LocalExecutorOptions {
  /** 工作根目录（与 docker 模式共用同一套工作区约定） */
  workspaceRoot: string;
  /** 编译产物的容器内路径前缀，用于从 plan.args 里反推真实路径 */
  log?: (msg: string) => void;
}

/**
 * 从 docker 参数里把「挂载映射」还原成本机路径。
 *
 * 为什么需要它：`buildSandboxPlan()` 生成的是**容器视角**的参数
 * （`/box/main.c`、`/box-artifact/box.out`）。本机执行没有「容器」，
 * 必须把容器路径翻译回宿主路径。
 *
 * 做法：扫描 `-v host:container[:opts]`，建立 容器路径 → 宿主路径 的映射，
 * 再把命令里的容器路径替换掉。这样**不需要第二份语言配置表**——
 * 编译命令、产物路径仍然只有 policy.ts 一处定义，避免「两套配置漂移」。
 */
export function buildMountMap(plan: SandboxPlan): Array<{ from: string; to: string }> {
  const maps: Array<{ from: string; to: string }> = [];
  const args = plan.args;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-v' && args[i] !== '--volume') continue;
    const spec = args[i + 1];
    if (!spec) continue;
    // 形如 "C:\path:/box:ro" 或 "/host/path:/box-artifact:ro"
    const parts = splitVolumeSpec(spec);
    // ⚠️ 宿主路径统一成正斜杠。Windows 的反斜杠路径一旦嵌进
    //    Python 代码字符串就会被当转义符（`\t` `\n` `\U`）——
    //    表现为「Python 编译总是失败」，而用户代码完全没问题。
    //    Node / gcc / python 在 Windows 上都能正确处理正斜杠。
    if (parts) maps.push({ from: parts.container, to: toPosix(parts.host) });
  }
  // 长路径优先替换，避免 /box 把 /box-artifact 截胡
  maps.sort(function (a, b) {
    return b.from.length - a.from.length;
  });
  return maps;
}

/**
 * 拆 `host:container[:mode]`。
 *
 * ⚠️ 这个函数是本地模式最容易写错的一处，因为**冒号有两种含义**：
 *   1. 分隔 host 与 container
 *   2. Windows 盘符（`D:/ws/sub`）
 *
 * 踩过的坑：先用「从右往左找冒号」的写法，遇到
 *   `D:/ws/sub:/box`
 * 会得到 host=`D`、container=`/ws/sub:/box` —— 完全错了，
 * 而错误的表现是「本地模式跑起来但找不到源码文件」。
 *
 * 正确做法：**容器路径必然以 `/` 开头**。所以找的是
 * 「后面紧跟 `/` 的那个冒号」，而且取最右边的一个
 * （host 侧也可能含 `:/`，例如 `D:/ws/sub.artifacts:/box-artifact`）。
 */
export function splitVolumeSpec(spec: string): { host: string; container: string; mode: string } | null {
  let body = spec;
  let mode = '';

  // 先剥掉可选的第三个字段（ro / rw / ro,z …）
  const lastColon = body.lastIndexOf(':');
  if (lastColon > 0) {
    const tail = body.slice(lastColon + 1);
    if (tail === 'ro' || tail === 'rw' || (tail.indexOf(',') >= 0 && /^[a-zA-Z,]+$/.test(tail))) {
      mode = tail;
      body = body.slice(0, lastColon);
    }
  }

  // 找「冒号 + 斜杠」的位置，从右往左取第一个 —— 那才是 host/container 的分界。
  // 判据是容器路径以 `/` 开头，这是 docker 的硬性约定。
  let idx = -1;
  for (let i = body.length - 2; i >= 0; i--) {
    if (body[i] === ':' && body[i + 1] === '/') {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return null;

  return {
    host: body.slice(0, idx),
    container: body.slice(idx + 1),
    mode: mode,
  };
}

/** 把命令里的容器路径替换成宿主路径 */
export function translatePath(p: string, maps: Array<{ from: string; to: string }>): string {
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    if (p === m.from) return m.to;
    if (p.indexOf(m.from + '/') === 0) {
      return joinPath(m.to, p.slice(m.from.length + 1));
    }
  }
  return p;
}

/**
 * 拼接宿主路径。
 *
 * ⚠️ 这里**刻意统一用正斜杠**，即使在 Windows 上。
 *
 * 原因（踩过的坑）：容器路径永远是正斜杠（`/box/main.py`），
 * 而 `path.join` 在 Windows 上会产出 `D:\tmp\...\main.py`。
 * 这个反斜杠路径：
 *   - 直接交给 gcc/g++ 没问题
 *   - 但一旦**嵌进 Python 代码字符串**（`py_compile.compile("D:\tmp\...")`）
 *     就会因为 `\t` `\n` 是转义符而报错 —— 表现为「Python 编译莫名其妙失败」
 *
 * Node 的 fs / spawn / gcc / python 在 Windows 上**都接受正斜杠**，
 * 所以统一用正斜杠既安全又避免转义问题。这是本地模式特有的处理，
 * 不影响 docker 模式（那边路径由容器自己解释）。
 */
function joinPath(base: string, rest: string): string {
  return base.replace(/[\\/]+$/, '') + '/' + rest.replace(/\\/g, '/');
}

/**
 * 统一成正斜杠，并折叠重复的分隔符。
 *
 * 为什么必须折叠：docker 的 `-v` 参数本身用 `/` 分隔 host 与 container，
 * 于是 `C:\Users\...\ws` 拼成 volume spec 后会变成 `C:/Users/.../ws:/box`；
 * 我们拆回来时若不小心，就会出现 `C://Users//LZH` 这种重复斜杠。
 * Linux 上重复斜杠无害，Windows 上某些工具会认不出来。
 *
 * ⚠️ 唯一的例外是 UNC 路径（`\\server\share` → `//server/share`），
 *    开头的双斜杠**有语义**，不能折叠掉。
 */
export function toPosix(p: string): string {
  const isUnc = /^[\\/]{2}[^\\/]/.test(p);
  let out = p.replace(/\\/g, '/');
  if (isUnc) {
    // 保留开头的 //，只折叠后面的
    return '//' + out.slice(2).replace(/\/{2,}/g, '/');
  }
  return out.replace(/\/{2,}/g, '/');
}

/**
 * 参数「文本内部」的容器路径替换。
 *
 * ⚠️ 为什么需要这个、且为什么容易漏：
 *   Python 的"编译"命令是 `python3 -c 'import py_compile; py_compile.compile("/box/main.py")'`
 *   —— 容器路径**嵌在 Python 代码字符串里**，不是独立参数。
 *   只调用 translatePath(参数) 是替换不到的，结果是本地模式下
 *   python3 去打开 `/box/main.py`（一个在本机根本不存在的路径）→ 退出码 1，
 *   表现为「Python 编译失败」——而用户代码完全没问题。
 *
 * 实现上宁可保守：只在**明确的路径边界**上替换（前面是引号/空格/=/( 等，
 * 后面是引号/空格/) 等），不做全局字符串替换 —— 否则用户代码里若出现
 * 同样的字面量就会被误改。
 */
export function translatePathInText(text: string, maps: Array<{ from: string; to: string }>): string {
  let out = text;
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    // 匹配 <边界><容器路径>(/<后续>)?<边界>
    const pattern = new RegExp(
      '(^|[\\s\'"=([:,])' +
        escapeRegExp(m.from) +
        '(?=[/\\s\'")\\]}]|$)',
      'g'
    );
    out = out.replace(pattern, function (_all, prefix: string) {
      return prefix + m.to;
    });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class LocalExecutor implements Executor {
  private workspaceRoot: string;
  private log: (msg: string) => void;

  constructor(opts: LocalExecutorOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.log = opts.log || function () {
      /* 默认静默 */
    };
  }

  async exec(plan: SandboxPlan, timeoutMs: number): Promise<ExecResult> {
    const started = Date.now();
    const maps = buildMountMap(plan);

    // 从计划里取命令：`docker run ... <image> sh -c '<wrapper>'` 的最后两项
    const parsed = extractShellCommand(plan.args);
    if (!parsed.ok) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        wallMs: 0,
        peakMemoryKB: 0,
        wallTimeout: false,
        execError: parsed.error,
      };
    }

    // 把容器路径翻译成宿主路径。**这一步是本地模式的关键**：
    // 编译命令里的 /box/main.c、产物 /tmp/box.out 都得落到真实磁盘上。
    //
    // 两步走，缺一不可：
    //   ① translatePath       —— 整个参数就是一个路径（例如 '/box/main.c'）
    //   ② translatePathInText —— 路径嵌在参数内部（例如 python 的 -c 代码串）
    // 只做①会漏掉 python 的编译命令（它把路径写在代码字符串里），
    // 表现为「Python 编译总是失败」而用户代码没问题。
    const argv = parsed.argv.map(function (a) {
      return translatePathInText(translatePath(a, maps), maps);
    });

    // ═══════════════════════════════════════════════════════════════
    // 产物输出重定向 —— 本地模式必须做，且**不能等产物挂载出现**
    // ═══════════════════════════════════════════════════════════════
    //
    // docker 模式的两阶段交接：
    //   编译容器：gcc -o /tmp/box.out  →  容器自己的 tmpfs，合法
    //   docker cp /tmp/box.out → 宿主 artifactDir → (docker cp)
    //   运行容器：挂载 artifactDir 到只读的 /box-artifact，跑 /box-artifact/box.out
    //
    // 本地模式没有容器，所以 `/tmp/box.out` 是个**本机不存在的路径**。
    // 实测后果（这是真实踩到的坑）：
    //   ld.exe: cannot open output file /tmp/box.out: No such file or directory
    // 而用户代码完全正确 —— 他却会去反复检查自己的 C 代码。
    //
    // ⚠️ 关键认识：编译阶段**根本没有产物挂载**（设计如此：产物还没生成，
    //    挂了是空目录）。所以「从挂载映射里找 artifactDir」这条思路在
    //    编译阶段必然落空 —— 早期写法就是这样，于是重定向静默失效，
    //    只在有产物挂载的运行阶段才生效，等于永远不生效。
    //
    // 正确做法：产物目录由 workspaceRoot 直接推导（与 runner.artifactDirFor
    // 同一套约定：workDir 的同级 .artifacts），不依赖挂载是否存在。
    const artifactDir = this.artifactStagingDir(plan, maps);
    const finalArgv = redirectArtifactOutput(argv, plan, artifactDir);

    // ═══════════════════════════════════════════════════════════════
    // 编译阶段：产物目录必须**在执行之前**建好
    // ═══════════════════════════════════════════════════════════════
    //
    // 这是本地模式独有的一步，也是真实踩到的坑：
    //
    //   docker 模式的时间线是
    //     编译容器写自己的 /tmp（合法，容器内 tmpfs 已存在）
    //     → 编译结束后才 mkdirp(宿主 artifactDir) → docker cp 过去
    //   所以调用方（judges/index.ts）在**编译之后**才建目录是对的。
    //
    //   本地模式没有容器，产物直接落宿主路径，于是编译时就要用这个目录。
    //   而调用方的 mkdirp 在编译之后 —— 顺序对不上，链接器直接报：
    //     ld.exe: cannot open output file .../xxx.artifacts/box.out:
    //             No such file or directory
    //   用户看到的是「我的 C 代码编译不过」，但他的代码完全正确。
    //
    // 所以这里自己建。**不能指望调用方改顺序**：那样就把「本地模式的特有
    // 需求」泄漏到了编排层，而编排层本该对执行后端无感知。
    if (artifactDir && plan.assertions.indexOf('phase[compile]') >= 0) {
      try {
        mkdirSync(artifactDir, { recursive: true, mode: 0o755 });
      } catch {
        /* 建不出来就让编译器去报错，报错信息比我们猜的更准 */
      }
    }

    // 编译阶段没有 stdin；运行阶段把测试点输入带上（见下面的 spawnWithLimits）
    return this.spawnWithLimits(finalArgv, timeoutMs, started, plan.stdin);
  }

  /**
   * 推出「产物宿主中转目录」。
   *
   * 两条来源，按可靠性排序：
   *   ① 运行阶段有 `/box-artifact` 只读挂载 → 直接用它，最准
   *   ② 编译阶段没有产物挂载 → 从 /box 的宿主路径推导同级 .artifacts
   *      （与 runner.artifactDirFor / policy.ARTIFACT_HANDOFF 同一约定）
   *
   * ⚠️ 故意**不复制** ARTIFACT_HANDOFF 里的后缀常量：那个常量在 policy.ts，
   *    是本模块已经 import 的。用 import 而不是字面量，避免两处漂移。
   */
  private artifactStagingDir(plan: SandboxPlan, maps: Array<{ from: string; to: string }>): string {
    // ① 运行阶段：有只读产物挂载，直接用
    const mounted = findArtifactDir(maps);
    if (mounted) return mounted;

    // ② 编译阶段：按 /box 的宿主路径推同级 .artifacts
    for (let i = 0; i < maps.length; i++) {
      if (maps[i].from === SANDBOX.workDir) {
        return maps[i].to.replace(/[\\/]+$/, '') + ARTIFACT_HANDOFF.hostStagingDirSuffix;
      }
    }
    return '';
  }

  /**
   * 起进程 + 喂输入 + 墙钟超时 + 输出截断。
   *
   * 超时处理刻意用「进程树 kill」而不是只 kill 子进程：
   * 用户代码常常会 fork，只杀父进程会留下孤儿进程继续吃 CPU ——
   * 这正是 pids.max 在 docker 模式里要防的事，本地模式只能用杀树近似。
   */
  private spawnWithLimits(
    argvIn: string[],
    timeoutMs: number,
    started: number,
    stdin?: string
  ): Promise<ExecResult> {
    return new Promise<ExecResult>(function (resolve) {
      // ⚠️ 先把命令名解析成绝对路径再 spawn。
      //    为什么必须这样：Node 在 Windows 上优先读 `Path` 而不是 `PATH`，
      //    且 env 注入 PATH 时不补 .exe 扩展名 —— 两处都会导致
      //    「用户明明装了 gcc 却报 ENOENT」。详见 resolveExecutable 注释。
      //
      //    解析失败也**不直接报错**：交给 spawn 去试，
      //    这样报错信息仍是系统原文，且不会因为我们判断失误而拒绝执行。
      const argv = argvIn.slice();
      const resolved = resolveExecutable(argv[0]);
      if (resolved) argv[0] = resolved;

      let child: ChildProcess;
      try {
        child = spawn(argv[0], argv.slice(1), {
          windowsHide: true,
          // 不继承 shell 的 stdio 之外的任何东西；cwd 用系统临时目录
          cwd: undefined,
          env: minimalEnv(),
          // stdin 必须显式 pipe：程序要读测试点输入
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        resolve({
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          wallMs: Date.now() - started,
          peakMemoryKB: 0,
          wallTimeout: false,
          execError: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      // 喂输入后立刻关闭 stdin。
      // ⚠️ 不关的后果：`while(scanf(...)!=EOF)` 这类程序会一直等输入，
      //    最后被判成 TLE —— 而学生会去优化算法，方向完全错。
      //    测试点输入为空也要 end()，让程序立刻拿到 EOF。
      if (child.stdin) {
        if (stdin) child.stdin.write(stdin, 'utf8');
        child.stdin.end();
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let wallTimeout = false;

      const timer = setTimeout(function () {
        wallTimeout = true;
        killTree(child);
      }, timeoutMs);

      if (child.stdout) {
        child.stdout.on('data', function (d: Buffer) {
          stdout += d.toString('utf8');
        });
      }
      if (child.stderr) {
        child.stderr.on('data', function (d: Buffer) {
          stderr += d.toString('utf8');
        });
      }

      child.on('error', function (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: null,
          signal: null,
          stdout: stdout,
          stderr: stderr,
          wallMs: Date.now() - started,
          peakMemoryKB: 0,
          wallTimeout: false,
          // ENOENT 基本都是「本机没装 gcc/python」——这是最常见的本地失败，
          // 必须给出可操作的提示，否则用户会以为是自己代码写错了
          execError: explainSpawnError(e, argv[0]),
        });
      });

      child.on('close', function (code, signal) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal: signal,
          stdout: stdout,
          stderr: stderr,
          wallMs: Date.now() - started,
          // 本地模式拿不到真实峰值内存（没有 cgroup）。返回 0 而不是瞎猜一个数——
          // 假数据会让分类器做出错误判断（例如把 RE 判成 MLE）
          peakMemoryKB: 0,
          wallTimeout: wallTimeout,
          execError: undefined,
        });
      });
    });
  }
}

/* ------------------------------ 内部 ------------------------------ */

/** 最小环境变量：避免把宿主机的密钥通过 env 泄漏给用户代码 */
function minimalEnv(): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL'];
  const out: Record<string, string> = {};
  for (let i = 0; i < keep.length; i++) {
    const v = process.env[keep[i]];
    if (v !== undefined) out[keep[i]] = v;
  }
  return out;
}

/**
 * 从 docker 参数数组里取出真正的 shell 命令。
 *
 * 参数形状（由 buildSandboxPlan 生成）：
 *   ['--rm', '--name', 'x', ..., '-v', 'h:/box:ro', ..., 'image', '-c', '<wrapper>']
 * 所以开头的可执行文件是**镜像名之后的第一个 token**
 */
export function extractShellCommand(
  args: string[]
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const idx = args.indexOf('-c');
  if (idx < 0) return { ok: false, error: '执行计划里没有 shell 命令（-c），无法本地执行' };
  const wrapper = args[idx + 1];
  if (!wrapper) return { ok: false, error: '执行计划里的 shell 命令为空' };

  // 包装脚本形如：`ulimit ...; '<cmd>' 'arg1' 'arg2' >/tmp/.out 2>/tmp/.err; code=$?; ...`
  // 我们只需要中间那条被引号包裹的命令。
  const argv = extractQuotedCommand(wrapper);
  if (!argv) return { ok: false, error: '无法从包装脚本中解析出用户命令' };
  return { ok: true, argv: argv };
}

/**
 * 从包装脚本里抠出第一条被单引号包裹的命令。
 *
 * 两条硬约束：
 *   1. 只认**第一条** —— 后面还有 `head -c ... /tmp/.out` 等辅助命令，不能拿来执行
 *   2. 必须正确处理 `'\''` 转义（policy.ts 的 quote() 就是这么转的）
 *
 * 为什么不干脆用 shell 执行整个包装脚本：
 *   Windows 上没有 sh，而且让用户代码经过 shell 会引入命令注入面。
 *   直接 spawn(argv) 是最安全的做法 —— 参数不经过任何 shell 解析。
 */
export function extractQuotedCommand(wrapper: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  const n = wrapper.length;

  // 跳过前导的 ulimit 语句，直到遇到第一个单引号
  while (i < n && wrapper[i] !== "'") i++;
  if (i >= n) return null;

  while (i < n) {
    // 跳过空白
    while (i < n && /\s/.test(wrapper[i])) i++;
    if (i >= n || wrapper[i] !== "'") break;

    i++; // 开引号
    let cur = '';
    while (i < n) {
      if (wrapper[i] === "'") {
        // `'\''` = 结束引号 + 转义单引号 + 重新开引号
        if (wrapper.slice(i, i + 4) === "'\\''") {
          cur += "'";
          i += 4;
          continue;
        }
        i++; // 闭引号
        break;
      }
      cur += wrapper[i];
      i++;
    }
    tokens.push(cur);

    // 遇到重定向或分号说明命令结束了
    const rest = wrapper.slice(i).replace(/^\s+/, '');
    if (rest.indexOf('>') === 0 || rest.indexOf(';') === 0 || rest[0] === '2') break;
  }

  return tokens.length > 0 ? tokens : null;
}

/** 找产物中转目录（`-v <host>:/box-artifact:ro` 的宿主侧） */
function findArtifactDir(maps: Array<{ from: string; to: string }>): string {
  for (let i = 0; i < maps.length; i++) {
    if (maps[i].from.indexOf('artifact') >= 0 || maps[i].from === '/box-artifact') return maps[i].to;
  }
  return '';
}

/**
 * 把产物路径改到宿主中转目录。
 *
 * 两个阶段都要改，但改法不同：
 *
 *   编译阶段：`gcc -o /tmp/box.out` → `-o <artifactDir>/box.out`
 *             （docker 里 /tmp 是容器 tmpfs；本地没有，必须落到真实磁盘）
 *
 *   运行阶段：`/box-artifact/box.out` → `<artifactDir>/box.out`
 *             （本地没有 /box-artifact 只读挂载点；注意这一步
 *              translatePath 已经在前面把 /box-artifact 换成宿主路径了，
 *              所以运行阶段通常是「已经改好」，不需要重复处理）
 *
 * ⚠️ 只改「产物」那一个参数，不改其他任何参数 ——
 *    改多了就是在复制 policy.ts 的语言配置，两处必然漂移。
 */
export function redirectArtifactOutput(argv: string[], plan: SandboxPlan, artifactDir: string): string[] {
  if (!artifactDir) return argv;

  const isCompile = plan.assertions.indexOf('phase[compile]') >= 0;

  if (isCompile) {
    const out = argv.slice();
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i] === '-o') {
        // ⚠️ 用 joinPath 而不是 path.join：后者在 Windows 上产出反斜杠，
        //    与本文件顶部的约定（统一正斜杠）相矛盾。虽然产物路径一般
        //    不会嵌进 Python 代码串，但「有的地方转正斜杠、有的地方不转」
        //    迟早会咬人 —— 统一走同一条拼接路径。
        out[i + 1] = joinPath(artifactDir, posixBasename(out[i + 1]));
        break;
      }
    }
    return out;
  }

  // 运行阶段：命令里若仍残留容器侧的产物路径（没有对应挂载映射时会发生），
  // 就在这里兜底替换成宿主路径。有映射时 translatePath 已处理，此处是幂等的。
  const artifactContainer = plan.assertions.some(function (a) {
    return a.indexOf('artifact[mounted') >= 0;
  });
  if (!artifactContainer) return argv;

  return argv.map(function (a) {
    if (a === SANDBOX.artifactDir) return artifactDir;
    if (a.indexOf(SANDBOX.artifactDir + '/') === 0) {
      return joinPath(artifactDir, a.slice(SANDBOX.artifactDir.length + 1));
    }
    return a;
  });
}

/** 取路径最后一段（同时兼容 / 和 \），避免 path.basename 在 Windows 上的平台差异 */
function posixBasename(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 杀整个进程树。用户代码可能 fork，只杀父进程会留下孤儿继续吃 CPU */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      // Windows 用 taskkill /T 杀树（/F 强制）
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      // POSIX：杀进程组（spawn 时未 detach，子进程与父同组）
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 进程可能已经退出 */
    }
  }
}

/** 把 spawn 的 ENOENT 翻译成「你缺什么」——这是本地模式最常见的失败 */
function explainSpawnError(e: Error, bin: string): string {
  const msg = e.message || String(e);
  if (/ENOENT/.test(msg)) {
    return (
      '本机找不到命令 `' +
      bin +
      '`。本地判题需要你机器上装好对应工具链：' +
      'C/C++ 需要 gcc/g++，Python 需要 python3。' +
      '（若不想装，把 JUDGE_SANDBOX 切回 docker）'
    );
  }
  return msg;
}

/**
 * 本地模式的启动告警。
 *
 * 刻意写得直白：这段文字会出现在服务启动日志里，
 * 目的是让「我现在跑在不设防模式」这件事无法被忽略。
 */
export const LOCAL_MODE_WARNING = [
  '⚠️  判题沙箱当前为【本地不设防模式】(JUDGE_SANDBOX=local)。',
  '    用户代码会以你自己的身份、在你的文件系统上直接运行，**没有任何隔离**。',
  '    这些限制会失效：内存上限(MLE 判不出来)、进程数上限(防不住 fork 炸弹)、',
  '    网络隔离(代码能联网)、只读文件系统。',
  '    仅限「自己一个人在本机开发/录题验证」使用。',
  '    一旦有第二个人能提交代码，或小程序要连到这台机器，**必须**切回 JUDGE_SANDBOX=docker。',
].join('\n');

/**
 * 把「命令名」解析成「绝对路径」。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ⚠️ 为什么不能直接信 PATH（这是一个真实踩到的坑）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 直觉做法是 `spawn('gcc', ...)` 交给系统去 PATH 里找。实测在 Windows
 * 上有两处独立的坑，任一处踩到都会得到 `spawn gcc ENOENT`：
 *
 *   坑 1：Node 在 Windows 上**优先读 `Path`，而不是 `PATH`**。
 *         当进程里 `Path` 与 `PATH` 同时存在且内容不同（很多 IDE、CI、
 *         沙箱环境都会这样），Node 用的是 `Path` —— 于是你在 `PATH`
 *         里追加的目录**完全不起作用**，而且没有任何报错。
 *
 *   坑 2：通过 env 注入 PATH 时，**扩展名不会被自动补全**。
 *         `gcc.exe` 找得到，`gcc` 却报 ENOENT —— 因为补 `.exe`
 *         依赖 PATHEXT，而 env 注入的查找路径不走那套逻辑。
 *
 * 复现命令（两种都失败）：
 *   PATH="<mingw>/bin;$PATH"  node -e "require('child_process').spawnSync('gcc',...)"
 *
 * 后果很严重：用户明明装了 gcc，却被告知「本机没有 gcc」，
 * 于是去重装、去怀疑自己代码 —— 排查方向完全错。
 *
 * 因此这里**不依赖 PATH 查找**，自己把命令名解析成绝对路径：
 * 显式遍历 PATH 目录 + 在 Windows 上依次尝试 .exe/.cmd/.bat。
 * 这样无论宿主环境怎么设置 Path/PATH，结果都是确定的。
 *
 * 顺带的好处：这个坑在生产环境同样存在。systemd / cron / 容器里
 * Node 的 PATH 常常只有 `/usr/bin`，判题服务就会「找不到 gcc」。
 * 自己解析之后，只要部署时把工具链目录放进 PATH 就一定能找到。
 */
export function resolveExecutable(cmd: string): string | null {
  // 已经是带路径的，直接确认存在性
  if (cmd.indexOf('/') >= 0 || cmd.indexOf('\\') >= 0) {
    return existsSync(cmd) ? cmd : null;
  }

  // ⚠️ 同时读 Path 与 PATH。Windows 上环境变量名不区分大小写，
  //    但 Node 的 process.env 是普通对象，两者可能是不同的值。
  const raw = [process.env.PATH, process.env.Path, process.env.path]
    .filter(function (v) { return typeof v === 'string' && v.length > 0; })
    .join(path.delimiter === ';' ? ';' : ':');

  // 分隔符：Windows 用 ; ，POSIX 用 :
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = raw.split(sep).filter(function (d) { return d.length > 0; });

  // Windows 上还要把 POSIX 风格的 /c/Users/... 转回 C:\Users\...
  // （有些开发环境真的会把 POSIX 路径塞进 PATH）
  const extra: string[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(d);
    if (m) extra.push(m[1].toUpperCase() + ':/' + m[2]);
  }

  const allDirs = dirs.concat(extra);

  // Windows 上命令可能带扩展名，也可能不带 —— 两种都要试
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

  for (let i = 0; i < allDirs.length; i++) {
    // 目录本身可能带引号（PATH 里允许 "C:\Program Files\x"）
    const dir = allDirs[i].replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    if (!dir) continue;
    for (let j = 0; j < exts.length; j++) {
      const candidate = dir + '/' + cmd + exts[j];
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* 非法路径名（例如含通配符），跳过 */
      }
    }
  }
  return null;
}

/** 供自检与运维判断：本机是否具备本地执行条件 */
export function probeLocalToolchain(): { gcc: boolean; python: boolean } {
  const probe = function (bin: string): boolean {
    try {
      // 用与 exec 完全相同的解析逻辑，避免「探测说没有、执行时却找到了」
      // 这种自相矛盾（反之亦然）——探测必须代表真实执行能力。
      return resolveExecutable(bin) !== null;
    } catch {
      return false;
    }
  };
  return {
    gcc: probe('gcc') || probe('g++'),
    python: probe('python3') || probe('python'),
  };
}

/** 清掉一次提交的本地工作目录（与 docker 模式同款清理口径） */
export function cleanupLocalWorkspace(dir: string, root: string): void {
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(root))) return;
  try {
    rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
}

/** 本地模式下把源码目录准备好（docker 模式由 docker -v 挂载，不需要） */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 供自检：语言 → 本机需要的可执行文件 */
export function toolchainFor(language: string): string {
  const spec = languageSpec(language as 'c');
  const cmd = spec.compile[0];
  return cmd === 'python3' ? 'python3' : cmd;
}

/** 本地模式也需要这个符号，避免调用方 import 不到 */
export { copyFileSync };
