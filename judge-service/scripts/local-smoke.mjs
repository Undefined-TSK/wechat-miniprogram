/**
 * 本地模式端到端验证（**这是给用户「不花钱先跑通」用的**）
 *
 * 运行：node judge-service/scripts/local-smoke.mjs
 *
 * 它做的事：不装 docker、不连 Redis、不发网络请求，直接在本机跑一遍
 * 完整的判题链路，确认「提交 → 编译 → 逐测试点运行 → 比对 → 出结论」是通的。
 *
 * 需要本机装好 gcc（C/C++）或 python3（Python）。缺哪个就跳过哪个语言，
 * 并明确告诉你缺什么 —— 不假装跑过了。
 */

import { register } from 'node:module';
import path from 'node:path';
import fsSync from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

register(pathToFileURL(path.join(ROOT, 'tests/ts-resolver.mjs')).href, import.meta.url);

/** 冒烟用的题目与提交，覆盖四种典型结论 */
export const SMOKE_CASES = [
  {
    id: 'accepted',
    language: 'c',
    title: '正确答案 → 应判 AC',
    questionId: 'smoke-sum',
    code: [
      '#include <stdio.h>',
      'int main(){ long long n; if(scanf("%lld",&n)!=1) return 1;',
      '  printf("%lld\\n", n*(n+1)/2); return 0; }',
    ].join('\n'),
    plan: {
      questionId: 'smoke-sum',
      language: 'c',
      judgeMs: 8000,
      memoryMB: 256,
      compare: 'exact-lines',
      cases: [
        { index: 1, stdin: '1\n', expected: '1\n' },
        { index: 2, stdin: '5\n', expected: '15\n' },
        { index: 3, stdin: '100000\n', expected: '5000050000\n' },
      ],
    },
    expect: 'accepted',
  },
  {
    id: 'wrong-answer',
    language: 'c',
    title: '用 int 会溢出 → 应判 WA（考点题）',
    questionId: 'smoke-sum',
    code: [
      '#include <stdio.h>',
      'int main(){ int n; if(scanf("%d",&n)!=1) return 1;',
      '  int s=0; for(int i=1;i<=n;i++) s+=i; printf("%d\\n", s); return 0; }',
    ].join('\n'),
    plan: {
      questionId: 'smoke-sum',
      language: 'c',
      judgeMs: 8000,
      memoryMB: 256,
      compare: 'exact-lines',
      cases: [
        { index: 1, stdin: '1\n', expected: '1\n' },
        { index: 2, stdin: '5\n', expected: '15\n' },
        { index: 3, stdin: '100000\n', expected: '5000050000\n' },
      ],
    },
    expect: 'wrong-answer',
  },
  {
    id: 'compile-error',
    language: 'c',
    title: '语法错误 → 应判 CE',
    questionId: 'smoke-sum',
    code: '#include <stdio.h>\nint main(){ printf("hi") return 0; }\n',
    plan: {
      questionId: 'smoke-sum',
      language: 'c',
      judgeMs: 8000,
      memoryMB: 256,
      cases: [{ index: 1, stdin: '', expected: 'hi' }],
    },
    expect: 'compile-error',
  },
  {
    id: 'runtime-error',
    language: 'c',
    title: '数组越界崩溃 → 应判 RE',
    questionId: 'smoke-sum',
    code: '#include <stdio.h>\nint main(){ int *p=0; *p=1; printf("%d",*p); return 0; }\n',
    plan: {
      questionId: 'smoke-sum',
      language: 'c',
      judgeMs: 8000,
      memoryMB: 256,
      cases: [{ index: 1, stdin: '', expected: '1' }],
    },
    expect: 'runtime-error',
  },
  {
    id: 'python-accepted',
    language: 'python',
    title: 'Python 正确答案 → 应判 AC',
    questionId: 'smoke-py',
    code: 'n = int(input())\nprint(n * (n + 1) // 2)\n',
    plan: {
      questionId: 'smoke-py',
      language: 'python',
      judgeMs: 8000,
      memoryMB: 256,
      compare: 'exact-lines',
      cases: [
        { index: 1, stdin: '1\n', expected: '1\n' },
        { index: 2, stdin: '100000\n', expected: '5000050000\n' },
      ],
    },
    expect: 'accepted',
    requires: 'python',
  },
];

/** 语言 → 需要本机有什么 */
export function requiredToolchain(language) {
  return language === 'python' ? 'python' : 'gcc';
}

/**
 * 把「常见但不在 PATH 里」的工具链目录补进 PATH，返回补了哪些目录。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  为什么需要这一步（这是真实踩到的坑，不是过度设计）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 用 winget 装完 MinGW-w64 之后，**新开的终端才有 PATH**。
 * 如果你在装之前就打开的终端里跑冒烟测试，会看到「本机没有 gcc」——
 * 于是以为没装上，又去重装一遍，排查方向完全错。
 *
 * 更隐蔽的是 Node 在 Windows 上的行为：它**优先读 `Path` 而不是 `PATH`**。
 * 很多开发环境（IDE、CI、沙箱）里两个变量的值不一样，导致你往 PATH
 * 里追加的目录**静默失效**，没有任何报错。
 *
 * 所以这里主动去找常见安装位置并补上。**只补不覆盖**：
 * 已经在 PATH 里的仍然优先；找不到就不补，不影响正常情况。
 */
export function augmentPathForToolchain() {
  const added = [];
  if (process.platform !== 'win32') return added;

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const candidates = [];

  // winget 装 MinGW 的常见发行版（WinLibs / LLVM-MinGW）
  if (localAppData) {
    const wingetPackages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    let entries = [];
    try {
      entries = fsSync.readdirSync(wingetPackages);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (/WinLibs|LLVM-MinGW|mingw/i.test(e)) {
        // 包内结构可能是 <pkg>/mingw64/bin ，也可能直接是 <pkg>/bin
        candidates.push(path.join(wingetPackages, e, 'mingw64', 'bin'));
        candidates.push(path.join(wingetPackages, e, 'bin'));
      }
    }
  }

  candidates.push(path.join(programFiles, 'mingw64', 'bin'));
  candidates.push('C:\\msys64\\mingw64\\bin');
  candidates.push('C:\\MinGW\\bin');

  for (const dir of candidates) {
    try {
      if (!fsSync.existsSync(dir)) continue;
    } catch {
      continue;
    }
    const hasGcc =
      fsSync.existsSync(path.join(dir, 'gcc.exe')) ||
      fsSync.existsSync(path.join(dir, 'gcc'));
    if (!hasGcc) continue;

    // ⚠️ 两个变量都要补 —— Node 在 Windows 上优先读 Path，
    //    只补 PATH 可能完全不生效（且没有任何提示）。
    for (const key of ['PATH', 'Path']) {
      const cur = process.env[key];
      if (typeof cur === 'string' && cur.indexOf(dir) < 0) {
        process.env[key] = dir + ';' + cur;
      }
    }
    added.push(dir);
  }
  return added;
}

/**
 * 跑一个冒烟用例，返回结构化结论（供自检断言，不靠打印文本）。
 *
 * 刻意不经过 bootstrap 的内存题库，而是把 plan 直接交给一个最小的 PlanProvider，
 * 这样冒烟脚本能自己控制测试点，不受内置样例题内容影响。
 *
 * 除「不做隔离」之外，走的是**与生产完全相同的代码路径**：
 * 同一个 JudgeService、同一个 SandboxRunner、同一套 policy 生成的计划。
 */
export async function runCaseDirect(smokeCase) {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const base = path.join(ROOT, 'judge-service/src');

  const boot = await import(pathToFileURL(path.join(base, 'bootstrap.ts')).href);
  const judgesMod = await import(pathToFileURL(path.join(base, 'judges/index.ts')).href);
  const runnerMod = await import(pathToFileURL(path.join(base, 'sandbox/runner.ts')).href);
  const localMod = await import(pathToFileURL(path.join(base, 'sandbox/local-executor.ts')).href);
  const adaptersMod = await import(pathToFileURL(path.join(base, 'adapters.ts')).href);
  const rlMod = await import(pathToFileURL(path.join(base, 'sandbox/ratelimit.ts')).href);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-smoke-'));
  const config = Object.assign({}, boot.loadConfig().config, { workspaceRoot: root });

  const executor = new localMod.LocalExecutor({ workspaceRoot: root });
  const runner = new runnerMod.SandboxRunner(executor, { seccompProfile: config.seccompProfile });

  const service = new judgesMod.JudgeService({
    runner: runner,
    plans: { getPlan: async function () { return smokeCase.plan; } },
    cache: new adaptersMod.MemoryResultCache(),
    workspace: new adaptersMod.LocalWorkspace(root, { localMode: true }),
    files: adaptersMod.defaultFileNames,
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), {
      perMinute: 9999,
      perDay: 99999,
      cooldownMs: 0,
    }),
  });

  const outcome = await service.submit('smoke-user', {
    submissionId: 'smoke-' + smokeCase.id + '-' + Date.now().toString(36),
    questionId: smokeCase.plan.questionId,
    language: smokeCase.language,
    code: smokeCase.code,
  });

  return {
    ok: outcome.ok,
    verdict: outcome.response ? outcome.response.verdict : null,
    passed: outcome.response ? outcome.response.passed : 0,
    total: outcome.response ? outcome.response.total : 0,
    compileMessage: outcome.response ? outcome.response.compileMessage : undefined,
    error: outcome.error,
    root: root,
  };
}

async function main() {
  // ⚠️ 必须在探测工具链之前补 PATH：
  //    刚装完 MinGW 的终端里 PATH 还没刷新，Node 又优先读 `Path`，
  //    两件事叠起来会让人误以为「装了却没装上」。
  const added = augmentPathForToolchain();

  const localMod = await import(pathToFileURL(path.join(ROOT, 'judge-service/src/sandbox/local-executor.ts')).href);
  const toolchain = localMod.probeLocalToolchain();

  console.log('判题服务 · 本地模式冒烟测试');
  console.log('='.repeat(64));
  for (const d of added) {
    console.log('（已自动补入工具链目录：' + d + '）');
  }
  console.log('本机工具链：gcc/g++ = ' + (toolchain.gcc ? '有' : '没有') +
    '，python3 = ' + (toolchain.python ? '有' : '没有'));
  console.log('');

  if (!toolchain.gcc && !toolchain.python) {
    console.log('本机既没有 gcc 也没有 python3，无法跑本地判题。');
    console.log('装好其中一个再跑本命令，或改用 JUDGE_SANDBOX=docker。');
    process.exitCode = 1;
    return;
  }

  let pass = 0;
  let fail = 0;
  let skip = 0;

  for (const c of SMOKE_CASES) {
    const need = requiredToolchain(c.language);
    const have = need === 'gcc' ? toolchain.gcc : toolchain.python;
    if (!have) {
      console.log('跳过  ' + c.title + '（本机没有 ' + need + '）');
      skip++;
      continue;
    }

    let r;
    try {
      r = await runCaseDirect(c);
    } catch (e) {
      console.log('失败  ' + c.title + ' —— 抛异常：' + (e && e.message ? e.message : String(e)));
      fail++;
      continue;
    }

    const got = r.verdict;
    const expected = c.expect;
    if (got === expected) {
      console.log('通过  ' + c.title + '  →  ' + got +
        (r.total ? '（通过 ' + r.passed + '/' + r.total + ' 个测试点）' : ''));
      pass++;
    } else {
      console.log('失败  ' + c.title + '  →  期望 ' + expected + '，实际 ' + got +
        (r.compileMessage ? ' | 编译器：' + String(r.compileMessage).split('\n')[0] : '') +
        (r.error ? ' | 错误：' + JSON.stringify(r.error) : ''));
      fail++;
    }

    // 清理临时目录（本地模式同样要清，否则反复跑会堆满）
    try {
      const fs = await import('node:fs');
      fs.rmSync(r.root, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }

  console.log('');
  console.log('-'.repeat(64));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项，跳过 ' + skip + ' 项');
  if (fail === 0 && pass > 0) {
    console.log('本地判题链路是通的 —— 不花钱就能开始做题验证了。');
  } else if (pass === 0) {
    console.log('没跑通。请把上面的输出发给我。');
  }
  if (fail > 0) process.exitCode = 1;
}

if (IS_MAIN) {
  main().catch(function (e) {
    console.error('冒烟测试异常：' + (e && e.stack ? e.stack : String(e)));
    process.exitCode = 1;
  });
}
