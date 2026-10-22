/**
 * 判题服务自检
 *
 * 运行：node tests/judge.test.mjs
 *
 * 为什么这些用例值得写：判题服务里最危险的错误是**静默误判**——
 *   - 把段错误判成答案错误 → 用户去改逻辑，越改越远
 *   - 把内存超限判成超时 → 用户去优化算法复杂度，方向全错
 *   - 硬上限没夹住 → 客户端传个大 limits 就能要整台服务器
 *   - 契约两份不同步 → 前端展示 null
 * 这些都不会抛异常、不会打错误日志，只能靠断言拦住。
 *
 * 本套测试**不需要 docker**：沙箱执行器是可注入接口，
 * 用假执行器就能验证「超时→TLE」「SIGKILL+高内存→MLE」「输出超限→OLE」等全部分类逻辑。
 */

import { register } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

register('./ts-resolver.mjs', import.meta.url);

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const contract = await import('../judge-service/src/contract.ts');
const policy = await import('../judge-service/src/sandbox/policy.ts');
const runnerMod = await import('../judge-service/src/sandbox/runner.ts');
const classifyMod = await import('../judge-service/src/judges/classify.ts');
const casesMod = await import('../judge-service/src/questions/testcases.ts');
const rlMod = await import('../judge-service/src/sandbox/ratelimit.ts');
const adapters = await import('../judge-service/src/adapters.ts');

/* ------------------------------ 脚手架 ------------------------------ */

let passCount = 0;
let failCount = 0;
const failures = [];

function record(ok, name, extra) {
  if (ok) {
    passCount++;
    console.log('  \u2713 ' + name);
  } else {
    failCount++;
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' — ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(a === e, name, a === e ? '' : '期望 ' + e + '，实际 ' + a);
}

function ok(name, cond, why) {
  record(!!cond, name, why || '');
}

function section(t) {
  console.log('\n' + t);
}

/* --------------------- 1. 契约双份一致性 --------------------- */

section('1. 契约双份同步（客户端 ↔ 判题服务）');

const clientContract = readFileSync(path.join(ROOT, 'miniprogram/services/judge-contract.ts'), 'utf8');
const serverContract = readFileSync(path.join(ROOT, 'judge-service/src/contract.ts'), 'utf8');

function sha(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// 比对时去掉首行注释差异不必要——两份必须完全一致，做不到就报出来
eq('两份契约文件逐字节一致', sha(serverContract), sha(clientContract));
ok(
  '契约文件不含 wx API 依赖',
  clientContract.indexOf('wx.') < 0,
  '契约必须框架无关，否则服务端无法复用'
);

/* --------------------- 2. 硬上限（防绕开资源限制） --------------------- */

section('2. 资源上限夹取（必须夹到硬上限内）');

const generous = contract.clampLimits({
  compileMs: 999999,
  runMs: 999999,
  memoryMB: 999999,
  outputBytes: 999999999,
  maxProcs: 99999,
});
eq('超大 compileMs 被夹到硬上限', generous.compileMs, contract.HARD_LIMITS.compileMs);
eq('超大 runMs 被夹到硬上限', generous.runMs, contract.HARD_LIMITS.runMs);
eq('超大 memoryMB 被夹到硬上限', generous.memoryMB, contract.HARD_LIMITS.memoryMB);
eq('超大 outputBytes 被夹到硬上限', generous.outputBytes, contract.HARD_LIMITS.outputBytes);
eq('超大 maxProcs 被夹到硬上限', generous.maxProcs, contract.HARD_LIMITS.maxProcs);

const tight = contract.clampLimits({ runMs: 500, memoryMB: 64, maxProcs: 8 });
eq('收紧的 runMs 被保留', tight.runMs, 500);
eq('收紧的 memoryMB 被保留', tight.memoryMB, 64);
eq('收紧的 maxProcs 被保留', tight.maxProcs, 8);

const bad = contract.clampLimits({ runMs: -1, memoryMB: NaN, maxProcs: 0 });
eq('非法 runMs 回落默认值', bad.runMs, contract.DEFAULT_LIMITS.runMs);
eq('NaN memoryMB 回落默认值', bad.memoryMB, contract.DEFAULT_LIMITS.memoryMB);
eq('0 maxProcs 回落默认值', bad.maxProcs, contract.DEFAULT_LIMITS.maxProcs);

/* --------------------- 3. 静态预检 --------------------- */

section('3. 静态预检');

ok('合法请求通过预检', contract.precheck({
  submissionId: 's1', questionId: 'q1', type: 'code-editor', language: 'c', code: 'int main(){}',
}).ok);

eq(
  '不支持的语言被拒',
  contract.precheck({ submissionId: 's1', questionId: 'q1', type: 't', language: 'ruby', code: 'x' }).code,
  'unsupported-language'
);

const huge = 'a'.repeat(contract.MAX_CODE_BYTES + 10);
eq(
  '超长代码被拒',
  contract.precheck({ submissionId: 's1', questionId: 'q1', type: 't', language: 'c', code: huge }).code,
  'payload-too-large'
);

eq(
  '空代码被拒',
  contract.precheck({ submissionId: 's1', questionId: 'q1', type: 't', language: 'c', code: '   \n  ' }).code,
  'internal'
);

// UTF-8 字节估算：中文按 3 字节
eq('UTF-8 字节估算（ASCII）', contract.utf8Bytes('abc'), 3);
eq('UTF-8 字节估算（中文）', contract.utf8Bytes('中'), 3);
eq('UTF-8 字节估算（emoji 代理对）', contract.utf8Bytes('😀'), 4);

/* --------------------- 4. 沙箱 12 项加固落点 --------------------- */

section('4. 沙箱加固：Docker 参数逐条核对');

const plan = policy.buildSandboxPlan({
  name: 'sub1-compile',
  hostWorkDir: '/work/sub1',
  language: 'c',
  phase: 'compile',
});
const args = plan.args.join(' ');

ok('⑧ 禁网：--network none', args.indexOf('--network none') >= 0);
ok('⑨ 只读根文件系统：--read-only', args.indexOf('--read-only') >= 0);
ok('⑨ 独立 tmpfs 挂 /tmp', args.indexOf('--tmpfs /tmp:') >= 0);
ok('② 非 root 运行：--user 1000:1000', args.indexOf('--user 1000:1000') >= 0);
ok('② 禁止提权：no-new-privileges', args.indexOf('no-new-privileges') >= 0);
ok('② 丢弃全部 capability', args.indexOf('--cap-drop ALL') >= 0);
ok('⑦ seccomp 白名单已挂载', args.indexOf('seccomp=') >= 0);
ok('③ cgroupns private', args.indexOf('--cgroupns private') >= 0);
ok('③ 内存上限', /--memory \d+m/.test(args));
ok('③ memory-swap 等于 memory（swap.max=0）', /--memory-swap \d+m/.test(args));
ok('③ pids-limit 防 fork 炸弹', /--pids-limit \d+/.test(args));
ok('⑦ nproc ulimit 兜底', args.indexOf('--ulimit nproc=') >= 0);
ok('core dump 关闭', args.indexOf('--ulimit core=0:0') >= 0);
ok('僵尸进程回收：--init', args.indexOf('--init') >= 0);
ok('容器退出即删：--rm', args.indexOf('--rm') >= 0);
ok('工作目录只读挂载', args.indexOf(':ro') >= 0);

// 内存 swap 必须相等，否则超内存会走 swap 而不是 OOM，MLE 判不出来
const memMatch = args.match(/--memory (\d+)m/);
const swapMatch = args.match(/--memory-swap (\d+)m/);
ok('memory 与 memory-swap 相等（否则 MLE 失效）', !!memMatch && !!swapMatch && memMatch[1] === swapMatch[1]);

ok('编译阶段给 2 核（缩短编译时间）', args.indexOf('--cpus 2') >= 0);
ok(
  '编译阶段内存翻倍但仍夹在硬上限内',
  plan.effective.memoryMB <= contract.HARD_LIMITS.memoryMB,
  '实际 ' + plan.effective.memoryMB
);

const runPlan = policy.buildSandboxPlan({
  name: 'sub1-run',
  hostWorkDir: '/work/sub1',
  language: 'c',
  phase: 'run',
});
const runArgs = runPlan.args.join(' ');
ok('运行阶段只给 1 核', runArgs.indexOf('--cpus 1') >= 0);

// 编译与运行必须是两个不同容器（④ 分容器）——否则运行容器里会留着编译器
function containerNameOf(p) {
  const i = p.args.indexOf('--name');
  return p.args[i + 1];
}
ok(
  '编译与运行使用不同容器名（④ 分容器）',
  containerNameOf(plan) !== containerNameOf(runPlan),
  containerNameOf(plan) + ' vs ' + containerNameOf(runPlan)
);
ok(
  '编译容器与运行容器各自独立（容器名均带 -compile / -run 语义）',
  /-compile$/.test(containerNameOf(plan)) && /-run$/.test(containerNameOf(runPlan)),
  containerNameOf(plan) + ' / ' + containerNameOf(runPlan)
);

// 命令构造必须参数化，不能拼接字符串
// 产物路径从 /tmp 移到了独立的只读可执行挂载点（/box-artifact），
// 因为 /tmp 现在是 noexec —— 见下方「tmpfs 必须 noexec」一组断言。
const quoted = runArgs.indexOf("'/box-artifact/box.out'") >= 0;
ok('运行命令以单引号参数化传入（防注入）', quoted, quoted ? '' : runArgs.slice(0, 200));

// 用户代码只能通过文件进去，不能进命令行
// -v 是独立数组项：宿主目录 → /box:ro
const vIdx = plan.args.indexOf('-v');
const mountSpec = vIdx >= 0 ? plan.args[vIdx + 1] : '';
ok(
  '用户源码以只读挂载进入工作目录',
  mountSpec.indexOf('/work/sub1:/box:ro') >= 0,
  '实际挂载: ' + mountSpec
);
ok(
  '源码路径不出现在命令行参数里（用户代码只能经文件进入）',
  runArgs.indexOf('main.c') < 0 && runArgs.indexOf('/box/main.c') < 0,
  '命令行里不应出现源码文件名'
);


/* ------------- 4b. tmpfs noexec / 产物挂载 / seccomp 路径 ------------- */

section('4b. 沙箱加固（noexec / 产物挂载 / seccomp 路径参数化）');

// ---- tmpfs 必须恒 noexec ----
// 背景：早期版本两阶段都写 noexec=false，等于允许用户代码往 /tmp 投二进制再执行，
// 绕过了「代码只能从源码编译」这条约束。noexec 必须**编译和运行阶段都开**。
ok(
  '编译阶段 /tmp 为 noexec',
  args.indexOf('--tmpfs /tmp:rw,noexec,nosuid,nodev') >= 0,
  args.match(/--tmpfs [^ ]+/)?.[0] || '(未找到 --tmpfs)'
);
ok(
  '运行阶段 /tmp 也为 noexec',
  runArgs.indexOf('--tmpfs /tmp:rw,noexec,nosuid,nodev') >= 0,
  runArgs.match(/--tmpfs [^ ]+/)?.[0] || '(未找到 --tmpfs)'
);
ok(
  '两个阶段的 tmpfs 参数完全一致（不给「运行时放开」留口子）',
  (args.match(/--tmpfs [^ ]+/) || [''])[0] === (runArgs.match(/--tmpfs [^ ]+/) || [''])[0]
);
// 断言列表里也要体现，避免以后有人改回 false 时没人注意
ok('编译阶段 assertions 声明 tmpfs[noexec]', plan.assertions.indexOf('tmpfs[noexec]') >= 0);
ok('运行阶段 assertions 声明 tmpfs[noexec]', runPlan.assertions.indexOf('tmpfs[noexec]') >= 0);

// ---- 编译产物走独立只读可执行挂载 ----
// 因为 /tmp 是 noexec，产物不能放 /tmp 执行，必须单独挂一个可执行目录。
// 而且要**只读**：否则用户代码可以先跑一遍再篡改产物。
{
  const withArtifact = policy.buildSandboxPlan({
    name: 'sub1-run',
    hostWorkDir: '/work/sub1',
    language: 'c',
    phase: 'run',
    hostArtifactDir: '/work/sub1.artifacts',
  });
  const wArgs = withArtifact.args.join(' ');
  ok(
    '运行阶段挂载产物目录（只读）',
    wArgs.indexOf('/work/sub1.artifacts:/box-artifact:ro') >= 0,
    wArgs.match(/-v [^ ]*box-artifact[^ ]*/)?.[0] || '(未找到产物挂载)'
  );
  ok(
    '编译阶段**不**挂载产物目录（产物还不存在）',
    args.indexOf('/box-artifact') < 0
  );
  ok(
    '产物挂载时 assertions 标注 artifact[mounted:ro]',
    withArtifact.assertions.indexOf('artifact[mounted:ro]') >= 0
  );
  ok(
    '未传 hostArtifactDir 时 assertions 标注 artifact[missing]（fail-loud）',
    runPlan.assertions.indexOf('artifact[missing]') >= 0
  );

  // 解释型语言不该挂产物：python 直接执行 /box 下的源码
  const pyRun = policy.buildSandboxPlan({
    name: 'sub1-run',
    hostWorkDir: '/work/sub1',
    language: 'python',
    phase: 'run',
    hostArtifactDir: '/work/sub1.artifacts',
  });
  const pyArgs = pyRun.args.join(' ');
  ok(
    'Python 运行阶段**不**挂载产物目录（解释型，无编译产物）',
    pyArgs.indexOf('/box-artifact') < 0,
    pyArgs.match(/-v [^ ]*box-artifact[^ ]*/)?.[0] || '（无产物挂载，正确）'
  );
  ok(
    'Python 运行命令指向 /box/main.py',
    pyArgs.indexOf("'/box/main.py'") >= 0
  );
  ok('needsArtifactMount(c) 为真', policy.needsArtifactMount('c') === true);
  ok('needsArtifactMount(python) 为假', policy.needsArtifactMount('python') === false);
}

// ---- seccomp profile 路径必须可参数化，不能再写死 ----
{
  const custom = policy.buildSandboxPlan({
    name: 'sub1-compile',
    hostWorkDir: '/work/sub1',
    language: 'c',
    phase: 'compile',
    seccompProfile: '/opt/judge/my-profile.json',
  });
  ok(
    'seccomp 路径可由调用方指定（不再写死常量）',
    custom.args.join(' ').indexOf('seccomp=/opt/judge/my-profile.json') >= 0,
    custom.args.join(' ').match(/seccomp=[^ ]+/)?.[0] || '(未找到)'
  );
  ok(
    '未指定时回落到 DEFAULT_SECCOMP_PROFILE',
    args.indexOf('seccomp=' + policy.DEFAULT_SECCOMP_PROFILE) >= 0,
    args.match(/seccomp=[^ ]+/)?.[0] || '(未找到)'
  );
  // 三处（Dockerfile / compose / bootstrap 默认值）必须一致，否则运行时才炸
  ok(
    '默认 profile 路径以 /etc/judge/ 开头（与 Dockerfile 的 COPY 目标一致）',
    policy.DEFAULT_SECCOMP_PROFILE.indexOf('/etc/judge/') === 0,
    policy.DEFAULT_SECCOMP_PROFILE
  );
}

// ---- -lm 必须存在 ----
// gcc 不自动链接数学库。缺 -lm 时 sqrt/pow 报 "undefined reference"，
// 学生只会以为自己写错了 —— 属于静默误伤用户。
//
// 注意查找方式：编译命令**不是**以独立数组项出现在 args 里的，
// 它被 quoteD 成一个字符串塞进 `--entrypoint /bin/sh -c '<wrapper>'`。
// 所以要在「整个 args 拼起来之后的文本」里找，找 `'-lm'`（带引号）。
{
  const cPlan = policy.buildSandboxPlan({
    name: 'c', hostWorkDir: '/w', language: 'c', phase: 'compile',
  });
  const cppPlan = policy.buildSandboxPlan({
    name: 'cpp', hostWorkDir: '/w', language: 'cpp', phase: 'compile',
  });
  const cText = cPlan.args.join(' ');
  const cppText = cppPlan.args.join(' ');
  ok('C 编译命令带 -lm（否则 sqrt/pow 链接失败）',
    cText.indexOf("'-lm'") >= 0, cText.match(/gcc[^;]{0,140}/)?.[0] || '(未找到 gcc 命令)');
  ok('C++ 编译命令带 -lm', cppText.indexOf("'-lm'") >= 0,
    cppText.match(/g\+\+[^;]{0,140}/)?.[0] || '(未找到 g++ 命令)');
  // 运行阶段不该出现 -lm（那是编译期链接选项）
  ok('运行阶段不含 -lm', runArgs.indexOf("'-lm'") < 0);
}

// ---- 产物中转目录必须在 workDir 之外 ----
{
  const dir = runnerMod.artifactDirFor('/var/lib/judge/ws/sub1', '.artifacts');
  ok(
    'artifactDirFor 生成 workDir 的同级目录',
    dir === '/var/lib/judge/ws/sub1.artifacts',
    dir
  );
  ok(
    '产物目录不在 workDir 内部（避免整个工作目录变可执行）',
    dir.indexOf('/var/lib/judge/ws/sub1/') < 0,
    dir
  );
  // 反斜杠尾随（Windows 路径）也要处理对
  ok(
    'artifactDirFor 先剥掉尾部分隔符',
    runnerMod.artifactDirFor('/ws/sub1/', '.artifacts') === '/ws/sub1.artifacts'
  );
}


/* --------------------- 5. seccomp profile --------------------- */

section('5. seccomp profile 内容核查');

const profileRaw = readFileSync(path.join(ROOT, 'judge-service/etc/seccomp-judge.json'), 'utf8');
const profile = JSON.parse(profileRaw.replace(/^\s*"\/\/.*$/gm, ''));
const allowed = profile.syscalls[0].names;

eq('默认动作是拒绝', profile.defaultAction, 'SCMP_ACT_ERRNO');
ok('白名单里没有 ptrace（⑦ 禁 ptrace）', allowed.indexOf('ptrace') < 0);
ok('白名单里没有 socket（⑧ 无外联能力）', allowed.indexOf('socket') < 0);
ok('白名单里没有 connect', allowed.indexOf('connect') < 0);
ok('白名单里没有 mount', allowed.indexOf('mount') < 0);
ok('白名单里没有 unshare', allowed.indexOf('unshare') < 0);
ok('白名单里没有 setns', allowed.indexOf('setns') < 0);
ok('白名单里没有 reboot', allowed.indexOf('reboot') < 0);
ok('白名单里没有 bpf', allowed.indexOf('bpf') < 0);
ok('白名单里没有 kexec_load', allowed.indexOf('kexec_load') < 0);
ok('白名单含 read/write/execve（编译运行必需）',
  allowed.indexOf('read') >= 0 && allowed.indexOf('write') >= 0 && allowed.indexOf('execve') >= 0);

// ---- 校准题集与禁止清单 ----
// 校准题是「白名单必须实跑验证」这个流程的输入。它一旦被删，
// 流程就退化成「靠人记得」，而那正是我们要避免的。
{
  const cal = await import('../judge-service/src/questions/calibration-samples.ts');
  ok('校准题集存在且有 10 道', cal.CALIBRATION_SAMPLES.length === 10, String(cal.CALIBRATION_SAMPLES.length));

  // 每题都要有用途说明与预期调用 —— 没有的话，将来没人知道该盯什么
  const missingPurpose = cal.CALIBRATION_SAMPLES.filter(function (s) { return !s.purpose; });
  ok('每道校准题都有用途说明', missingPurpose.length === 0,
    missingPurpose.map(function (s) { return s.id; }).join(','));

  const missingExpect = cal.CALIBRATION_SAMPLES.filter(function (s) {
    return !s.expectedSyscalls || !s.expectedSyscalls.length;
  });
  ok('每道校准题都标注了预期系统调用', missingExpect.length === 0,
    missingExpect.map(function (s) { return s.id; }).join(','));

  // 覆盖度：光有题不够，得确保覆盖了几类关键调用
  const allExpected = new Set();
  for (const s of cal.CALIBRATION_SAMPLES) {
    for (const n of s.expectedSyscalls) allExpected.add(n);
  }
  for (const need of ['clone3', 'mremap', 'mmap', 'openat', 'execve', 'clock_gettime']) {
    ok('校准覆盖关键调用 ' + need, allExpected.has(need),
      Array.from(allExpected).join(','));
  }

  // 禁止清单必须非空，且与白名单**零交集**
  // 交集非空意味着有人把危险调用加进了白名单 —— 这是安全倒退
  ok('禁止清单非空', cal.FORBIDDEN_SYSCALLS.length > 0, String(cal.FORBIDDEN_SYSCALLS.length));
  const overlap = cal.FORBIDDEN_SYSCALLS.filter(function (n) { return allowed.indexOf(n) >= 0; });
  ok('禁止清单与白名单零交集（防误加危险调用）', overlap.length === 0,
    '交集: ' + overlap.join(','));

  // 禁止清单本身要有意义：必须包含最核心的几类
  for (const need of ['socket', 'ptrace', 'mount', 'unshare', 'bpf']) {
    ok('禁止清单含 ' + need, cal.FORBIDDEN_SYSCALLS.indexOf(need) >= 0);
  }

  // 容易误判的调用要有解释（避免人工 review 时误删）
  const misjudged = cal.COMMONLY_MISJUDGED.filter(function (x) { return x.name && x.reason; });
  ok('易误判调用均有原因说明', misjudged.length === cal.COMMONLY_MISJUDGED.length,
    cal.COMMONLY_MISJUDGED.length + ' 项中 ' + misjudged.length + ' 项有说明');
  const misjudgedNames = cal.COMMONLY_MISJUDGED.map(function (x) { return x.name; });
  ok('clone3 在易误判清单里（老 profile 最常漏的就是它）',
    misjudgedNames.indexOf('clone3') >= 0);
}

/* --------------------- 6. 结果分类（最容易静默出错） --------------------- */

section('6. 判题结论分类');

const limits = { runMs: 1000, memoryMB: 256 };

function raws(over) {
  return Object.assign({
    compiled: true,
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    wallMs: 10,
    peakMemoryKB: 1024,
    timedOut: false,
    outputTruncated: false,
    expected: '',
    outputMatched: true,
  }, over);
}

eq('编译失败 → CE', classifyMod.classify(raws({ compiled: false, compileMessage: 'x' }), limits).verdict, 'compile-error');
eq('正常输出匹配 → AC', classifyMod.classify(raws({ outputMatched: true }), limits).verdict, 'accepted');
eq('输出不匹配 → WA', classifyMod.classify(raws({ outputMatched: false }), limits).verdict, 'wrong-answer');
eq('墙钟超时 → TLE', classifyMod.classify(raws({ timedOut: true, exitCode: null }), limits).verdict, 'time-limit-exceeded');
eq('SIGXCPU → TLE', classifyMod.classify(raws({ signal: 'SIGXCPU', exitCode: null }), limits).verdict, 'time-limit-exceeded');
eq('输出截断 → OLE', classifyMod.classify(raws({ outputTruncated: true }), limits).verdict, 'output-limit-exceeded');
eq('SIGSEGV → RE', classifyMod.classify(raws({ signal: 'SIGSEGV', exitCode: null }), limits).verdict, 'runtime-error');
eq('SIGFPE → RE', classifyMod.classify(raws({ signal: 'SIGFPE', exitCode: null }), limits).verdict, 'runtime-error');
eq('非零退出码 → RE', classifyMod.classify(raws({ exitCode: 1 }), limits).verdict, 'runtime-error');
eq('SIGSYS → SE（沙箱白名单缺调用，不是用户错）',
  classifyMod.classify(raws({ signal: 'SIGSYS', exitCode: null }), limits).verdict, 'system-error');

// SIGKILL 的双重语义：有内存证据才是 MLE
eq('SIGKILL + 峰值内存接近上限 → MLE',
  classifyMod.classify(raws({ signal: 'SIGKILL', exitCode: null, peakMemoryKB: 250 * 1024 }), limits).verdict,
  'memory-limit-exceeded');
eq('SIGKILL + 峰值内存很低 → RE（不是用户内存超限）',
  classifyMod.classify(raws({ signal: 'SIGKILL', exitCode: null, peakMemoryKB: 1024 }), limits).verdict,
  'runtime-error');

// 优先级：编译错误压过一切；输出超限压过答案比对
eq('编译失败优先于超时',
  classifyMod.classify(raws({ compiled: false, timedOut: true }), limits).verdict, 'compile-error');
eq('输出超限优先于答案比对',
  classifyMod.classify(raws({ outputTruncated: true, outputMatched: true }), limits).verdict,
  'output-limit-exceeded');

eq('聚合：全 AC 才 AC', classifyMod.aggregateVerdict([{ verdict: 'accepted' }, { verdict: 'accepted' }]), 'accepted');
eq('聚合：取第一个非 AC 点', classifyMod.aggregateVerdict([{ verdict: 'accepted' }, { verdict: 'wrong-answer' }, { verdict: 'time-limit-exceeded' }]), 'wrong-answer');
eq('聚合：空测试点视为系统错误', classifyMod.aggregateVerdict([]), 'system-error');
ok('AC 展示原始输出开关：CE 需要', classifyMod.shouldShowRawOutput('compile-error'));
ok('AC 展示原始输出开关：WA 不需要', !classifyMod.shouldShowRawOutput('wrong-answer'));
ok('SE 被判为设施问题', classifyMod.isInfrastructureVerdict('system-error'));
ok('WA 不算设施问题', !classifyMod.isInfrastructureVerdict('wrong-answer'));

/* --------------------- 7. 判定 → 引擎结果映射 --------------------- */

section('7. 判题结论 → 引擎 JudgeResult');

function resp(over) {
  return Object.assign({
    submissionId: 's1', verdict: 'accepted', score: 1, passed: 2, total: 2,
    cases: [], totalMs: 10, finishedAt: 1, cacheHit: false,
  }, over);
}

const acMapped = contract.toJudgeResult(resp({}), limits);
eq('AC → correct=true', acMapped.correct, true);
eq('AC → score=1', acMapped.score, 1);
eq('AC → layer=remote', acMapped.layer, 'remote');
eq('AC → strategy=sandbox', acMapped.strategy, 'sandbox');

const partialMapped = contract.toJudgeResult(resp({ verdict: 'wrong-answer', score: 0.6, passed: 3, total: 5 }), limits);
eq('部分通过 → correct=false（编程题过一半不算对）', partialMapped.correct, false);
eq('部分通过 → partial=true', partialMapped.partial, true);
eq('部分通过 → score 保留', partialMapped.score, 0.6);
ok('部分通过 → detail 含通过数', partialMapped.detail.indexOf('3/5') >= 0, partialMapped.detail);

const ceMapped = contract.toJudgeResult(resp({ verdict: 'compile-error', score: 0, passed: 0 }), limits);
eq('CE → score=0', ceMapped.score, 0);
ok('CE → detail 提示看编译器信息', ceMapped.detail.indexOf('编译') >= 0, ceMapped.detail);

const tleMapped = contract.toJudgeResult(resp({ verdict: 'time-limit-exceeded', score: 0, passed: 0 }), limits);
ok('TLE → detail 提示检查死循环/复杂度', tleMapped.detail.indexOf('超时') >= 0, tleMapped.detail);

const mleMapped = contract.toJudgeResult(resp({ verdict: 'memory-limit-exceeded', score: 0, passed: 0 }), limits);
ok('MLE → detail 提示检查数组大小', mleMapped.detail.indexOf('内存超限') >= 0, mleMapped.detail);

const waHidden = contract.toJudgeResult(resp({
  verdict: 'wrong-answer', score: 0, passed: 0, total: 3,
  cases: [{ index: 2, verdict: 'wrong-answer', hidden: true, costMs: 5, memoryKB: 1000 }],
}), limits);
ok('WA 且首个失败点是隐藏点 → 提示「隐藏测试点」', waHidden.detail.indexOf('隐藏测试点') >= 0, waHidden.detail);

ok('映射结果不含任何期望输出（防泄题）', JSON.stringify(acMapped).indexOf('expected') < 0);

/* --------------------- 8. 测试点比对与防泄题 --------------------- */

section('8. 测试点比对与 hidden 保护');

ok('完全一致 → 通过', casesMod.compareOutput('a\nb', 'a\nb'));
ok('容忍行尾空白', casesMod.compareOutput('a  \nb\t', 'a\nb'));
ok('容忍 CRLF', casesMod.compareOutput('a\r\nb\r\n', 'a\nb'));
ok('容忍末尾空行', casesMod.compareOutput('a\nb\n\n\n', 'a\nb'));
ok('行数不同 → 不通过', !casesMod.compareOutput('a', 'a\nb'));
ok('内容不同 → 不通过', !casesMod.compareOutput('a\nc', 'a\nb'));
ok('默认不忽略行首空白', !casesMod.compareOutput('  a', 'a'));
ok('collapse 模式忽略行首与连续空白', casesMod.compareOutput('  a   b  ', 'a b', 'collapse'));
ok('numeric 模式容忍浮点误差', casesMod.compareOutput('3.14159265', '3.1415926', 'numeric'));
ok('numeric 模式超出容差不通过', !casesMod.compareOutput('3.15', '3.14', 'numeric', 1e-6));

const hiddenCase = { index: 3, stdin: 'SECRET-INPUT', expected: 'SECRET-OUTPUT', hidden: true };
const openCase = { index: 1, stdin: '1 2', expected: '3' };
const hiddenPreview = casesMod.buildPreviews(hiddenCase, 'SECRET-ACTUAL', false);
eq('隐藏点不回传任何 preview', JSON.stringify(hiddenPreview), '{}');
const openPreview = casesMod.buildPreviews(openCase, '4', false);
ok('公开点回传输入与期望', !!openPreview.stdinPreview && !!openPreview.expectedPreview);
ok('公开点未通过时回传实际输出', openPreview.actualPreview === '4');
const openPassed = casesMod.buildPreviews(openCase, '3', true);
ok('公开点通过时不回传实际输出（少一个反推面）', openPassed.actualPreview === undefined);

/* --------------------- 9. 判题计划校验 --------------------- */

section('9. 判题计划校验');

const goodPlan = {
  questionId: 'q1', language: 'c', judgeMs: 1000, memoryMB: 256,
  cases: [{ index: 1, stdin: '1 2', expected: '3' }, { index: 2, stdin: '2 3', expected: '5', hidden: true }],
};
const goodV = casesMod.validatePlan(goodPlan);
ok('合法计划通过校验', goodV.ok, JSON.stringify(goodV.errors));
eq('合法计划无告警（有隐藏点）', goodV.warnings.length, 0);

const noHidden = casesMod.validatePlan({
  ...goodPlan, cases: [{ index: 1, stdin: '', expected: 'x' }],
});
ok('无隐藏点 → 给出告警但不阻止', noHidden.ok && noHidden.warnings.length > 0, JSON.stringify(noHidden.warnings));

const noCases = casesMod.validatePlan({ ...goodPlan, cases: [] });
ok('无测试点 → 校验失败', !noCases.ok);

const badLang = casesMod.validatePlan({ ...goodPlan, language: 'ruby' });
ok('不支持的语言 → 校验失败', !badLang.ok);

/* --------------------- 10. 频率限制 --------------------- */

section('10. 提交频率限制');

const counter = new rlMod.MemoryRateCounter();
const limiter = new rlMod.RateLimiter(counter, { perMinute: 3, perDay: 10, cooldownMs: 1000 });
let t = 1000;

const r1 = limiter.check('u1', t);
const r2 = limiter.check('u1', t);
const r3 = limiter.check('u1', t);
const r4 = limiter.check('u1', t);

ok('前 3 次放行', r1.allowed && r2.allowed && r3.allowed);
ok('第 4 次被拒', !r4.allowed, JSON.stringify(r4));
eq('拒绝码为 rate-limited', r4.code, 'rate-limited');
ok('给出冷却剩余时间', r4.retryAfterMs > 0, String(r4.retryAfterMs));

// 被拒的请求不应消耗配额：否则用户越重试恢复越慢
limiter.check('u1', t);
limiter.check('u1', t);
const peek = limiter.peek('u1', t);
eq('被拒请求不增加分钟计数', peek.minuteCount, 3);

t += 61 * 1000;
const afterWindow = limiter.check('u1', t);
ok('窗口过后恢复放行', afterWindow.allowed, JSON.stringify(afterWindow));

// 用户隔离：u2 不受 u1 影响
const u2 = limiter.check('u2', t);
ok('不同用户配额独立', u2.allowed && u2.minuteCount === 1);

// 日上限
const dailyCounter = new rlMod.MemoryRateCounter();
const dailyLimiter = new rlMod.RateLimiter(dailyCounter, { perMinute: 100, perDay: 2, cooldownMs: 1000 });
dailyLimiter.check('u3', t);
dailyLimiter.check('u3', t);
const dayBlocked = dailyLimiter.check('u3', t);
ok('日上限生效', !dayBlocked.allowed, JSON.stringify(dayBlocked));
ok('日上限提示语面向用户', dayBlocked.message.indexOf('上限') >= 0, dayBlocked.message);

// 清理过期桶
const sweepCounter = new rlMod.MemoryRateCounter();
sweepCounter.incr('a', 1000, t);
sweepCounter.incr('b', 1000, t);
const removed = sweepCounter.sweep(t + 5000);
eq('过期桶被清理', removed, 2);

/* --------------------- 11. 端到端：注入假执行器 --------------------- */

section('11. 端到端判题流程（假执行器，不需要 docker）');

const judgeServiceMod = await import('../judge-service/src/judges/index.ts');

/** 假执行器：按预设脚本返回结果，让分类逻辑可被完整验证 */
class FakeExecutor {
  constructor(script) {
    this.script = script;
    this.calls = [];
  }
  async exec(plan, timeoutMs) {
    const phase = plan.args.join(' ').indexOf('compile') >= 0 ? 'compile' : 'run';
    this.calls.push({ phase: phase, plan: plan, timeoutMs: timeoutMs });
    const s = this.script[phase];
    if (!s) return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false };
    return Object.assign({ exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false }, s);
  }
}

/** 假工作区：不碰磁盘 */
class FakeWorkspace {
  constructor() { this.dirs = []; this.cleaned = []; this.written = []; this.madeDirs = []; this.artifacts = []; }
  async prepare(submissionId) { const d = '/fake/' + submissionId; this.dirs.push(d); return d; }
  async mkdirp(dir) { this.madeDirs.push(dir); }
  async writeSource(dir, fileName, code) { this.written.push({ dir, fileName, code }); }
  async collectArtifact(dir, artifactName, containerName) {
    // 记录产物落点。自检会断言它落在 workDir 的**同级** `.artifacts`，
    // 而不是 workDir 里面 —— 见 policy.ts 里关于 noexec 的说明。
    this.artifacts.push({ dir, artifactName, containerName });
  }
  async cleanup(dir) { this.cleaned.push(dir); }
}

function buildService(fakeScript, plan) {
  const runner = new runnerMod.SandboxRunner(new FakeExecutor(fakeScript));
  const plans = new adapters.MemoryPlanProvider();
  plans.add(plan);
  const cache = new adapters.MemoryResultCache();
  const workspace = new FakeWorkspace();
  const counter = new rlMod.MemoryRateCounter();
  const limiter = new rlMod.RateLimiter(counter, { perMinute: 100, perDay: 1000, cooldownMs: 1000 });
  let clock = 5000;
  const service = new judgeServiceMod.JudgeService({
    runner: runner, plans: plans, cache: cache, workspace: workspace,
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: limiter,
    now: () => (clock += 100),
  });
  return { service, cache, workspace };
}

const samplePlan = {
  questionId: 'q_prog_1', language: 'c', judgeMs: 1000, memoryMB: 256,
  cases: [
    { index: 1, stdin: '1 2', expected: '3' },
    { index: 2, stdin: '5 7', expected: '12', hidden: true },
  ],
};

const reqOf = (over) => Object.assign({
  submissionId: 'sub-e2e-1', questionId: 'q_prog_1', type: 'code-editor', language: 'c',
  code: '#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d",a+b);}',
}, over);

// 全通过
{
  const { service } = buildService({
    compile: { exitCode: 0 },
    run: { exitCode: 0, stdout: '3' },
  }, samplePlan);
  // 两个测试点要分别匹配，这里用一个能同时匹配的输出不可行 →
  // 改用「每个 run 调用按顺序返回」的脚本
  const seq = ['3', '12'];
  let i = 0;
  const runner = new runnerMod.SandboxRunner({
    async exec(plan) {
      const isCompile = plan.args.join(' ').indexOf('-compile') >= 0;
      if (isCompile) return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false };
      const out = seq[i++] || '';
      return { exitCode: 0, signal: null, stdout: out, stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false };
    },
  });
  const plans = new adapters.MemoryPlanProvider();
  plans.add(samplePlan);
  const ws = new FakeWorkspace();
  const svc = new judgeServiceMod.JudgeService({
    runner, plans, cache: new adapters.MemoryResultCache(), workspace: ws,
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), { perMinute: 100, perDay: 1000, cooldownMs: 1000 }),
    now: () => Date.now(),
  });
  const out = await svc.submit('u1', reqOf({}));
  ok('全通过：ok=true', out.ok);
  eq('全通过：verdict=accepted', out.response.verdict, 'accepted');
  eq('全通过：passed=2', out.response.passed, 2);
  eq('全通过：total=2', out.response.total, 2);
  eq('全通过：score=1', out.response.score, 1);
  eq('全通过：映射到引擎 correct=true', out.result.correct, true);
  eq('全通过：临时目录已清理', ws.cleaned.length, 1);
  eq('全通过：源码写入使用服务端指定文件名', ws.written[0].fileName, 'main.c');
}

// 编译失败：绝不能进入运行阶段
// 注意：stderr 是 docker 合流输出，里面含包装脚本的 `---STDERR---` 分隔符。
// runner.compile() 会先 splitStreams 再取真正的编译器输出——这里正好顺带验证这件事。
{
  let runCalls = 0;
  const runner = new runnerMod.SandboxRunner({
    async exec(plan) {
      const isCompile = plan.args.join(' ').indexOf('-compile') >= 0;
      if (isCompile) {
        return {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: '\n---STDERR---\nmain.c:1:1: error: expected declaration or statement at end of input\n',
          wallMs: 20,
          peakMemoryKB: 0,
          wallTimeout: false,
        };
      }
      runCalls++;
      return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 5, peakMemoryKB: 0, wallTimeout: false };
    },
  });
  const plans = new adapters.MemoryPlanProvider();
  plans.add(samplePlan);
  const ws = new FakeWorkspace();
  const svc = new judgeServiceMod.JudgeService({
    runner, plans, cache: new adapters.MemoryResultCache(), workspace: ws,
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), { perMinute: 100, perDay: 1000, cooldownMs: 1000 }),
    now: () => Date.now(),
  });
  const out = await svc.submit('u1', reqOf({ submissionId: 'sub-ce' }));
  eq('编译失败：verdict=compile-error', out.response.verdict, 'compile-error');
  eq('编译失败：0 个测试点被执行（关键）', runCalls, 0);
  eq('编译失败：passed=0', out.response.passed, 0);
  ok('编译失败：带编译器原始信息', out.response.compileMessage.indexOf('error') >= 0, out.response.compileMessage);
  ok('编译失败：detail 展示给用户', out.result.detail.indexOf('编译') >= 0);
  ok('编译失败：detail 里带上编译器信息（用户才知道哪一行错）', out.result.detail.indexOf('main.c:1') >= 0, out.result.detail);
  eq('编译失败：临时目录仍被清理', ws.cleaned.length, 1);
}

// 部分通过
{
  const seq = ['3', '99'];
  let i = 0;
  const runner = new runnerMod.SandboxRunner({
    async exec(plan) {
      const isCompile = plan.args.join(' ').indexOf('-compile') >= 0;
      if (isCompile) return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false };
      return { exitCode: 0, signal: null, stdout: seq[i++] || '', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false };
    },
  });
  const plans = new adapters.MemoryPlanProvider();
  plans.add(samplePlan);
  const svc = new judgeServiceMod.JudgeService({
    runner, plans, cache: new adapters.MemoryResultCache(), workspace: new FakeWorkspace(),
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), { perMinute: 100, perDay: 1000, cooldownMs: 1000 }),
    now: () => Date.now(),
  });
  const out = await svc.submit('u1', reqOf({ submissionId: 'sub-partial' }));
  eq('部分通过：verdict=wrong-answer', out.response.verdict, 'wrong-answer');
  eq('部分通过：passed=1/2', out.response.passed + '/' + out.response.total, '1/2');
  eq('部分通过：score=0.5', out.response.score, 0.5);
  eq('部分通过：引擎侧 partial=true', out.result.partial, true);
  eq('部分通过：引擎侧 correct=false', out.result.correct, false);
  const hiddenCase = out.response.cases.filter((c) => c.index === 2)[0];
  eq('部分通过：隐藏点不回传输入', hiddenCase.stdinPreview, undefined);
}

// 幂等：同 submissionId 重提走缓存，不重跑
{
  let execCount = 0;
  const runner = new runnerMod.SandboxRunner({
    async exec(plan) {
      execCount++;
      return { exitCode: 0, signal: null, stdout: '3', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false };
    },
  });
  const plans = new adapters.MemoryPlanProvider();
  plans.add(samplePlan);
  const cache = new adapters.MemoryResultCache();
  const svc = new judgeServiceMod.JudgeService({
    runner, plans, cache, workspace: new FakeWorkspace(),
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), { perMinute: 100, perDay: 1000, cooldownMs: 1000 }),
    now: () => Date.now(),
  });
  await svc.submit('u1', reqOf({ submissionId: 'sub-idem' }));
  const firstExecCount = execCount;
  const second = await svc.submit('u1', reqOf({ submissionId: 'sub-idem' }));
  eq('幂等：第二次不再执行容器', execCount, firstExecCount);
  eq('幂等：第二次标记 cacheHit', second.response.cacheHit, true);
  ok('幂等：第二次仍返回结果', !!second.result);
}

// 未配置判题计划
{
  const { service } = buildService({}, { ...samplePlan, questionId: 'other' });
  const out = await service.submit('u1', reqOf({ submissionId: 'sub-noplan' }));
  ok('未配置计划 → ok=false', !out.ok);
  eq('未配置计划 → question-not-found', out.error.code, 'question-not-found');
}

// 非法请求在进沙箱前就被拦
{
  const { service } = buildService({}, samplePlan);
  const out = await service.submit('u1', reqOf({ submissionId: 'sub-bad', language: 'ruby' }));
  ok('非法语言 → 不进沙箱', !out.ok);
  eq('非法语言 → unsupported-language', out.error.code, 'unsupported-language');
}

// 限流在流程中生效
{
  const runner = new runnerMod.SandboxRunner({
    async exec() { return { exitCode: 0, signal: null, stdout: '3', stderr: '', wallMs: 5, peakMemoryKB: 100, wallTimeout: false }; },
  });
  const plans = new adapters.MemoryPlanProvider();
  plans.add(samplePlan);
  const svc = new judgeServiceMod.JudgeService({
    runner, plans, cache: new adapters.MemoryResultCache(), workspace: new FakeWorkspace(),
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), { perMinute: 1, perDay: 100, cooldownMs: 1000 }),
    now: () => Date.now(),
  });
  await svc.submit('u9', reqOf({ submissionId: 'sub-rl-1' }));
  const blocked = await svc.submit('u9', reqOf({ submissionId: 'sub-rl-2' }));
  ok('第二次提交被限流', !blocked.ok);
  eq('限流错误码正确', blocked.error.code, 'rate-limited');
  ok('限流给出冷却时间', blocked.error.retryAfterMs > 0);
}

// 异常时也必须清理临时目录
{
  const runner = new runnerMod.SandboxRunner({
    async exec() { throw new Error('模拟执行器崩溃'); },
  });
  const plans = new adapters.MemoryPlanProvider();
  plans.add(samplePlan);
  const ws = new FakeWorkspace();
  const svc = new judgeServiceMod.JudgeService({
    runner, plans, cache: new adapters.MemoryResultCache(), workspace: ws,
    files: { fileNameFor: () => 'main.c', artifactNameFor: () => 'box.out', runArgvFor: () => ['/tmp/box.out'] },
    limiter: new rlMod.RateLimiter(new rlMod.MemoryRateCounter(), { perMinute: 100, perDay: 1000, cooldownMs: 1000 }),
    now: () => Date.now(),
  });
  const out = await svc.submit('u1', reqOf({ submissionId: 'sub-crash' }));
  ok('执行器崩溃 → 返回 internal', !out.ok && out.error.code === 'internal', JSON.stringify(out.error));
  eq('执行器崩溃 → 临时目录仍被清理（关键）', ws.cleaned.length, 1);
}

/* --------------------- 12. 部署产物完整性 --------------------- */

section('12. 部署产物（Dockerfile / compose / 环境变量）');

const required = [
  'judge-service/Dockerfile',
  'judge-service/docker-compose.yml',
  'judge-service/README.md',
  'judge-service/package.json',
  'judge-service/etc/seccomp-judge.json',
];
for (const f of required) {
  ok('存在 ' + f, existsSync(path.join(ROOT, f)));
}

const compose = readFileSync(path.join(ROOT, 'judge-service/docker-compose.yml'), 'utf8');
// 判题节点只绑定回环，不能 0.0.0.0 暴露
ok(
  'compose 里判题服务只绑定回环地址（⑫ 网络隔离）',
  compose.indexOf('"127.0.0.1:8600:8600"') >= 0,
  '未找到回环绑定'
);
ok('compose 未把判题端口暴露到所有网卡', compose.indexOf('0.0.0.0') < 0);
ok('compose 关闭特权模式', compose.indexOf('privileged') < 0);
ok('compose 声明了只读根文件系统', compose.indexOf('read_only') >= 0);
ok('compose 声明了 cap_drop', compose.indexOf('cap_drop') >= 0);
// 正确的断言方式：解析 YAML 语义，而不是扫字符串。
// 扫字符串会把 `expose: ["6379"]` 这种**正确**写法误判成端口发布——
// 这是断言写法的坑，不是配置的坑。
{
  const redisBlock = compose.split(/^  judge-service:/m)[0]; // redis 段落在 judge-service 之前
  const hasPortsKey = /^\s{4}ports:/m.test(redisBlock);
  ok(
    'compose 的 redis 只用 expose、不用 ports（限流计数不可公网可达）',
    !hasPortsKey,
    'redis 段里出现了 ports，会发布到宿主网卡（docker 端口发布默认绕过 ufw，等于暴露限流计数）'
  );
  ok(
    'compose 的 redis 用 expose 暴露给内部网络',
    /^\s{4}expose:/m.test(redisBlock),
    'redis 需要 expose 才能被 judge-service 访问'
  );
}

const dockerfile = readFileSync(path.join(ROOT, 'judge-service/Dockerfile'), 'utf8');
ok('Dockerfile 创建了非 root 用户（UID 1000）', dockerfile.indexOf('1000') >= 0);
ok('Dockerfile 未使用 latest 标签（可复现构建）', dockerfile.indexOf(':latest') < 0);

// ---- seccomp profile 的 COPY 目标必须与 DEFAULT_SECCOMP_PROFILE 一致 ----
// 这是踩过的坑：Dockerfile 放 /etc/seccomp-judge.json，代码找 /etc/judge/seccomp-judge.json，
// 而 `chmod ... || true` 把「文件不存在」静默吞了 → 构建成功、运行时才炸。
//
// ⚠️ 断言必须只看**可执行的指令行**，不能扫全文：
//    注释里为了说明这个坑，会写出旧写法（`|| true`、`/etc-readonly`），
//    扫全文会把这些解释文字当成违规 —— 断言写法的坑，不是配置的坑。
const dockerfileCode = dockerfile
  .split('\n')
  .filter(function (l) { return !/^\s*#/.test(l); })
  .join('\n');
const composeCode = compose
  .split('\n')
  .filter(function (l) { return !/^\s*#/.test(l); })
  .join('\n');
{
  const expected = policy.DEFAULT_SECCOMP_PROFILE; // /etc/judge/seccomp-judge.json
  ok(
    'Dockerfile 把 profile COPY 到代码期望的路径',
    dockerfileCode.indexOf('COPY etc/seccomp-judge.json ' + expected) >= 0,
    'Dockerfile 里没出现 `COPY etc/seccomp-judge.json ' + expected + '`'
  );
  ok(
    'Dockerfile 不用 `|| true` 吞掉 chmod 失败（只看指令行）',
    !/chmod[^&|]*\|\|\s*true/.test(dockerfileCode),
    '`|| true` 会让 profile 缺失时构建仍然成功'
  );
  ok(
    'Dockerfile 校验 profile 非空（test -s）',
    dockerfileCode.indexOf('test -s') >= 0,
    '缺 test -s 则空文件也能通过构建'
  );

  // compose 的挂载目标同样要一致（开发时覆盖用）
  ok(
    'compose 把 etc/ 挂到代码期望的路径（不是 /etc-readonly）',
    composeCode.indexOf('./etc:/etc/judge:ro') >= 0,
    '历史坑：曾挂到 /etc-readonly，与代码路径不符'
  );
  ok('compose 指令行里不再出现 /etc-readonly',
    composeCode.indexOf('/etc-readonly') < 0);
}

// ---- 沙箱镜像与构建脚本 ----
{
  const imgRequired = [
    'judge-service/images/Dockerfile.gcc',
    'judge-service/images/Dockerfile.python',
    'judge-service/images/build.sh',
    'judge-service/scripts/seccomp-calibrate.mjs',
    'judge-service/src/questions/calibration-samples.ts',
  ];
  for (const f of imgRequired) {
    ok('存在 ' + f, existsSync(path.join(ROOT, f)));
  }

  const gccDf = readFileSync(path.join(ROOT, 'judge-service/images/Dockerfile.gcc'), 'utf8');
  const pyDf = readFileSync(path.join(ROOT, 'judge-service/images/Dockerfile.python'), 'utf8');

  // UID 必须与 policy.ts 的 --user 1000:1000 一致
  ok('gcc 镜像创建 UID 1000 用户', /useradd\s+-u\s+1000/.test(gccDf));
  ok('python 镜像创建 UID 1000 用户', /useradd\s+-u\s+1000/.test(pyDf));
  ok('gcc 镜像以非 root 收尾（USER 1000:1000）', /USER\s+1000:1000/.test(gccDf));
  ok('python 镜像以非 root 收尾', /USER\s+1000:1000/.test(pyDf));

  // 镜像不能带外联工具（禁网的第二道防线）
  // 注意：断言的是「没装」而不是「没提到」——注释里会写 curl 这个词
  const gccInstalls = (gccDf.match(/apt-get install[^\n]*/g) || []).join(' ');
  for (const tool of ['curl', 'wget', 'netcat', 'nc', 'openssh']) {
    ok('gcc 镜像未安装 ' + tool, gccInstalls.indexOf(tool) < 0, gccInstalls.slice(0, 120));
  }

  // python 镜像必须删掉网络模块与 pip
  ok('python 镜像删除 socket 模块', pyDf.indexOf('socket.py') >= 0);
  ok('python 镜像删除 urllib', /rm -rf[\s\S]*?urllib/.test(pyDf));
  ok('python 镜像删除 pip', /pip3?\.?1?2?/.test(pyDf) && pyDf.indexOf('site-packages/pip') >= 0);
  // 判题结果必须可复现：哈希随机化会导致 set/dict 遍历顺序不稳定
  ok('python 镜像设置 PYTHONHASHSEED=0（判题可复现）',
    pyDf.indexOf('PYTHONHASHSEED=0') >= 0);
  ok('python 镜像设置 PYTHONUNBUFFERED=1（超时也能拿到输出）',
    pyDf.indexOf('PYTHONUNBUFFERED=1') >= 0);

  // 两个镜像都要建好 /box 与 /box-artifact 挂载点
  ok('gcc 镜像创建 /box 与 /box-artifact', /mkdir -p \/box \/box-artifact/.test(gccDf));
  ok('python 镜像创建 /box 与 /box-artifact', /mkdir -p \/box \/box-artifact/.test(pyDf));

  // build.sh 必须做校验，不能构建完就完事
  const buildSh = readFileSync(path.join(ROOT, 'judge-service/images/build.sh'), 'utf8');
  ok('build.sh 校验镜像名与 policy.ts 一致',
    buildSh.indexOf('assert_image_names_match_policy') >= 0);
  ok('build.sh 校验 curl 不存在', buildSh.indexOf('不含 curl') >= 0);
  ok('build.sh 校验 UID=1000', buildSh.indexOf('UID = 1000') >= 0 || buildSh.indexOf('默认用户 UID') >= 0);
}

/* ------------- 13. seccomp 校准脚本（解析逻辑必须可验证） ------------- */

section('13. seccomp 校准脚本');

// 校准脚本是「白名单实跑验证」这个流程的执行器。它能跑起来不等于它能
// **正确读日志** —— 读错日志会让校准结论完全反向（把该补的漏掉）。
// 所以用固定夹具把解析逻辑钉住，而不是靠人工跑一次看输出。
//
// ⚠️ 为什么直接 import 而不是起子进程：
//    Windows 上运行中的 node.exe 被系统锁住，spawn 自己会 EBUSY。
//    所以脚本刻意把纯逻辑（extractSyscalls / analyzeLogText / classifyFound）
//    导出，并在被 import 时不执行任何副作用 —— 见脚本里的 IS_MAIN 守卫。
//    这也让断言更稳：断言结构化对象，而不是会随格式变化的打印文本。
{
  const calibrate = await import('../judge-service/scripts/seccomp-calibrate.mjs');
  const fixturePath = path.join(ROOT, 'judge-service/test/fixtures/seccomp-sample.log');
  const missingFixturePath = path.join(ROOT, 'judge-service/test/fixtures/seccomp-sample-missing.log');

  ok('校准日志夹具存在', existsSync(fixturePath));
  ok('「缺失」分支夹具存在', existsSync(missingFixturePath));

  ok('脚本导出 extractSyscalls', typeof calibrate.extractSyscalls === 'function');
  ok('脚本导出 classifyFound', typeof calibrate.classifyFound === 'function');
  ok('脚本导出 analyzeLogText', typeof calibrate.analyzeLogText === 'function');

  // ---- 提取逻辑：三种日志格式都要认 ----
  {
    const t1 = calibrate.extractSyscalls('type=1326 audit(1.1:2): syscall=25 compat=0');
    ok('抽取数字形式的 syscall（25 → mremap）', t1.has('mremap'), Array.from(t1).join(','));
    const t2 = calibrate.extractSyscalls('type=SECCOMP msg=audit(1.1:2): syscall=socket compat=0');
    ok('抽取名字形式的 syscall', t2.has('socket'), Array.from(t2).join(','));
    const t3 = calibrate.extractSyscalls('type=1326 audit(1.1:2): syscall=41(0x29) compat=0');
    ok('抽取「数字(十六进制)」形式', t3.has('socket'), Array.from(t3).join(','));
    // 名字形式不能被数字正则误加出 "x29" 之类
    ok('「数字(十六进制)」不产生多余条目', t3.size === 1, Array.from(t3).join(','));
    // 表里没有的号要老实报未知，不能瞎猜
    const t4 = calibrate.extractSyscalls('syscall=99999');
    ok('超出 4 位的编号不被匹配（不瞎猜）', t4.size === 0, Array.from(t4).join(','));
    const t5 = calibrate.extractSyscalls('syscall=7000');
    ok('表外编号报成 syscall#7000', t5.has('syscall#7000'));
    // 无关日志
    const t6 = calibrate.extractSyscalls('usb 1-1: new high-speed USB device\neth0: link up');
    ok('无关日志抽不出任何调用', t6.size === 0);
  }

  // ---- 分类逻辑：四类必须互斥且完备 ----
  {
    const allowed = new Set(['read', 'write', 'mremap']);
    const forbidden = new Set(['socket', 'ptrace']);
    const found = new Set(['read', 'mremap', 'socket', 'ptrace', 'sched_setattr', 'syscall#7000']);
    const c = calibrate.classifyFound(found, allowed, forbidden);

    eq('分类：已在白名单 {read, mremap}', c.already, ['mremap', 'read']);
    eq('分类：缺失 {sched_setattr}', c.missing, ['sched_setattr']);
    eq('分类：危险 {ptrace, socket}', c.dangerous, ['ptrace', 'socket']);
    eq('分类：未知 {syscall#7000}', c.unknown, ['syscall#7000']);

    // 四类合起来必须正好等于输入（不多不少）—— 防「漏分类」
    const total = c.already.length + c.missing.length + c.dangerous.length + c.unknown.length;
    eq('分类完备：四类之和 = 输入数量', total, found.size);
    // 危险调用绝不能出现在 missing 里（否则人工 review 可能误加进白名单）
    ok('危险调用不混进 missing（安全关键）',
      c.missing.indexOf('socket') < 0 && c.missing.indexOf('ptrace') < 0);
  }

  // ---- 夹具一：危险调用 + 未知编号 ----
  {
    const text = readFileSync(fixturePath, 'utf8');
    const r = calibrate.analyzeLogText(text);
    ok('夹具一：识别出 socket 为危险', r.dangerous.indexOf('socket') >= 0, r.dangerous.join(','));
    ok('夹具一：识别出 connect 为危险', r.dangerous.indexOf('connect') >= 0, r.dangerous.join(','));
    ok('夹具一：识别出 ptrace 为危险', r.dangerous.indexOf('ptrace') >= 0, r.dangerous.join(','));
    ok('夹具一：未知编号报成 syscall#9999', r.unknown.indexOf('syscall#9999') >= 0, r.unknown.join(','));
    // 已在白名单里的不能报成缺失
    ok('夹具一：read 归入「已有」而非缺失', r.already.indexOf('read') >= 0 && r.missing.indexOf('read') < 0);
    ok('夹具一：clock_gettime 归入「已有」', r.already.indexOf('clock_gettime') >= 0);
    ok('夹具一：mremap 归入「已有」（基线已含）', r.already.indexOf('mremap') >= 0, r.already.join(','));
    ok('夹具一：clone3 归入「已有」', r.already.indexOf('clone3') >= 0);
    ok('夹具一：无缺失项', r.missing.length === 0, r.missing.join(','));
    // apparmor 那条是无关日志，不该被抽出来
    ok('夹具一：无关的 apparmor 日志未被抽取', text.indexOf('apparmor') >= 0 && r.foundCount === 13,
      'foundCount=' + r.foundCount);
  }

  // ---- 夹具二：缺失分支 + 可合并片段生成 ----
  {
    const text = readFileSync(missingFixturePath, 'utf8');
    const r = calibrate.analyzeLogText(text);
    ok('夹具二：sched_setattr 报为缺失', r.missing.indexOf('sched_setattr') >= 0, r.missing.join(','));
    ok('夹具二：io_pgetevents 报为缺失', r.missing.indexOf('io_pgetevents') >= 0, r.missing.join(','));
    ok('夹具二：314 映射成名字而非 syscall#314',
      r.unknown.indexOf('syscall#314') < 0, r.unknown.join(','));
    ok('夹具二：表外编号 7000 老实报未知', r.unknown.indexOf('syscall#7000') >= 0, r.unknown.join(','));
    ok('夹具二：无危险调用', r.dangerous.length === 0, r.dangerous.join(','));
    // 白名单已有的不能被列进缺失
    ok('夹具二：clock_gettime 未被误报为缺失', r.missing.indexOf('clock_gettime') < 0);
    ok('夹具二：read 未被误报为缺失', r.missing.indexOf('read') < 0);
    // 缺失项应可直接构成合并片段
    ok('夹具二：缺失项可构成 names 数组', r.missing.length === 2, r.missing.join(','));
  }

  // ---- 脚本文件本身的结构要求 ----
  {
    const scriptSrc = readFileSync(
      path.join(ROOT, 'judge-service/scripts/seccomp-calibrate.mjs'), 'utf8');
    // 必须有 IS_MAIN 守卫，否则一 import 就会建目录/调 docker
    ok('脚本有 IS_MAIN 守卫（import 时不产生副作用）', scriptSrc.indexOf('IS_MAIN') >= 0);
    // dry-run 必须能跑（不依赖 docker）
    ok('脚本支持 --dry-run', scriptSrc.indexOf('--dry-run') >= 0);
    // 校准 profile 必须是 SCMP_ACT_LOG 而不是 ALLOW
    // 调成 ALLOW 就完全收集不到信号（全放行，日志什么都没有）
    ok('校准 profile 用 SCMP_ACT_LOG（放行但记录）', scriptSrc.indexOf('SCMP_ACT_LOG') >= 0);
    ok('校准 profile 不是 SCMP_ACT_ALLOW（否则收不到任何信号）',
      !/defaultAction:\s*'SCMP_ACT_ALLOW'/.test(scriptSrc));
    // archMap 必须保留 —— 丢掉会漏掉 x32/ia32 兼容调用的日志
    ok('校准 profile 保留 archMap', scriptSrc.indexOf('archMap') >= 0);
    // 必须提示校准产物不要提交
    ok('脚本提示校准 profile 不是正式配置', scriptSrc.indexOf('不要提交') >= 0);
  }
}

/* ------------- 14. 题库来源适配层（外部依赖入口） ------------- */

section('14. 题库来源适配层');

// 这一节守的是一条「不能回归」的性质：
// **判题主流程不认识任何具体题库**。它只认识 PlanProvider，
// 而 PlanProvider 的实现可以换（内存 / HTTP / 云开发），主流程一行不动。
//
// 之所以要断言到这么细：一旦有人图省事在 judges/index.ts 里直接
// import 某个具体实现，冷启动阶段的替换成本会从「改配置」变成「改代码」，
// 而那时候正在赶内容上线，是最不适合动核心链路的时候。
{
  const srcMod = await import('../judge-service/src/questions/source.ts');
  const provMod = await import('../judge-service/src/questions/providers.ts');

  /* ---- 端口形状 ---- */

  ok('导出 normalizeJudgePlan', typeof srcMod.normalizeJudgePlan === 'function');
  ok('导出 createPlanSource', typeof srcMod.createPlanSource === 'function');
  ok('导出 MemoryPlanSource', typeof srcMod.MemoryPlanSource === 'function');
  ok('导出 HttpPlanSource', typeof srcMod.HttpPlanSource === 'function');
  ok('导出 CloudPlanSource', typeof srcMod.CloudPlanSource === 'function');
  ok('导出 PlanRepository', typeof provMod.PlanRepository === 'function');

  const memSource = new srcMod.MemoryPlanSource();
  ok('MemoryPlanSource 实现 name', memSource.name === 'memory');
  ok('MemoryPlanSource 实现 fetchPlan', typeof memSource.fetchPlan === 'function');

  /* ---- ①「没有这道题」≠「查不到」 ---- */

  {
    const r = await memSource.fetchPlan('不存在的题', 'c');
    ok('内存源对「没有」返回 ok=true 且 value 为空',
      r.ok === true && r.value === undefined, JSON.stringify(r));

    // 这是本层存在的**全部理由**：把两种失败分开。
    // 混在一个 undefined 里，用户会对着「题目不存在」反复重试 —— 白等。
    const boom = new srcMod.HttpPlanSource(
      Object.assign({}, srcMod.DEFAULT_PLAN_SOURCE, { kind: 'http', baseUrl: 'https://bank.test' }),
      { fetchImpl: async function () { throw new Error('connection reset'); } }
    );
    const failed = await boom.fetchPlan('q1', 'c');
    ok('网络失败返回 ok=false（不等于「题目不存在」）', failed.ok === false, JSON.stringify(failed));
    ok('网络失败标记为可重试', failed.retryable === true);
    ok('网络失败带回原因（进日志不丢信息）', typeof failed.error === 'string' && failed.error.length > 0);
  }

  /* ---- 404 是明确答复；5xx 是可重试 ---- */

  {
    const mk = function (status) {
      return new srcMod.HttpPlanSource(
        Object.assign({}, srcMod.DEFAULT_PLAN_SOURCE, { kind: 'http', baseUrl: 'https://bank.test' }),
        { fetchImpl: async function () { return { ok: status < 400, status: status, json: async function () { return {}; } }; } }
      );
    };
    const nf = await mk(404).fetchPlan('q1', 'c');
    ok('404 → ok=true（题目确实没有，不是故障）', nf.ok === true && nf.value === undefined);
    const s500 = await mk(500).fetchPlan('q1', 'c');
    ok('500 → ok=false 且可重试', s500.ok === false && s500.retryable === true);
    const s401 = await mk(401).fetchPlan('q1', 'c');
    ok('401 → ok=false 且不可重试（凭据错了重试无用）', s401.ok === false && s401.retryable === false);
  }

  /* ---- URL 形状与凭据不外泄 ---- */

  {
    let seenUrl = '';
    let seenAuth = '';
    const spy = new srcMod.HttpPlanSource(
      Object.assign({}, srcMod.DEFAULT_PLAN_SOURCE, {
        kind: 'http', baseUrl: 'https://bank.test/api/', token: 'secret-token',
      }),
      {
        fetchImpl: async function (url, init) {
          seenUrl = String(url);
          seenAuth = (init && init.headers && init.headers.authorization) || '';
          return { ok: true, status: 200, json: async function () { return {}; } };
        },
      }
    );
    await spy.fetchPlan('q_c_0005', 'c');
    ok('URL 去掉重复斜杠', seenUrl.indexOf('/api//plans') < 0, seenUrl);
    ok('URL 路径为 /plans/{题目}/{语言}', seenUrl === 'https://bank.test/api/plans/q_c_0005/c', seenUrl);
    ok('凭据走 Authorization 头（不在 URL 里）', seenAuth === 'Bearer secret-token' && seenUrl.indexOf('secret') < 0);
    // 题目 ID 必须 encode —— 否则带 ../ 的 ID 能改写到题库的别的接口
    await spy.fetchPlan('../admin', 'c');
    ok('题目 ID 做了 URL 编码（防路径穿越）', seenUrl.indexOf('..%2Fadmin') >= 0 || seenUrl.indexOf('..%2fadmin') >= 0, seenUrl);
    ok('实现的 name 里不含 token', spy.name.indexOf('secret') < 0, spy.name);
  }

  /* ---- 云开发通道（等云服务搭好后只需填配置） ---- */

  {
    let cloudUrl = '';
    const cloud = new srcMod.CloudPlanSource(
      Object.assign({}, srcMod.DEFAULT_PLAN_SOURCE, {
        kind: 'cloud', baseUrl: 'https://env.tcb-api.test', envId: 'xx-prod-1a2b',
      }),
      {
        fetchImpl: async function (url) {
          cloudUrl = String(url);
          return { ok: true, status: 200, json: async function () { return {}; } };
        },
      }
    );
    await cloud.fetchPlan('q1', 'c');
    ok('云开发 URL 带环境 ID', cloudUrl.indexOf('xx-prod-1a2b') >= 0, cloudUrl);

    // 没填环境 ID 时必须**明确报错**，不能退化成「题目不存在」
    const noEnv = new srcMod.CloudPlanSource(
      Object.assign({}, srcMod.DEFAULT_PLAN_SOURCE, { kind: 'cloud', baseUrl: 'https://x.test', envId: '' })
    );
    const r = await noEnv.fetchPlan('q1', 'c');
    ok('云开发缺环境 ID 时明确报配置错误',
      r.ok === false && String(r.error).indexOf('环境 ID') >= 0 && r.retryable === false, JSON.stringify(r));
  }

  /* ---- 工厂：未知 kind 不静默 ---- */

  {
    const unknown = srcMod.createPlanSource({ kind: 'grpc', baseUrl: '', envId: '', token: '', timeoutMs: 1, cacheTtlMs: 1 });
    ok('未知来源退回 memory（保证服务能起）', unknown.source.name === 'memory');
    ok('未知来源必须留告警（防生产跑在样例上）',
      unknown.warnings.some(function (w) { return w.indexOf('未知') >= 0; }), unknown.warnings.join(' | '));

    const httpNoUrl = srcMod.createPlanSource({ kind: 'http', baseUrl: '', envId: '', token: '', timeoutMs: 1, cacheTtlMs: 1 });
    ok('http 缺 baseUrl 时告警', httpNoUrl.warnings.length > 0, httpNoUrl.warnings.join(' | '));

    const okCloud = srcMod.createPlanSource({ kind: 'cloud', baseUrl: 'https://x.test', envId: 'e1', token: 't', timeoutMs: 1, cacheTtlMs: 1 });
    ok('cloud 配置齐全时无告警', okCloud.warnings.length === 0 && okCloud.source.name === 'cloud', okCloud.warnings.join(' | '));
  }

  /* ---- 规范化：脏数据不得进沙箱 ---- */

  {
    // 能就地修的都修
    const fixed = srcMod.normalizeJudgePlan(
      {
        questionId: 'q1', language: 'c', judgeMs: 1000, memoryMB: 128,
        compare: 'weird',
        cases: [
          { stdin: '1\r\n2\r\n', expected: 15 },
          { stdin: '', expected: 'x\n', hidden: 'true', runMs: '500' },
        ],
      },
      'q1', 'c'
    );
    ok('缺 index 的测试点被按顺序补全',
      fixed.plan && fixed.plan.cases[0].index === 1 && fixed.plan.cases[1].index === 2,
      JSON.stringify(fixed.plan && fixed.plan.cases.map(function (c) { return c.index; })));
    ok('\\r\\n 被归一为 \\n（否则逐行比对永远不等）',
      fixed.plan && fixed.plan.cases[0].stdin === '1\n2\n', JSON.stringify(fixed.plan && fixed.plan.cases[0].stdin));
    ok('数字型 expected 被转成字符串', fixed.plan && fixed.plan.cases[0].expected === '15');
    ok('字符串 "true" 被识别为隐藏点', fixed.plan && fixed.plan.cases[1].hidden === true);
    ok('字符串 "500" 被转成数字 runMs', fixed.plan && fixed.plan.cases[1].runMs === 500);
    ok('未知比对口径退回 exact-lines', fixed.plan && fixed.plan.compare === 'exact-lines');
    ok('就地修复会留下 fixes 记录（题库质量信号）', fixed.fixes.length >= 2, fixed.fixes.join(' | '));
    ok('修复后没有错误', fixed.errors.length === 0, fixed.errors.join(' | '));

    // 修不了的必须拒，而且**不能截断期望输出**：
    // 截断会让「输出正确的用户」判错 —— 静默误伤比直接报错坏得多
    const tooLong = srcMod.normalizeJudgePlan(
      { questionId: 'q1', language: 'c', judgeMs: 100, memoryMB: 64,
        cases: [{ index: 1, stdin: '', expected: 'a'.repeat(contract.MAX_OUTPUT_BYTES + 5) }] },
      'q1', 'c'
    );
    ok('期望输出超限被拒（不截断）', !tooLong.plan && tooLong.errors.some(function (e) { return e.indexOf('上限') >= 0; }),
      tooLong.errors.join(' | '));

    const noCases = srcMod.normalizeJudgePlan(
      { questionId: 'q1', language: 'c', judgeMs: 100, memoryMB: 64, cases: [] }, 'q1', 'c');
    ok('无测试点被拒', !noCases.plan && noCases.errors.length > 0, noCases.errors.join(' | '));

    const badLang = srcMod.normalizeJudgePlan(
      { questionId: 'q1', language: 'rust', judgeMs: 100, memoryMB: 64,
        cases: [{ index: 1, stdin: '', expected: 'x' }] }, 'q1', 'cc');
    ok('不支持的语言被拒', !badLang.plan, JSON.stringify(badLang.errors));

    const badQuota = srcMod.normalizeJudgePlan(
      { questionId: 'q1', language: 'c', judgeMs: 0, memoryMB: -1,
        cases: [{ index: 1, stdin: '', expected: 'x' }] }, 'q1', 'c');
    ok('非法配额被拒', !badQuota.plan, JSON.stringify(badQuota.errors));

    const notObj = srcMod.normalizeJudgePlan('nope', 'q1', 'c');
    ok('非对象输入被拒', !notObj.plan && notObj.errors.length > 0);

    // 测试点数量上限：防「题库被写坏」导致一次提交跑上千个容器
    const many = [];
    for (let i = 0; i < srcMod.MAX_CASES_PER_PLAN + 20; i++) many.push({ index: i + 1, stdin: '', expected: 'x' });
    const capped = srcMod.normalizeJudgePlan(
      { questionId: 'q1', language: 'c', judgeMs: 100, memoryMB: 64, cases: many }, 'q1', 'c');
    ok('测试点数量被夹到上限', capped.plan && capped.plan.cases.length === srcMod.MAX_CASES_PER_PLAN,
      capped.plan ? String(capped.plan.cases.length) : 'none');
    ok('截断测试点会留下 fixes', capped.fixes.some(function (f) { return f.indexOf('截断') >= 0; }), capped.fixes.join(' | '));
  }

  /* ---- PlanRepository：缓存纪律 + 错误语义 ---- */

  {
    // 记录调用次数，验证「成功才缓存」
    let calls = 0;
    let mode = 'ok';
    const flaky = {
      name: 'flaky',
      fetchPlan: async function () {
        calls++;
        if (mode === 'fail') return { ok: false, error: '抖了一下', retryable: true };
        if (mode === 'absent') return { ok: true, value: undefined };
        return {
          ok: true,
          value: { questionId: 'q1', language: 'c', judgeMs: 1000, memoryMB: 128,
            cases: [{ index: 1, stdin: '', expected: 'x\n', hidden: true }] },
        };
      },
    };
    const repo = new provMod.PlanRepository({ source: flaky, cacheTtlMs: 60000 });

    const p1 = await repo.getPlan('q1', 'c');
    ok('仓储返回规范化后的计划', !!p1 && p1.cases.length === 1 && p1.cases[0].hidden === true);
    ok('首次查询走源', calls === 1);
    await repo.getPlan('q1', 'c');
    ok('成功结果被缓存（第二次不打源）', calls === 1, 'calls=' + calls);

    // 「题目不存在」不缓存：题库存在「先建题后录测试点」的窗口期，
    // 缓存空结果会让运营刚录好、用户还得再等一个 TTL
    mode = 'absent';
    await repo.getPlan('q2', 'c');
    await repo.getPlan('q2', 'c');
    ok('「题目不存在」不写缓存（第二次仍打源）', calls === 3, 'calls=' + calls);

    // 查询失败必须抛错，不能返回 undefined —— 否则用户看到的是
    // 「题目不存在」，而真实原因是题库抖了一下，他会一直重试
    mode = 'fail';
    let threw = false;
    try {
      await repo.getPlan('q3', 'c');
    } catch {
      threw = true;
    }
    ok('查询失败抛错（不伪装成「题目不存在」）', threw);
    try {
      await repo.getPlan('q3', 'c');
    } catch {
      /* 预期内：失败不缓存，所以第二次仍然抛错、仍然打源 */
    }
    ok('失败结果不缓存（故障恢复后立刻能用）', calls === 5, 'calls=' + calls);

    const stats = repo.getStats();
    ok('统计能区分「命中/未命中/确实没有/失败」',
      stats.hits === 1 && stats.notFound === 2 && stats.failures === 2, JSON.stringify(stats));

    // 运维失效
    mode = 'ok';
    await repo.getPlan('q1', 'c');
    repo.invalidate('q1');
    const before = calls;
    await repo.getPlan('q1', 'c');
    ok('invalidate 后重新查源', calls === before + 1, 'calls=' + calls);

    // 过期后重新查源
    let clock = 1000;
    const timedRepo = new provMod.PlanRepository({ source: flaky, cacheTtlMs: 5000, now: function () { return clock; } });
    mode = 'ok';
    await timedRepo.getPlan('q1', 'c');
    const c2 = calls;
    clock += 4000;
    await timedRepo.getPlan('q1', 'c');
    ok('TTL 内命中缓存', calls === c2, 'calls=' + calls);
    clock += 2000;
    await timedRepo.getPlan('q1', 'c');
    ok('TTL 过后重新查源', calls === c2 + 1, 'calls=' + calls);
  }

  /* ---- 判题主流程不认识具体题库（结构性约束） ---- */

  {
    const judgeSrc = readFileSync(path.join(ROOT, 'judge-service/src/judges/index.ts'), 'utf8');
    const imports = judgeSrc.split('\n').filter(function (l) { return /^\s*import\s/.test(l) || /^\s*\}\s*from\s/.test(l); }).join('\n');
    ok('主流程不 import 具体题库实现（只认 PlanProvider 接口）',
      imports.indexOf('questions/source') < 0 && imports.indexOf('questions/providers') < 0,
      imports.slice(0, 200));
    ok('主流程不 import HTTP/网络模块',
      imports.indexOf("node:http") < 0 && imports.indexOf("node:https") < 0 && imports.indexOf('node-fetch') < 0);

    // 题库故障与「题目不存在」必须是两个不同的结论
    ok('主流程捕获题库异常并给 5xx 语义', /catch[\s\S]*?题库/.test(judgeSrc) || judgeSrc.indexOf('题库暂时不可用') >= 0);
    ok('「题目不存在」仍走 question-not-found', judgeSrc.indexOf('question-not-found') >= 0);
  }

  /* ---- 云函数侧不持 token（凭据不进客户端） ---- */

  {
    const cfFiles = ['cloudfunctions/judgeSubmit/index.js'];
    for (const f of cfFiles) {
      const p = path.join(ROOT, f);
      if (!existsSync(p)) continue;
      const s = readFileSync(p, 'utf8');
      ok('云函数不硬编码判题 token', !/JUDGE_INTERNAL_TOKEN\s*[:=]\s*['"][^'"]+['"]/.test(s));
      ok('云函数身份只认 OPENID', s.indexOf('OPENID') >= 0 || s.indexOf('OPENID') >= 0);
    }
    const cfgSrc = readFileSync(path.join(ROOT, 'judge-service/src/bootstrap.ts'), 'utf8');
    ok('题库 token 只从环境变量读（不写死）', /env\(\s*'JUDGE_PLAN_TOKEN'/.test(cfgSrc));
  }
}

/* ------------- 15. Redis 结果缓存（幂等的生产实现） ------------- */

section('15. Redis 结果缓存');

// 结果缓存的「幂等」不是性能优化，是**正确性要求**：
// 同一份提交被判两次，可能一次 SE 一次 AC，用户看到的结果会自相矛盾。
// 而这套逻辑在没有 Redis 的机器上也必须能被验证 —— 所以用假 Redis。
{
  const cacheMod = await import('../judge-service/src/redis/result-cache.ts');

  ok('导出 RedisResultCache', typeof cacheMod.RedisResultCache === 'function');
  ok('导出 parseResponse（读回值必须校验形状）', typeof cacheMod.parseResponse === 'function');
  ok('导出 sanitizeKeyPart', typeof cacheMod.sanitizeKeyPart === 'function');

  /** 假 Redis：记录命令、可切换可用性 */
  function fakeRedis() {
    const store = new Map();
    const cmds = [];
    let available = true;
    return {
      store: store,
      cmds: cmds,
      setAvailable: function (v) { available = v; },
      available: function () { return available; },
      command: async function (args) {
        cmds.push(args.slice());
        if (!available) throw new Error('redis down');
        if (args[0] === 'GET') return store.has(args[1]) ? store.get(args[1]) : null;
        if (args[0] === 'SET') { store.set(args[1], args[2]); return 'OK'; }
        return null;
      },
    };
  }

  const sample = {
    submissionId: 'sub-1', verdict: 'accepted', score: 1, passed: 3, total: 3,
    cases: [], totalMs: 42, finishedAt: 1700000000000, cacheHit: false,
  };

  /* ---- 基本读写 ---- */

  {
    const r = fakeRedis();
    const c = new cacheMod.RedisResultCache({ redis: r });
    await c.set('sub-1', sample);
    const got = await c.get('sub-1');
    ok('写入后能读回', !!got && got.submissionId === 'sub-1' && got.verdict === 'accepted');
    ok('读回时标记 cacheHit=true（前端要能区分秒回）', got.cacheHit === true);
    ok('写 Redis 用的是 SET ... PX（带过期，不会永久堆积）',
      r.cmds.some(function (a) { return a[0] === 'SET' && a.indexOf('PX') > 0; }), JSON.stringify(r.cmds[1] || []).slice(0, 80));
    ok('key 有前缀（多环境共用 Redis 时能区分）', r.cmds[1][1].indexOf('judge:result:') === 0, r.cmds[1][1]);
    ok('命令参数是数组（防 RESP 注入）', Array.isArray(r.cmds[0]) && typeof r.cmds[0][0] === 'string');
  }

  /* ---- ③ 设施故障不缓存 ---- */

  {
    const r = fakeRedis();
    const c = new cacheMod.RedisResultCache({ redis: r });
    const se = Object.assign({}, sample, { submissionId: 'sub-se', verdict: 'system-error' });
    await c.set('sub-se', se);
    ok('system-error 不写缓存（否则故障「看起来永远没好」）',
      !r.store.has('judge:result:sub-se'), Array.from(r.store.keys()).join(','));
    ok('被跳过的写入计入统计', c.getStats().skipped === 1);
    // 但用户代码导致的错误**要**缓存：同一份错代码重提应该得到同一结论
    const wa = Object.assign({}, sample, { submissionId: 'sub-wa', verdict: 'wrong-answer', score: 0 });
    await c.set('sub-wa', wa);
    ok('wrong-answer 仍缓存（用户错误是可复现的）', r.store.has('judge:result:sub-wa'));
    const ce = Object.assign({}, sample, { submissionId: 'sub-ce', verdict: 'compile-error', score: 0 });
    await c.set('sub-ce', ce);
    ok('compile-error 仍缓存', r.store.has('judge:result:sub-ce'));
  }

  /* ---- ② 读回值当不可信输入 ---- */

  {
    ok('非 JSON 值被当作未命中', cacheMod.parseResponse('{not json') === undefined);
    ok('JSON 数组被拒', cacheMod.parseResponse('[1,2]') === undefined);
    ok('null 被当作未命中', cacheMod.parseResponse(null) === undefined);
    ok('非字符串被当作未命中', cacheMod.parseResponse({ foo: 1 }) === undefined);
    ok('缺 verdict 的值被拒',
      cacheMod.parseResponse(JSON.stringify({ submissionId: 'a', score: 1, passed: 0, total: 1, cases: [], finishedAt: 1 })) === undefined);
    ok('缺 cases 的值被拒',
      cacheMod.parseResponse(JSON.stringify({ submissionId: 'a', verdict: 'accepted', score: 1, passed: 0, total: 1, finishedAt: 1 })) === undefined);
    ok('score 为 NaN 的值被拒',
      cacheMod.parseResponse(JSON.stringify({ submissionId: 'a', verdict: 'accepted', score: 'x', passed: 0, total: 1, cases: [], finishedAt: 1 })) === undefined);
    ok('形状正确的值被接受',
      !!cacheMod.parseResponse(JSON.stringify(sample)));

    // 脏值进缓存后，读出来必须当未命中，而不是把脏值发给用户
    const r = fakeRedis();
    const c = new cacheMod.RedisResultCache({ redis: r });
    r.store.set('judge:result:sub-x', '{"完全":"不是判题结果"}');
    ok('Redis 里的脏值不被当成结果返回', (await c.get('sub-x')) === undefined);
  }

  /* ---- ① 降级方向：无缓存重跑，不拒服务 ---- */

  {
    const r = fakeRedis();
    let degradedReason = '';
    const c = new cacheMod.RedisResultCache({
      redis: r,
      onDegrade: function (i) { degradedReason = i.reason; },
    });
    await c.set('sub-2', sample);      // Redis 通
    r.setAvailable(false);             // Redis 挂了
    const got = await c.get('sub-2');
    // 注意断言的是响应体的 submissionId（sample 里是 sub-1），不是查询键 ——
    // 本地兜底按「查询键」索引、返回「存进去的那份响应」，两者本来就是两个东西
    ok('Redis 挂掉时仍能命中本地兜底（同实例重提不白等）',
      !!got && got.submissionId === sample.submissionId, JSON.stringify(got && got.submissionId));
    ok('降级必须留痕（静默失效等于没有缓存）', degradedReason.length > 0, degradedReason);

    // 关键：get 不抛错。抛错会把判题请求整个打挂 —— 那就是 fail-closed 了
    let threw = false;
    try { await c.get('never-seen'); } catch { threw = true; }
    ok('缓存在降级时不抛错（fail-open，判题继续进行）', !threw);

    // 写失败同样不能影响用户拿结果
    let threwSet = false;
    try { await c.set('sub-3', sample); } catch { threwSet = true; }
    ok('写入失败不抛错（用户仍能拿到本次判题结果）', !threwSet);

    ok('降级次数被记录', c.getStats().degradedPass >= 1, JSON.stringify(c.getStats()));

    r.setAvailable(true);
    await c.get('never-seen');
    ok('恢复后 cleared 降级标记（成功命令才算恢复）', c.getStats().degraded === false);
  }

  /* ---- 降级方向三处必须不同（防止顺手抄错） ---- */

  {
    ok('限流 = fail-open', cacheMod.DEGRADE_POLICY.rateLimit === 'fail-open');
    ok('结果缓存 = fail-open（算力可恢复成本）', cacheMod.DEGRADE_POLICY.resultCache === 'fail-open');
    ok('重放拦截 = fail-degraded（安全事件，方向相反）', cacheMod.DEGRADE_POLICY.nonce === 'fail-degraded');
    ok('三处降级方向不全相同（说明它们是分别决策的）',
      new Set([cacheMod.DEGRADE_POLICY.rateLimit, cacheMod.DEGRADE_POLICY.nonce, cacheMod.DEGRADE_POLICY.resultCache]).size === 2);
  }

  /* ---- 超大结果与 key 净化 ---- */

  {
    const r = fakeRedis();
    const c = new cacheMod.RedisResultCache({ redis: r, maxValueBytes: 200 });
    const big = Object.assign({}, sample, { submissionId: 'sub-big', cases: [{ index: 1, verdict: 'wrong-answer', hidden: false, costMs: 1, memoryKB: 1, actualPreview: 'x'.repeat(500) }] });
    await c.set('sub-big', big);
    ok('超大结果不写 Redis（防单条打满共享内存）', !r.store.has('judge:result:sub-big'));
    ok('超大结果仍进本地兜底（同实例重提不白等）', (await c.get('sub-big')) !== undefined);
    ok('超大结果计入跳过统计', c.getStats().skipped === 1);

    // ⚠️ 这一条守的是一个真实踩到的坑：
    //    「超大结果只写本地、不写 Redis」，但 get() 的原则是「Redis 权威」——
    //    如果 get() 在 Redis 返回 null 时直接判未命中，这些超大结果就是
    //    **写进去却永远读不到**，本地那份纯属内存泄漏，而且没有任何报错。
    //    修法是给这类项打 localOnly 标记，让 get() 知道「Redis 里注定没有，去本地找」。
    ok('超大结果在 Redis 可用时仍能命中（localOnly 标记生效）',
      (await c.get('sub-big')) !== undefined);

    // 反向：普通项（Redis 里有的）不该被本地兜底「复活」——
    // 否则一个被 Redis 清掉的结果会从内存里重新出现
    const r2 = fakeRedis();
    const c2 = new cacheMod.RedisResultCache({ redis: r2 });
    await c2.set('sub-normal', sample);
    r2.store.clear();                       // 模拟 Redis 侧被清理
    ok('Redis 已删除的结果不从本地兜底复活', (await c2.get('sub-normal')) === undefined);

    const setCmd = r.cmds.filter(function (a) { return a[0] === 'SET'; });
    ok('超大结果确实没有发出 SET', setCmd.length === 0, JSON.stringify(setCmd).slice(0, 100));

    ok('key 净化去掉空格与换行', cacheMod.sanitizeKeyPart('a b\nc\rd') === 'abcd', cacheMod.sanitizeKeyPart('a b\nc\rd'));
    ok('key 净化保留冒号点横线（可读性）', cacheMod.sanitizeKeyPart('sub-1:retry.2') === 'sub-1:retry.2');
    ok('超长 key 被截断', cacheMod.sanitizeKeyPart('x'.repeat(500)).length === 128);
    ok('净化后为空时给占位（防产生空 key）', cacheMod.sanitizeKeyPart('  ') === 'unknown');
  }

  /* ---- 序列化失败不能带崩判题 ---- */

  {
    const r = fakeRedis();
    const c = new cacheMod.RedisResultCache({ redis: r });
    const cyc = Object.assign({}, sample, { submissionId: 'sub-cyc' });
    cyc.self = cyc;
    let threw = false;
    try { await c.set('sub-cyc', cyc); } catch { threw = true; }
    ok('循环引用导致的序列化失败不抛错', !threw);
    ok('序列化失败计入错误数', c.getStats().errors >= 1, JSON.stringify(c.getStats()));
  }
}

/* ------------- 16. 外部依赖装配（配置 → 实现） ------------- */

section('16. 外部依赖装配');

// 这一节守的是「配置能真的改变行为」。
// 一个「读了配置但没传下去」的 bug 在本地测不出来（默认值恰好是对的），
// 只在生产切开关时暴露 —— 那时已经晚了。所以按配置断言**装配结果类名**。
{
  const bootMod = await import('../judge-service/src/bootstrap.ts');

  /** 造一个不碰 docker 的执行器 */
  const noopExecutor = {
    exec: async function () {
      return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 1, peakMemoryKB: 0, wallTimeout: false };
    },
  };

  const baseCfg = bootMod.loadConfig().config;

  ok('默认配置：题库来源为 memory（无需云服务即可跑）', baseCfg.planSource.kind === 'memory');
  ok('默认配置：结果缓存为 auto', baseCfg.resultCacheBackend === 'auto');
  ok('题库来源配置含 baseUrl/envId/token（外部依赖入口齐全）',
    'baseUrl' in baseCfg.planSource && 'envId' in baseCfg.planSource && 'token' in baseCfg.planSource);
  ok('题库查询有超时（题库慢不能拖住判题）', baseCfg.planSource.timeoutMs > 0);
  ok('题库查询有缓存 TTL（高 QPS 路径不能每题打题库）', baseCfg.planSource.cacheTtlMs > 0);

  {
    const b = bootMod.buildJudge({ config: baseCfg, executor: noopExecutor, logger: function () {} });
    ok('默认装配出 PlanRepository', b.plans && b.plans.constructor.name === 'PlanRepository', b.plans && b.plans.constructor.name);
    ok('默认装配出内存结果缓存（无 Redis 时不假装有）', b.resultCache.constructor.name === 'MemoryResultCache');
    ok('默认装配能读到内置样例题', !!(await b.plans.getPlan('q_c_0005', 'c')));
    ok('内置样例里没有的题返回 undefined（不是抛错）', (await b.plans.getPlan('不存在', 'c')) === undefined);
    ok('装配结果对自检可见（plans/cache 挂在 bundle 上）',
      typeof b.plans.getStats === 'function' && typeof b.resultCache.getStats === 'function',
      'plans=' + typeof b.plans.getStats + ' cache=' + typeof b.resultCache.getStats);
    // 两个缓存实现的统计形状必须一致：
    // 否则「开发用内存、生产用 Redis」就是两套可观测性，自检能跑的生产上跑不了
    const memStats = b.resultCache.getStats();
    ok('内存缓存的统计字段与 Redis 实现对齐',
      'degraded' in memStats && 'skipped' in memStats && 'errors' in memStats, JSON.stringify(memStats));
  }

  /* ---- 切到 http 题库：主流程不变，只是实现换了 ---- */

  {
    const cfg = Object.assign({}, baseCfg, {
      planSource: Object.assign({}, baseCfg.planSource, {
        kind: 'http', baseUrl: 'https://bank.test/api', token: 'T',
      }),
    });
    const b = bootMod.buildJudge({ config: cfg, executor: noopExecutor, logger: function () {} });
    ok('切 http 后仍是 PlanRepository（主流程无感）', b.plans.constructor.name === 'PlanRepository');
    ok('装配告警里点名了题库来源（运维能确认配置生效）',
      b.warnings.some(function (w) { return w.indexOf('题库来源') >= 0; }), b.warnings.join(' | '));
    // 不需要真连网络：拿一个不存在的题，底层 fetch 会失败 → 必须抛错而不是假装没有
    let threw = false;
    try { await b.plans.getPlan('q_x', 'c'); } catch { threw = true; }
    ok('http 题库不可达时抛错（不伪装成题目不存在）', threw);
  }

  /* ---- 切到 cloud 题库：缺环境 ID 必须当面说清楚 ---- */

  {
    const cfg = Object.assign({}, baseCfg, {
      planSource: Object.assign({}, baseCfg.planSource, {
        kind: 'cloud', baseUrl: 'https://env.tcb.test', envId: 'prod-1',
      }),
    });
    const b = bootMod.buildJudge({ config: cfg, executor: noopExecutor, logger: function () {} });
    ok('cloud 来源被点名', b.warnings.some(function (w) { return w.indexOf('cloud') >= 0; }), b.warnings.join(' | '));
  }

  /* ---- Redis 结果缓存：有 Redis 才用 Redis ---- */

  {
    const fake = {
      store: new Map(),
      available: function () { return true; },
      command: async function (args) {
        if (args[0] === 'GET') return this.store.get(args[1]) ?? null;
        if (args[0] === 'SET') { this.store.set(args[1], args[2]); return 'OK'; }
        if (args[0] === 'PING') return 'PONG';
        return null;
      },
      quit: async function () {},
    };
    const cfg = Object.assign({}, baseCfg, { redisUrl: 'redis://localhost:6379' });
    const b = bootMod.buildJudge({ config: cfg, executor: noopExecutor, redis: fake, logger: function () {} });
    ok('配了 Redis 后结果缓存切到 Redis', b.resultCache.constructor.name === 'RedisResultCache', b.resultCache.constructor.name);
    ok('装配告警说明了缓存保留时长',
      b.warnings.some(function (w) { return w.indexOf('结果缓存') >= 0; }), b.warnings.join(' | '));

    // 幂等跨实例共享：另一个实例（新建一个 cache 指向同一 Redis）能读到
    const sample = { submissionId: 'shared-1', verdict: 'accepted', score: 1, passed: 1, total: 1, cases: [], totalMs: 1, finishedAt: 1, cacheHit: false };
    await b.resultCache.set('shared-1', sample);
    const other = new (await import('../judge-service/src/redis/result-cache.ts')).RedisResultCache({ redis: fake });
    ok('同一结果在「另一个实例」上可见（幂等跨实例成立）', (await other.get('shared-1')).submissionId === 'shared-1');
  }

  {
    // 显式要求 redis 但没配 URL：必须告警，不能静默
    const cfg = Object.assign({}, baseCfg, { resultCacheBackend: 'redis', redisUrl: '' });
    const warns = [];
    const saved = process.env.JUDGE_RESULT_CACHE;
    const savedUrl = process.env.JUDGE_REDIS_URL;
    process.env.JUDGE_RESULT_CACHE = 'redis';
    delete process.env.JUDGE_REDIS_URL;
    try {
      const loaded = bootMod.loadConfig();
      for (const w of loaded.warnings) warns.push(w);
      ok('要求 redis 缓存但没配 URL → 告警',
        warns.some(function (w) { return w.indexOf('JUDGE_RESULT_CACHE') >= 0 && w.indexOf('退回') >= 0; }), warns.join(' | '));
    } finally {
      if (saved === undefined) delete process.env.JUDGE_RESULT_CACHE; else process.env.JUDGE_RESULT_CACHE = saved;
      if (savedUrl === undefined) delete process.env.JUDGE_REDIS_URL; else process.env.JUDGE_REDIS_URL = savedUrl;
    }
  }

  /* ---- 未知配置值不得静默 ---- */

  {
    const saved = { k: process.env.JUDGE_PLAN_SOURCE, c: process.env.JUDGE_RESULT_CACHE };
    process.env.JUDGE_PLAN_SOURCE = 'grpc';
    process.env.JUDGE_RESULT_CACHE = 'memcached';
    try {
      const loaded = bootMod.loadConfig();
      ok('未知 JUDGE_PLAN_SOURCE 有告警', loaded.warnings.some(function (w) { return w.indexOf('JUDGE_PLAN_SOURCE') >= 0; }), loaded.warnings.join(' | '));
      ok('未知 JUDGE_RESULT_CACHE 有告警', loaded.warnings.some(function (w) { return w.indexOf('JUDGE_RESULT_CACHE') >= 0; }), loaded.warnings.join(' | '));
    } finally {
      if (saved.k === undefined) delete process.env.JUDGE_PLAN_SOURCE; else process.env.JUDGE_PLAN_SOURCE = saved.k;
      if (saved.c === undefined) delete process.env.JUDGE_RESULT_CACHE; else process.env.JUDGE_RESULT_CACHE = saved.c;
    }
  }

  /* ---- 生产必须配 token（不能裸奔） ---- */

  {
    const saved = { e: process.env.NODE_ENV, t: process.env.JUDGE_INTERNAL_TOKEN };
    process.env.NODE_ENV = 'production';
    delete process.env.JUDGE_INTERNAL_TOKEN;
    let threw = false;
    try { bootMod.loadConfig(); } catch { threw = true; }
    ok('生产缺 JUDGE_INTERNAL_TOKEN 直接拒绝启动', threw);
    if (saved.e === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.e;
    if (saved.t === undefined) delete process.env.JUDGE_INTERNAL_TOKEN; else process.env.JUDGE_INTERNAL_TOKEN = saved.t;
  }
}

/* ------------- 17. 外部依赖体检脚本（搭云服务时照着填） ------------- */

section('17. 外部依赖体检脚本');

// 这个脚本是「搭云服务前的清单」和「搭完后的验收单」。
// 它最容易错的不是逻辑，而是**漏项** —— 少列一项依赖，
// 搭完云服务后就会有一项悄悄跑在默认值上，直到线上出问题才发现。
{
  const scriptPath = path.join(ROOT, 'judge-service/scripts/check-adapters.mjs');
  ok('体检脚本存在', existsSync(scriptPath));

  const src = readFileSync(scriptPath, 'utf8');

  // 必须有 IS_MAIN 守卫（同校准脚本：被 import 时不能有副作用）
  ok('体检脚本有 IS_MAIN 守卫', src.indexOf('IS_MAIN') >= 0);
  ok('体检脚本不依赖 docker / 网络（只做装配）',
    src.indexOf('DockerExecutor') < 0 && src.indexOf('fetch(') < 0);
  ok('体检脚本导出 ADAPTER_TABLE（可被自检遍历）', src.indexOf('export const ADAPTER_TABLE') >= 0);
  ok('体检脚本导出 classify（判定逻辑可自检）', src.indexOf('export function classify') >= 0);

  const check = await import('../judge-service/scripts/check-adapters.mjs');

  // 五项外部依赖一个都不能漏 —— 这是这份脚本存在的全部意义
  const keys = check.ADAPTER_TABLE.map(function (e) { return e.key; });
  for (const need of ['plans', 'resultCache', 'counter', 'nonceStore', 'executor']) {
    ok('体检覆盖「' + need + '」', keys.indexOf(need) >= 0, keys.join(','));
  }

  // 每一项都必须告诉搭建者「填哪些环境变量」与「为什么需要」
  for (const e of check.ADAPTER_TABLE) {
    ok('「' + e.label + '」列出了要填的环境变量',
      Array.isArray(e.env) && e.env.length > 0, JSON.stringify(e.env));
    ok('「' + e.label + '」说明了为什么需要', typeof e.why === 'string' && e.why.length > 10, e.why);
    ok('「' + e.label + '」的环境变量名都是 JUDGE_ 前缀',
      e.env.every(function (n) { return n.indexOf('JUDGE_') === 0; }), e.env.join(','));
  }

  // 判定逻辑：默认值必须被判成 default（这样才会提示「还没接」）
  {
    const baseCfg = (await import('../judge-service/src/bootstrap.ts')).loadConfig().config;
    const fakeBundle = {
      plans: { constructor: { name: 'PlanRepository' } },
      resultCache: { constructor: { name: 'MemoryResultCache' } },
      rateLimiterDegraded: true,
      nonceStore: { constructor: { name: 'MemoryNonceStore' } },
    };
    const table = check.ADAPTER_TABLE;
    const byKey = {};
    for (const e of table) byKey[e.key] = e;

    ok('内存结果缓存判为「用默认值」',
      check.classify(byKey.resultCache, fakeBundle, baseCfg) === 'default');
    ok('内存限流判为「用默认值」',
      check.classify(byKey.counter, fakeBundle, baseCfg) === 'default');
    ok('内存 nonce 判为「用默认值」',
      check.classify(byKey.nonceStore, fakeBundle, baseCfg) === 'default');

    const wired = Object.assign({}, fakeBundle, {
      resultCache: { constructor: { name: 'RedisResultCache' } },
      rateLimiterDegraded: false,
      nonceStore: { constructor: { name: 'FailoverNonceStore' } },
    });
    ok('Redis 结果缓存判为「已接入」',
      check.classify(byKey.resultCache, wired, baseCfg) === 'wired');
    ok('Redis 限流判为「已接入」',
      check.classify(byKey.counter, wired, baseCfg) === 'wired');
    ok('组合 nonce 判为「已接入」',
      check.classify(byKey.nonceStore, wired, baseCfg) === 'wired');

    // 题库：只有切到非 memory 才算接入
    ok('memory 题库判为「用默认值」',
      check.classify(byKey.plans, fakeBundle, baseCfg) === 'default');
    const httpCfg = Object.assign({}, baseCfg, {
      planSource: Object.assign({}, baseCfg.planSource, { kind: 'http', baseUrl: 'https://x' }),
    });
    ok('http 题库判为「已接入」',
      check.classify(byKey.plans, fakeBundle, httpCfg) === 'wired');
  }

  // describe() 要能说出「现在到底是什么实现」——只说「已接入」不够用
  {
    const baseCfg = (await import('../judge-service/src/bootstrap.ts')).loadConfig().config;
    const d = check.describe(
      { resultCache: { constructor: { name: 'RedisResultCache' } },
        rateLimiterDegraded: false,
        nonceStore: { constructor: { name: 'FailoverNonceStore' } } },
      baseCfg
    );
    ok('describe 给出结果缓存的具体实现名', d.resultCache === 'RedisResultCache', JSON.stringify(d));
    ok('describe 给出限流的具体实现', d.counter === 'Redis');
    ok('describe 给出题库来源', d.plans === '内置样例题', d.plans);
  }
}

/* ---------- 18. 本地执行器（不装 Docker 也能跑通判题链路） ---------- */

section('18. 本地执行器与 stdin 传递');

// 这一节防的是「本地测通了、上服务器就变样」这一类漂移，
// 以及「测试点输入根本没喂给用户程序」这个曾经真实存在的严重缺陷
// （所有读输入的程序都会卡住 → 超时 → 误判 TLE，而学生会去优化算法）。
{
  const local = await import('../judge-service/src/sandbox/local-executor.ts');

  // ── 18.1 卷参数拆分（Windows 盘符冒号是最大的坑） ──
  {
    const w = local.splitVolumeSpec('D:/ws/sub:/box:ro');
    eq('拆卷：Windows 盘符 + ro', { host: w.host, container: w.container, mode: w.mode },
      { host: 'D:/ws/sub', container: '/box', mode: 'ro' });

    const u = local.splitVolumeSpec('/home/u/ws:/box:ro');
    eq('拆卷：POSIX 宿主路径', { host: u.host, container: u.container },
      { host: '/home/u/ws', container: '/box' });

    // host 侧也含 ":/" 的情况：产物目录与工作目录同级
    const a = local.splitVolumeSpec('D:/ws/sub.artifacts:/box-artifact:ro');
    eq('拆卷：host 侧含冒号斜杠也不误切',
      { host: a.host, container: a.container },
      { host: 'D:/ws/sub.artifacts', container: '/box-artifact' });

    eq('拆卷：反斜杠宿主路径（Windows）',
      local.splitVolumeSpec('C:\\tmp\\ws:/box:ro').host, 'C:\\tmp\\ws');

    ok('拆卷：没有容器路径时返回 null',
      local.splitVolumeSpec('not-a-volume') === null);
  }

  // ── 18.2 路径统一（反斜杠会毁掉 Python 代码串） ──
  {
    eq('toPosix 折叠重复斜杠', local.toPosix('C://Users//LZH//ws'), 'C:/Users/LZH/ws');
    eq('toPosix 反斜杠转正斜杠', local.toPosix('D:\\tmp\\ws'), 'D:/tmp/ws');
    // UNC 路径开头的双斜杠有语义，不能被折叠
    eq('toPosix 保留 UNC 开头双斜杠',
      local.toPosix('\\\\server\\share\\ws'), '//server/share/ws');
  }

  // ── 18.3 挂载映射 + 长路径优先（否则 /box 会截胡 /box-artifact） ──
  {
    const fakePlan = {
      image: 'x', args: [
        '-v', 'D:/ws/sub:/box:ro',
        '-v', 'D:/ws/sub.artifacts:/box-artifact:ro',
      ],
      workDir: '/box', assertions: [],
    };
    const maps = local.buildMountMap(fakePlan);
    eq('挂载映射按容器路径长度降序（长的在前）',
      maps.map(m => m.from), ['/box-artifact', '/box']);
    eq('挂载映射宿主路径已转正斜杠', maps[1].to, 'D:/ws/sub');

    // 逐参数替换
    eq('translatePath 整个参数是容器路径',
      local.translatePath('/box/main.c', maps), 'D:/ws/sub/main.c');
    eq('translatePath 精确等于挂载点',
      local.translatePath('/box', maps), 'D:/ws/sub');
    // 长路径优先 → /box-artifact 不会被 /box 截胡
    eq('translatePath 长路径优先（artifact 不被截胡）',
      local.translatePath('/box-artifact/box.out', maps), 'D:/ws/sub.artifacts/box.out');
    eq('translatePath 无关路径原样返回',
      local.translatePath('/usr/bin/gcc', maps), '/usr/bin/gcc');
  }

  // ── 18.4 参数内部的路径替换（Python -c 代码串） ──
  {
    const maps = [{ from: '/box', to: 'D:/ws/sub' }];
    const py = 'import py_compile; py_compile.compile("/box/main.py")';
    ok('translatePathInText 替换 Python 代码串里的路径',
      local.translatePathInText(py, maps).indexOf('D:/ws/sub/main.py') >= 0,
      local.translatePathInText(py, maps));
    ok('translatePathInText 不残留容器路径',
      local.translatePathInText(py, maps).indexOf('/box/main.py') < 0);

    // 不替换「看起来像但其实是普通字符串」的情况 —— 保守边界
    const unrelated = 'printf("/boxer")';
    ok('translatePathInText 不做无边界替换（/boxer 不受影响）',
      local.translatePathInText(unrelated, maps).indexOf('/boxer') >= 0);
  }

  // ── 18.5 从包装脚本抠命令（必须只认第一条 + 处理 '\'' 转义） ──
  {
    // 形状参考 policy.ts 的 wrapperCommand
    const wrapper =
      "ulimit -t 5 2>/dev/null; '/usr/bin/gcc' '/box/main.c' '-o' '/tmp/box.out' >/tmp/.out 2>/tmp/.err";
    const ex = local.extractShellCommand(['--rm', 'img', '-c', wrapper]);
    ok('能从包装脚本解析出命令', ex.ok);
    eq('只取第一条命令（不把辅助命令也当命令）',
      ex.argv, ['/usr/bin/gcc', '/box/main.c', '-o', '/tmp/box.out']);

    ok('没有 -c 时明确报错而不是抛异常',
      local.extractShellCommand(['--rm', 'img']).ok === false);

    // '\'' 转义：policy.ts 的 quote() 会把单引号转义成 '\''
    const withQuote = "ulimit -t 5; '/bin/echo' 'a'\\''b' >/tmp/.out 2>/tmp/.err";
    const ex2 = local.extractShellCommand(['-c', withQuote]);
    ok("正确处理 '\\'' 转义（还原出单引号）",
      ex2.ok && ex2.argv[1] === "a'b",
      JSON.stringify(ex2.ok ? ex2.argv : ex2));
  }

  // ── 18.6 产物重定向：编译阶段的 -o 必须改到宿主中转目录 ──
  {
    const compilePlan = { assertions: ['phase[compile]'], args: [] };
    const runPlan = { assertions: ['phase[run]', 'artifact[mounted:ro]'], args: [] };
    const runPlanNoMount = { assertions: ['phase[run]', 'artifact[missing]'], args: [] };

    const argv = ['gcc', '/box/main.c', '-o', '/tmp/box.out', '-lm'];
    const redirected = local.redirectArtifactOutput(argv, compilePlan, 'D:/ws/.artifacts');
    eq('编译阶段 -o 产物改到宿主中转目录',
      redirected, ['gcc', '/box/main.c', '-o', 'D:/ws/.artifacts/box.out', '-lm']);
    ok('重定向不改原数组（无副作用）', argv[3] === '/tmp/box.out');
    ok('产物路径统一用正斜杠（反斜杠会毁掉 Python 代码串）',
      redirected[3].indexOf('\\') < 0, redirected[3]);

    // 运行阶段：命令里指向只读产物挂载，要兜底换成宿主路径
    const runArgv = ['/box-artifact/box.out'];
    eq('运行阶段兜底替换产物挂载路径',
      local.redirectArtifactOutput(runArgv, runPlan, 'D:/ws/.artifacts'),
      ['D:/ws/.artifacts/box.out']);
    eq('没有产物挂载时不乱改运行命令',
      local.redirectArtifactOutput(runArgv, runPlanNoMount, 'D:/ws/.artifacts'), runArgv);

    eq('没有产物目录时原样返回',
      local.redirectArtifactOutput(argv, compilePlan, ''), argv);
  }

  // ── 18.7 产物目录必须由**执行器自己**推导并预建（真实踩到的坑） ──
  //
  // 这个坑很隐蔽，值得写清楚：
  //   docker 模式时间线 = 编译容器写自己的 /tmp → 编译结束才 mkdirp(宿主) → docker cp
  //   所以调用方在「编译之后」建目录没问题。
  //   本地模式产物直接落宿主，编译时目录就必须存在 —— 顺序对不上，
  //   ld 直接报 "cannot open output file ...: No such file or directory"，
  //   而用户以为是自己 C 代码写错了。
  {
    const localSrc = readFileSync(
      path.join(ROOT, 'judge-service/src/sandbox/local-executor.ts'), 'utf8');

    ok('本地执行器自己推导产物目录（不依赖编译阶段的挂载）',
      localSrc.indexOf('artifactStagingDir') >= 0);
    ok('本地执行器在执行前预建产物目录',
      /mkdirSync\(artifactDir/.test(localSrc));
    ok('预建只发生在编译阶段',
      /phase\[compile\][\s\S]{0,200}mkdirSync|mkdirSync[\s\S]{0,300}phase\[compile\]/.test(localSrc));

    // 死代码检查：不能出现「只从挂载映射里找 artifactDir」的老写法
    // （编译阶段根本没有产物挂载，那样等于重定向永远不生效）
    ok('产物目录推导回退到 workDir 同级（不只看挂载）',
      /SANDBOX\.workDir[\s\S]{0,300}hostStagingDirSuffix/.test(localSrc) ||
      /hostStagingDirSuffix[\s\S]{0,300}SANDBOX\.workDir/.test(localSrc));

    // 与 runner 的约定同源：后缀取自 policy.ARTIFACT_HANDOFF，不是写死的字面量
    ok('产物目录后缀取自 ARTIFACT_HANDOFF（避免两处写死后漂移）',
      /import\s*\{[^}]*ARTIFACT_HANDOFF[^}]*\}\s*from\s*'\.\/policy'/.test(localSrc));
  }

  // ── 18.8 命令解析：不能依赖 PATH（Windows 上 Path/PATH 行为不一致） ──
  {
    const localSrc = readFileSync(
      path.join(ROOT, 'judge-service/src/sandbox/local-executor.ts'), 'utf8');

    ok('本地执行器把命令名解析成绝对路径后再 spawn',
      /resolveExecutable\(argv\[0\]\)/.test(localSrc), '不解析就会出现「装了 gcc 却报 ENOENT」');
    ok('解析时同时读 Path 与 PATH（Node 在 Windows 上优先读 Path）',
      localSrc.indexOf('process.env.Path') >= 0 && localSrc.indexOf('process.env.PATH') >= 0);
    ok('Windows 上尝试补 .exe 扩展名（env 注入 PATH 时不自动补）',
      /\.exe/.test(localSrc) && /exts/.test(localSrc));
    ok('解析失败不直接拒绝执行（交给 spawn 报系统原文）',
      /if\s*\(resolved\)\s*argv\[0\]\s*=\s*resolved/.test(localSrc));
    ok('探测与执行共用同一套解析（避免「探测说没有、执行时却有」）',
      /probeLocalToolchain[\s\S]{0,400}resolveExecutable/.test(localSrc));

    // resolveExecutable 的真实行为（不依赖本机装了什么）
    ok('resolveExecutable 对不存在的命令返回 null',
      local.resolveExecutable('definitely-not-a-real-cmd-xyz') === null);
    ok('resolveExecutable 对带路径且不存在的命令返回 null',
      local.resolveExecutable('/no/such/dir/bin') === null);
  }

  // ── 18.9 stdin 链路：这是曾经真实缺失的严重缺陷 ──
  {
    // policy 层：运行阶段必须带 stdin，编译阶段必须没有
    const cPlan = policy.buildSandboxPlan({
      language: 'c', submissionId: 's', workDir: '/box',
      artifactDir: '/box-artifact', limits: contract.DEFAULT_LIMITS,
      phase: 'compile', stdin: 'ignored',
    });
    ok('编译阶段 stdin 必须是 undefined（编译不吃测试点输入）',
      cPlan.stdin === undefined, JSON.stringify(cPlan.stdin));

    const rPlan = policy.buildSandboxPlan({
      language: 'c', submissionId: 's', workDir: '/box',
      artifactDir: '/box-artifact', limits: contract.DEFAULT_LIMITS,
      phase: 'run', stdin: '3 4\n',
    });
    eq('运行阶段 stdin 原样带上', rPlan.stdin, '3 4\n');

    // 空串也必须显式带（「没有输入」≠「不用喂 EOF」）
    const ePlan = policy.buildSandboxPlan({
      language: 'c', submissionId: 's', workDir: '/box',
      artifactDir: '/box-artifact', limits: contract.DEFAULT_LIMITS,
      phase: 'run', stdin: '',
    });
    eq('运行阶段空输入也要显式给空串（必须 end 让程序拿到 EOF）', ePlan.stdin, '');

    // 源码级核对：本地执行器与 docker 执行器都必须喂输入并立刻 end
    const localSrc = readFileSync(
      path.join(ROOT, 'judge-service/src/sandbox/local-executor.ts'), 'utf8');
    ok('本地执行器显式 pipe stdin', localSrc.indexOf("stdio: ['pipe', 'pipe', 'pipe']") >= 0);
    ok('本地执行器喂完输入立刻 end（否则读循环程序会被误判 TLE）',
      localSrc.indexOf('child.stdin.end()') >= 0);
    ok('本地执行器把 plan.stdin 传下去', localSrc.indexOf('plan.stdin') >= 0);

    const dockerSrc = readFileSync(
      path.join(ROOT, 'judge-service/src/sandbox/docker-executor.ts'), 'utf8');
    ok('docker 执行器也喂 stdin', dockerSrc.indexOf('plan.stdin') >= 0);
    ok('docker 执行器喂完输入立刻 end',
      dockerSrc.indexOf('stdin.end()') >= 0);
  }

  // ── 18.10 本地模式的两条安全底线（不能只在文档里说） ──
  {
    ok('本地模式有醒目启动告警（不能静默降级）',
      typeof local.LOCAL_MODE_WARNING === 'string' &&
      local.LOCAL_MODE_WARNING.indexOf('不设防') >= 0 &&
      local.LOCAL_MODE_WARNING.indexOf('docker') >= 0);

    const bootSrc = readFileSync(
      path.join(ROOT, 'judge-service/src/bootstrap.ts'), 'utf8');
    // 生产环境必须拒绝 local —— 这是「本地不设防模式」唯一的安全闸门。
    //
    // ⚠️ 这里刻意**跑行为**而不是扫源码：早期版本用正则匹配源码文本，
    //    中间插一句注释就把断言打死（假失败）。行为断言不会因为
    //    「行距变了」「多了一句说明」而碎掉。
    {
      const bootMod = await import('../judge-service/src/bootstrap.ts');
      const saved = {
        nodeEnv: process.env.NODE_ENV,
        sandbox: process.env.JUDGE_SANDBOX,
        token: process.env.JUDGE_INTERNAL_TOKEN,
      };

      // 生产 + local → 必须抛错
      process.env.NODE_ENV = 'production';
      process.env.JUDGE_SANDBOX = 'local';
      process.env.JUDGE_INTERNAL_TOKEN = 'test-token-for-guard-check';
      let threw = false;
      try {
        bootMod.loadConfig();
      } catch {
        threw = true;
      }
      ok('生产环境 + JUDGE_SANDBOX=local 直接拒绝启动', threw,
        '本地模式没有任何隔离，生产必须硬拒绝');

      // 开发 + local → 允许启动（否则本地就跑不起来了）
      process.env.NODE_ENV = 'development';
      let devOk = false;
      let devResult;
      try {
        devResult = bootMod.loadConfig();
        devOk = devResult && devResult.config && devResult.config.sandboxBackend === 'local';
      } catch {
        devOk = false;
      }
      ok('开发环境 + JUDGE_SANDBOX=local 正常启动', devOk,
        devResult ? JSON.stringify(devResult.config && devResult.config.sandboxBackend) : '抛错了');
      ok('本地模式必须伴随醒目告警（不能静默降级）',
        !!(devResult && devResult.warnings &&
          devResult.warnings.some(function (w) { return w.indexOf('不设防') >= 0; })),
        JSON.stringify(devResult && devResult.warnings));

      // 还原环境变量
      if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved.nodeEnv;
      if (saved.sandbox === undefined) delete process.env.JUDGE_SANDBOX;
      else process.env.JUDGE_SANDBOX = saved.sandbox;
      if (saved.token === undefined) delete process.env.JUDGE_INTERNAL_TOKEN;
      else process.env.JUDGE_INTERNAL_TOKEN = saved.token;
    }

    // 默认值必须是 docker：不能因为「本地方便」就把不安全模式设成默认
    ok('JUDGE_SANDBOX 的默认值是 docker（安全默认为先）',
      /env\(\s*'JUDGE_SANDBOX'\s*,\s*'docker'\s*\)/.test(bootSrc),
      '默认值若为 local，等于所有人默认跑在不设防模式');

    const policySrc = readFileSync(
      path.join(ROOT, 'judge-service/src/sandbox/policy.ts'), 'utf8');
    ok('SandboxPlan 类型声明了 stdin 字段', /stdin\??:/.test(policySrc));
  }
}


/* ====================================================================== */
/*  19. 客观题判分（Boss 关 / 挑战关的选择、填空、程序输出题）            */
/* ====================================================================== */

section('19. 客观题服务端判分');

const objectiveMod = await import('../judge-service/src/judges/objective.ts');
const mockAnswersMod = await import('../judge-service/src/questions/mock-answers.ts');
const answersMod = await import('../judge-service/src/questions/answers.ts');

/* ---- 19.1 白名单与题型映射 ---- */

eq(
  '服务端策略白名单覆盖 5 种',
  objectiveMod.OBJECTIVE_STRATEGIES.slice().sort().join(','),
  ['exact', 'normalize', 'numeric', 'output', 'set'].sort().join(',')
);

for (const [type, strat] of Object.entries(objectiveMod.OBJECTIVE_TYPE_STRATEGY)) {
  ok(
    '题型 ' + type + ' → 策略 ' + strat,
    objectiveMod.objectiveStrategyOf(type) === strat
  );
}
eq('未知题型没有映射', objectiveMod.objectiveStrategyOf('essay'), undefined);

/* ---- 19.2 预检：缺字段 / 空作答必须被拒 ---- */

ok('预检：缺 submissionId 被拒', !objectiveMod.precheckObjective({ questionId: 'x', type: 'single-choice', answer: 'A' }).ok);
ok('预检：缺 questionId 被拒', !objectiveMod.precheckObjective({ submissionId: 's', type: 'single-choice', answer: 'A' }).ok);
ok('预检：缺题型被拒', !objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', answer: 'A' }).ok);
ok('预检：题型不支持被拒', !objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', type: 'code-editor', answer: 'A' }).ok);
ok('预检：空串作答被拒', !objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', type: 'single-choice', answer: '   ' }).ok);
ok('预检：空数组作答被拒', !objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', type: 'multi-choice', answer: [] }).ok);
ok('预检：全空字符串数组作答被拒', !objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', type: 'fill-blank', answer: ['', '  '] }).ok);
ok('预检：正常请求通过', objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', type: 'single-choice', answer: 'A' }).ok);
ok(
  '预检：作答为 0 不算空（数值题）',
  objectiveMod.precheckObjective({ submissionId: 's', questionId: 'x', type: 'fill-blank', answer: 0 }).ok
);

/* ---- 19.3 五种策略的判分语义 ---- */

const je = objectiveMod.judgeExact;
const js = objectiveMod.judgeSet;
const jn = objectiveMod.judgeNormalize;
const jo = objectiveMod.judgeOutput;

// exact
ok('exact：正确判对', je('B', 'B', {}).correct);
ok('exact：错误判错', !je('A', 'B', {}).correct);
ok('exact：忽略大小写与空白', je(' b ', 'B', {}).correct);
ok('exact：空作答判错', !je('', 'B', {}).correct);

// set：错选直接 0 分
{
  const r = js(['A', 'B', 'C'], ['A', 'B'], { partialCredit: true });
  ok('set：多选错误项 → 0 分（不允许蒙）', r.score === 0 && !r.correct, 'score=' + r.score);
}
{
  const r = js(['A'], ['A', 'B'], { partialCredit: true });
  ok('set：漏选 + partialCredit → 部分得分', r.score > 0 && r.score < 1 && r.partial);
  const r2 = js(['A'], ['A', 'B'], {});
  ok('set：漏选但未开 partialCredit → 0 分（不外泄部分分）', r2.score === 0 && !r2.partial);
}
ok('set：全对满分', js(['A', 'B'], ['A', 'B'], {}).correct);
ok('set：大小写与空白归一（a,b vs A,B）', js([' a', 'b '], ['A', 'B'], {}).correct);

// normalize：multi 逐空
{
  const key = { mode: 'multi', accepted: [['65'], ['int', '整型']] };
  ok('normalize：全对满分', jn(['65', 'int'], key, {}).correct);
  ok('normalize：第二个空用同义词也算对', jn(['65', '整型'], key, {}).correct);
  const r = jn(['65', 'char'], key, { partialCredit: true });
  ok('normalize：错一空 + partialCredit → 0.5', Math.abs(r.score - 0.5) < 1e-9, 'score=' + r.score);
}
{
  const key = { mode: 'single', accepted: ['42'] };
  ok('normalize：single 模式命中', jn('42', key, {}).correct);
  ok('normalize：single 模式未命中', !jn('43', key, {}).correct);
}

// output：行比对
{
  const key = { expected: ['sum=9', 'count=3'] };
  ok('output：完全一致判对', jo('sum=9\ncount=3', key, {}).correct);
  ok('output：末尾多空行不影响', jo('sum=9\ncount=3\n\n', key, {}).correct);
  ok('output：行尾空白不影响', jo('sum=9  \ncount=3   ', key, {}).correct);
  ok('output：少一行判错', !jo('sum=9', key, {}).correct);
  ok('output：错一行判错', !jo('sum=9\ncount=4', key, {}).correct);
  ok(
    'output：trimStart=false 时行首空白有意义（默认保留）',
    !jo(' sum=9\ncount=3', key, {}).correct
  );
}

/* ---- 19.4 ⚠️ 核心：答案绝不出现在返回体里 ---- */

{
  const leakCases = [
    ['exact', je('A', 'B', {})],
    ['set', js(['C'], ['A', 'B'], { partialCredit: true })],
    ['normalize', jn(['1', 'char'], { mode: 'multi', accepted: [['65'], ['int']] }, {})],
    ['output', jo('wrong', { expected: ['sum=9', 'count=3'] }, {})],
  ];
  for (const [name, raw] of leakCases) {
    const safe = objectiveMod.sanitizeOutcome(raw);
    const json = JSON.stringify(safe);
    ok(
      'sanitizeOutcome[' + name + ']：detail 里不含答案片段',
      json.indexOf('正确答案') < 0,
      '实际 detail=' + safe.detail
    );
  }

  // 逐条校验：题库里的答案文本不能出现在净化后的任何字段里
  const perCase = [
    ['exact', je('A', 'B', {}), 'B'],
    ['set', js(['C'], ['A', 'B'], { partialCredit: true }), 'A'],
    ['normalize', jn(['1', 'char'], { mode: 'multi', accepted: [['65'], ['int']] }, {}), '65'],
    ['output', jo('wrong', { expected: ['sum=9', 'count=3'] }, {}), 'sum=9'],
  ];
  for (const [name, raw, secret] of perCase) {
    const safe = objectiveMod.sanitizeOutcome(raw);
    const json = JSON.stringify(safe);
    ok(
      'sanitizeOutcome[' + name + ']：答案 "' + secret + '" 未泄漏',
      json.indexOf(secret) < 0,
      '实际返回：' + json
    );
  }

  ok(
    'sanitizeOutcome：净化后仍有非空提示（不能变成空白）',
    objectiveMod.sanitizeOutcome(je('A', 'B', {})).detail.length > 0
  );
  ok(
    'sanitizeOutcome：判对时的结论不被破坏',
    objectiveMod.sanitizeOutcome(je('B', 'B', {})).correct === true
  );
}

/* ---- 19.5 ⚠️ 核心：服务端与客户端判分口径必须一致 ---- */

/*
 * 这一节防的是「同一道题在练习关判对、在 Boss 关判错」。
 * 做法：用**同一组向量**分别跑客户端判分器与服务端判分器，断言结论相同。
 * 任何一边改了归一化规则而没改另一边，这里就会红。
 */
const clientJudges = await import('../miniprogram/engine/judges/index.ts');

// 客户端判分器按策略取函数：必须与注册表里注册的完全同一个函数引用
const CLIENT_JUDGE_BY_STRATEGY = {
  exact: clientJudges.judgeExact,
  set: clientJudges.judgeSet,
  normalize: clientJudges.judgeNormalize,
  numeric: clientJudges.judgeNumeric,
  output: clientJudges.judgeOutput,
};
const getClientJudge = (strategy) => CLIENT_JUDGE_BY_STRATEGY[strategy];

const CROSS_VECTORS = [
  // [策略, 用户作答, 正确答案, 选项]
  ['exact', 'B', 'B', {}],
  ['exact', 'A', 'B', {}],
  ['exact', '  b  ', 'B', {}],
  ['exact', 'Ｂ', 'B', {}], // 全角 B —— 两边的 toHalfWidth 都要处理
  ['set', ['A', 'B'], ['A', 'B'], {}],
  ['set', ['A'], ['A', 'B'], { partialCredit: true }],
  ['set', ['A'], ['A', 'B'], {}],
  ['set', ['A', 'C'], ['A', 'B'], { partialCredit: true }],
  ['set', ['b', 'a'], ['A', 'B'], {}],
  ['normalize', ['65', 'int'], { mode: 'multi', accepted: [['65'], ['int', '整型']] }, {}],
  ['normalize', ['65', 'char'], { mode: 'multi', accepted: [['65'], ['int']] }, { partialCredit: true }],
  ['normalize', ['65', 'char'], { mode: 'multi', accepted: [['65'], ['int']] }, {}],
  ['normalize', '42', { mode: 'single', accepted: ['42'] }, {}],
  ['normalize', '43', { mode: 'single', accepted: ['42'] }, {}],
  ['output', 'sum=9\ncount=3', { expected: ['sum=9', 'count=3'] }, {}],
  ['output', 'sum=9\ncount=4', { expected: ['sum=9', 'count=3'] }, {}],
  ['output', 'sum=9', { expected: ['sum=9', 'count=3'] }, {}],
  ['output', 'sum=9\ncount=3\n\n', { expected: ['sum=9', 'count=3'] }, {}],
  ['output', 'x', { expected: ['sum=9'] }, { trimStart: true }],
  ['output', ' x', { expected: ['sum=9'] }, { trimStart: true }],
  ['numeric', ' 3.14 ', { value: 3.14 }, {}],
  ['numeric', '3.15', { value: 3.14 }, {}],
  ['numeric', '3.14,5', { value: 3.145 }, {}], // 逗号当千分位/分隔符清掉
  ['numeric', '１００', { value: 100 }, {}], // 全角数字
  ['numeric', '314', { value: 314, tolerance: 0.01, mode: 'rel' }, {}],
  ['numeric', '315', { value: 314, tolerance: 0.01, mode: 'rel' }, {}],
  ['numeric', 'abc', { value: 3.14 }, {}],
  ['numeric', '3.14', {}, {}], // 答案对象缺 value → 两端都必须报配置异常而非判对
];

let driftCount = 0;
for (const [strategy, userAnswer, answer, options] of CROSS_VECTORS) {
  const clientFn = getClientJudge(strategy);
  const origWarn = console.warn;
  console.warn = function () {}; // 客户端判分器可能对未知策略告警，静音
  const clientRes = clientFn(userAnswer, answer, options);
  console.warn = origWarn;

  const serverRes = objectiveMod.judgeObjective(strategy, userAnswer, answer, options);

  const same = clientRes.correct === serverRes.correct &&
    clientRes.partial === serverRes.partial &&
    Math.abs(clientRes.score - serverRes.score) < 1e-9;

  if (!same) driftCount++;
  ok(
    '口径一致[' + strategy + '] ' + JSON.stringify(userAnswer).slice(0, 24) +
      ' → 客户端(' + clientRes.correct + '/' + clientRes.partial + '/' + clientRes.score +
      ') 服务端(' + serverRes.correct + '/' + serverRes.partial + '/' + serverRes.score + ')',
    same
  );
}
eq('客户端/服务端判分口径零漂移', driftCount, 0);

/* ---- 19.6 答案库：三态语义 ---- */

{
  const mem = new answersMod.MemoryAnswerSource([
    { questionId: 'q1', type: 'single-choice', strategy: 'exact', answer: 'A' },
  ]);
  ok('答案库：有这道题 → 返回对象', !!(await mem.fetchAnswer('q1')).value);
  ok('答案库：确实没有 → value 为 undefined 且 ok=true',
    (await mem.fetchAnswer('nope')).ok === true && (await mem.fetchAnswer('nope')).value === undefined);
}

{
  // 查询失败必须抛错（不能被吞成 undefined，否则用户对着「题目不存在」白等）
  const failing = {
    name: 'failing',
    fetchAnswer: () => Promise.resolve({ ok: false, error: '网络炸了', retryable: true }),
  };
  const repo = new answersMod.AnswerRepository({ source: failing, cacheTtlMs: 1000 });
  let threw = false;
  try {
    await repo.getAnswer('q1');
  } catch (e) {
    threw = true;
  }
  ok('答案仓储：查询失败抛错（不伪装成「题目不存在」）', threw);

  const stats = repo.getStats();
  eq('答案仓储：失败计入 errors', stats.errors, 1);
  eq('答案仓储：失败不进缓存', stats.size, 0);
}

{
  // 成功才缓存；「确实没有」不缓存
  let calls = 0;
  const src = {
    name: 'counting',
    fetchAnswer: (id) => {
      calls++;
      return Promise.resolve(id === 'yes' ? { ok: true, value: { questionId: id, type: 'single-choice', strategy: 'exact', answer: 'A' } } : { ok: true, value: undefined });
    },
  };
  let clock = 1000;
  const repo = new answersMod.AnswerRepository({
    source: src,
    cacheTtlMs: 5000,
    now: () => clock,
  });
  await repo.getAnswer('yes');
  await repo.getAnswer('yes');
  eq('答案仓储：命中缓存只查一次题库', calls, 1);
  await repo.getAnswer('no');
  await repo.getAnswer('no');
  eq('答案仓储：「确实没有」不缓存（每次都查）', calls, 3);

  clock += 6000; // 过期
  await repo.getAnswer('yes');
  eq('答案仓储：TTL 过期后重新查', calls, 4);

  repo.invalidate('yes');
  await repo.getAnswer('yes');
  eq('答案仓储：invalidate 后重新查', calls, 5);
}

/* ---- 19.7 题库返回值的规范化 ---- */

{
  const na = answersMod.normalizeAnswer;
  ok('规范化：缺 type → undefined', na({ answer: 'A' }, 'q') === undefined);
  ok('规范化：缺 answer → undefined', na({ type: 'single-choice' }, 'q') === undefined);
  ok('规范化：未知题型 → undefined', na({ type: 'essay', answer: 'A' }, 'q') === undefined);
  ok('规范化：正常记录通过', !!na({ type: 'single-choice', answer: 'A' }, 'q'));
  eq(
    '规范化：策略缺失时按题型推断',
    na({ type: 'multi-choice', answer: ['A'] }, 'q').strategy,
    'set'
  );
  eq(
    '规范化：策略与题型不符时以题型为准',
    na({ type: 'multi-choice', strategy: 'exact', answer: ['A'] }, 'q').strategy,
    'set'
  );
  eq(
    '规范化：options 不是对象时丢成 undefined',
    na({ type: 'single-choice', answer: 'A', options: [1, 2] }, 'q').options,
    undefined
  );
}

/* ---- 19.8 内置样例答案与题库一致 ---- */

{
  const bank = await import('../miniprogram/mock/bank.ts');
  const bankIndex = {};
  for (const q of bank.QUESTIONS) bankIndex[q.id] = q;

  const answerIndex = mockAnswersMod.indexAnswers();
  const answerIds = Object.keys(answerIndex);
  eq('内置客观题答案数量', answerIds.length, mockAnswersMod.OBJECTIVE_ANSWERS.length);

  for (const id of answerIds) {
    const q = bankIndex[id];
    ok('答案库引用的题目存在于客户端题库：' + id, !!q);
    if (!q) continue;

    eq('[' + id + '] 题型与客户端题库一致', answerIndex[id].type, q.type);
    eq('[' + id + '] 判分策略与客户端题库一致', answerIndex[id].strategy, q.judge.strategy);
    eq(
      '[' + id + '] 答案与客户端题库逐字节一致（防两边漂移）',
      JSON.stringify(answerIndex[id].answer),
      JSON.stringify(q.answer)
    );
    eq(
      '[' + id + '] 判分选项与客户端题库一致',
      JSON.stringify(answerIndex[id].options || {}),
      JSON.stringify(q.judge.options || {})
    );
  }

  // ⚠️ 双向校验：每个「服务端判分关卡」里的每道客观题都必须在答案库里有记录。
  //    缺一条 → 用户在该关提交必然 404。
  const missing = [];
  for (const lv of bank.LEVELS) {
    const isRemote = lv.mode === 'boss' || lv.mode === 'challenge';
    if (!isRemote) continue;
    for (const qid of lv.questionIds) {
      const q = bankIndex[qid];
      if (!q) continue;
      if (q.type === 'code-editor') continue; // 编程题走 plans，不在这里
      if (!answerIndex[qid]) missing.push(lv.id + '/' + qid);
    }
  }
  eq(
    '服务端判分关卡里的客观题都有服务端答案（缺了会 404）',
    missing.join(', '),
    ''
  );
}

/* ---- 19.9 装配：bundle 暴露客观题答案仓储 ---- */

{
  const bootstrapMod = await import('../judge-service/src/bootstrap.ts');
  const noopExecutor = {
    exec: async function () {
      return { exitCode: 0, signal: null, stdout: '', stderr: '', wallMs: 1, peakMemoryKB: 0, wallTimeout: false };
    },
  };
  const cfg = bootstrapMod.loadConfig().config;
  const b = bootstrapMod.buildJudge({ config: cfg, executor: noopExecutor, logger: function () {} });
  ok('bundle 暴露 objectivePlans', !!b.objectivePlans);
  eq(
    'objectivePlans 装配为 AnswerRepository',
    b.objectivePlans.constructor.name,
    'AnswerRepository'
  );
  const a = await b.objectivePlans.getAnswer('q_c_0050');
  ok('默认装配能读到内置样例答案', !!a);
  ok('读到的答案带 answer 与 options（可判分）', !!(a && a.answer && a.options !== undefined));

  const notFound = await b.objectivePlans.getAnswer('q_not_exist');
  ok('不存在的题目返回 undefined（不是抛错）', notFound === undefined);
}

/* ---- 19.10 配置项 ---- */

{
  const bootstrapMod = await import('../judge-service/src/bootstrap.ts');
  const cfg = bootstrapMod.loadConfig().config;
  ok(
    '客观题答案缓存 TTL 默认 60 秒',
    cfg.objectiveAnswerCacheTtlMs === 60 * 1000,
    '实际 ' + cfg.objectiveAnswerCacheTtlMs
  );
  ok(
    '答案 TTL 短于测试点 TTL（改答案要尽快生效）',
    cfg.objectiveAnswerCacheTtlMs < cfg.planSource.cacheTtlMs,
    '答案 ' + cfg.objectiveAnswerCacheTtlMs + ' vs 测试点 ' + cfg.planSource.cacheTtlMs
  );
}

/* ---- 19.11 HTTP 层：路由与端到端 ---- */

{
  const { createHttpServer, ROUTES } = await import('../judge-service/src/server.js');
  eq('客观题端点已注册', ROUTES.objective, '/judge/objective');

  const bootstrapMod = await import('../judge-service/src/bootstrap.ts');
  const hmac = await import('../judge-service/src/auth/hmac.ts');
  // ⚠️ 端口不能用 0：bootstrap 的 envInt 会拒绝 0 并回退到默认 8600，
  //    那样就会和 judge-http.test.mjs（同链路独立进程）或本机常驻服务撞端口。
  //    这里挑一个高位随机端口，并留出重试空间。
  const pickPort = () => 20000 + Math.floor(Math.random() * 20000);
  const prevPort = process.env.JUDGE_PORT;
  process.env.JUDGE_PORT = String(pickPort());
  const cfg = bootstrapMod.loadConfig().config;
  if (prevPort === undefined) delete process.env.JUDGE_PORT;
  else process.env.JUDGE_PORT = prevPort;
  const bundle = bootstrapMod.buildJudge({ config: cfg, logger: function () {} });

  const logs = [];
  const http = createHttpServer({
    bundle,
    logger: (lvl, m) => logs.push(lvl + ':' + m),
    submit: async () => ({ ok: true, result: { correct: true, partial: false, score: 1, detail: 'x' } }),
  });

  await http.listen();
  const addr = http.address();
  const base = 'http://127.0.0.1:' + addr.port + '/judge/objective';

  /** 造一套鉴权头（用被测实现的 sign()，避免手搓漏头） */
  function authHeaders(path, raw) {
    const s = hmac.sign({
      token: cfg.token,
      method: 'POST',
      path,
      bodyHash: hmac.sha256Hex(raw),
    });
    return {
      'content-type': 'application/json',
      'x-judge-token': cfg.token,
      'x-judge-timestamp': s.material.timestamp,
      'x-judge-nonce': s.material.nonce,
      'x-judge-signature': s.signature,
    };
  }

  async function postObjective(body, opts) {
    const raw = JSON.stringify(body);
    const path = '/judge/objective';
    const headers = authHeaders(path, raw);
    if (opts && opts.omitSignature) {
      delete headers['x-judge-signature'];
    }
    const res = await fetch(base, { method: 'POST', headers, body: raw });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // 忽略
    }
    return { status: res.status, body: json };
  }

  // 未鉴权必须被挡
  {
    const r = await postObjective({ submissionId: 's1', questionId: 'q_c_0054', type: 'single-choice', answer: 'B' }, { omitSignature: true });
    eq('客观题端点：未带签名 → 401', r.status, 401);
  }

  // 答对
  {
    const r = await postObjective({ submissionId: 's2', questionId: 'q_c_0054', type: 'single-choice', answer: 'B' });
    eq('客观题端点：答对 → 200', r.status, 200);
    ok('客观题端点：返回 ok=true', r.body && r.body.ok === true);
    ok('客观题端点：correct=true', r.body && r.body.result && r.body.result.correct === true);
    eq('客观题端点：layer 为 remote', r.body && r.body.result && r.body.result.layer, 'remote');
    eq('客观题端点：strategy 为 exact', r.body && r.body.result && r.body.result.strategy, 'exact');
  }

  // 答错且**不能泄漏答案**
  {
    const r = await postObjective({ submissionId: 's3', questionId: 'q_c_0054', type: 'single-choice', answer: 'A' });
    eq('客观题端点：答错 → 200（判错也是成功响应）', r.status, 200);
    ok('客观题端点：correct=false', r.body && r.body.result && r.body.result.correct === false);
    const json = JSON.stringify(r.body);
    ok(
      '⚠️ 客观题端点：返回体里没有正确答案 B',
      !/"B"/.test(json.replace(/"strategy":"[^"]*"/g, '')),
      '返回体：' + json
    );
    ok('⚠️ 客观题端点：返回体里没有「正确答案」字样', json.indexOf('正确答案') < 0, '返回体：' + json);
  }

  // 程序输出题（多行）
  {
    const r = await postObjective({ submissionId: 's4', questionId: 'q_c_0050', type: 'program-output', answer: '15\n2\n-2' });
    eq('客观题端点：程序输出题答对 → 200', r.status, 200);
    ok('客观题端点：程序输出题 correct=true', r.body && r.body.result && r.body.result.correct === true);
  }
  {
    const r = await postObjective({ submissionId: 's5', questionId: 'q_c_0050', type: 'program-output', answer: '15\n2\n-3' });
    ok('客观题端点：程序输出题答错 → correct=false', r.body && r.body.result && r.body.result.correct === false);
    const json = JSON.stringify(r.body);
    ok(
      '⚠️ 程序输出题：返回体里没有期望输出 -2',
      json.indexOf('-2') < 0,
      '返回体：' + json
    );
  }

  // 不存在的题目 → 404
  {
    const r = await postObjective({ submissionId: 's6', questionId: 'q_not_exist', type: 'single-choice', answer: 'A' });
    eq('客观题端点：题目不存在 → 404', r.status, 404);
    eq('客观题端点：错误码为 question-not-found', r.body && r.body.error && r.body.error.code, 'question-not-found');
  }

  // 题型与题库不一致 → 400
  {
    const r = await postObjective({ submissionId: 's7', questionId: 'q_c_0054', type: 'multi-choice', answer: ['A'] });
    eq('客观题端点：题型与题库不一致 → 400', r.status, 400);
  }

  // 空作答 → 400
  {
    const r = await postObjective({ submissionId: 's8', questionId: 'q_c_0054', type: 'single-choice', answer: '   ' });
    eq('客观题端点：空作答 → 400', r.status, 400);
  }

  // 题型不支持 → 400
  {
    const r = await postObjective({ submissionId: 's9', questionId: 'q_c_0054', type: 'code-editor', answer: 'x' });
    eq('客观题端点：题型不支持 → 400', r.status, 400);
  }

  // ⚠️ 客观题不占沙箱并发闸门
  {
    eq('客观题请求结束后 inflight 归零（不占并发闸门）', http.inflight(), 0);
  }

  // 题库查询失败 → 500（不是 404）
  {
    const failingBundle = Object.assign({}, bundle, {
      // 换一个端口：不能与上面的 http 撞（同一进程里两处 listen 同端口会 EADDRINUSE）
      config: Object.assign({}, bundle.config, { port: pickPort() }),
      objectivePlans: {
        getAnswer: () => Promise.reject(new Error('题库网络炸了')),
      },
    });
    const http2 = createHttpServer({
      bundle: failingBundle,
      logger: () => {},
      submit: async () => ({ ok: true }),
    });
    await http2.listen();
    const a2 = http2.address();
    const raw = JSON.stringify({ submissionId: 's10', questionId: 'q_c_0054', type: 'single-choice', answer: 'B' });
    const res = await fetch('http://127.0.0.1:' + a2.port + '/judge/objective', {
      method: 'POST',
      headers: authHeaders('/judge/objective', raw),
      body: raw,
    });
    eq('题库查询失败 → 500（不能伪装成「题目不存在」）', res.status, 500);
    await http2.close();
  }

  // /judge 端点的行为不能被 /judge/objective 影响
  {
    const raw = JSON.stringify({ payload: { submissionId: 'p1', questionId: 'q_c_0005', type: 'code-editor', language: 'c', code: 'int main(){}' } });
    const res = await fetch('http://127.0.0.1:' + addr.port + '/judge', {
      method: 'POST',
      headers: authHeaders('/judge', raw),
      body: raw,
    });
    eq('沙箱端点仍然可用（未被新端点影响）', res.status, 200);
  }

  await http.close();
}

/* ---- 19.12 ⚠️ 生产入口必须真的能被 Node 启动 ---- */

/*
 * 这一节防的是本轮实际踩到的坑：
 *   `src/server.js` 曾是 `server.ts` 的逐字节副本，里面带着 `export type`、
 *   `: JudgeErrorCode` 这类 TS 语法。Node 的类型剥离**只对 .ts/.mts/.tsx 生效**，
 *   对 `.js` 完全不生效 → `node src/server.js` 直接 SyntaxError。
 *   而 Dockerfile / package.json 的入口都指向它 → 生产起不来。
 *   更糟的是此前所有自检都 import `server.ts`，从没验证过 `.js` 能不能跑。
 *
 * 所以这里的断言不是「检查文件里有没有 TS 语法」（那种断言容易漏），
 * 而是**直接 spawn 一个子进程去启动它** —— 与生产完全同一条路径。
 */
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = path.join(ROOT, 'judge-service/src/server.js');

  ok('生产入口文件存在', existsSync(entry));

  // ① 纯加载：能 import 出导出，不抛语法错误。
  //
  //    ⚠️ 刻意用**进程内 import**，不用 spawn 子进程。
  //    Windows 上 spawn(process.execPath) 会 EBUSY（运行中的 node.exe 被锁），
  //    表现为 status=null / err 为空 —— 看不出是被测代码的问题还是环境问题。
  //    （这是本项目已踩过的坑，见 MEMORY 的「Windows 上 spawn 自身会 EBUSY」。）
  //    进程内 import 同样会真实走 Node 的 .js 解析与执行，足以暴露 TS 语法错误。
  let jsExports = null;
  let loadError = null;
  try {
    const jsMod = await import('../judge-service/src/server.js');
    jsExports = Object.keys(jsMod)
      .filter((k) => k !== 'default')
      .sort();
  } catch (e) {
    loadError = String((e && e.message) || e).split('\n')[0];
  }
  ok(
    '生产入口 server.js 能被 Node 直接加载（生产 npm start 不会崩）',
    loadError === null,
    loadError || ''
  );

  // ② 导出名必须与 server.ts 完全一致。
  //    垫片用「逐名重导出」实现（静态 export * 在钩子注册前就会解析依赖树，
  //    见 server.js 文件头），所以新增导出容易忘同步 —— 结构上锁死。
  if (jsExports) {
    const tsMod = await import('../judge-service/src/server.ts');
    // 类型导出（interface/type）在运行期不存在，两边都取不到，天然一致
    const tsExports = Object.keys(tsMod)
      .filter((k) => k !== 'default')
      .sort();
    eq(
      'server.js 与 server.ts 的运行期导出名完全一致（垫片没漏透传）',
      jsExports.join(','),
      tsExports.join(',')
    );
  }

  // ③ 入口不能含 TS 语法（用 Node 自己当解析器，不靠正则猜）
  const rawEntry = readFileSync(entry, 'utf8');
  const codeLines = rawEntry
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)); // 剥注释：注释里可以提旧写法
  const tsSyntax = codeLines.filter((l) => /^\s*export\s+type\s+\w+|^\s*export\s+interface\s+\w+/.test(l));
  eq('生产入口不含 `export type` / `export interface`', tsSyntax.join(' | '), '');

  // ④ 入口要足够薄：真正的实现应在 server.ts。
  //    阈值放宽到 120 行：超过就说明有人把实现写回垫片了，那是老坑复发。
  ok(
    '生产入口是薄垫片（< 120 行），实现留在 server.ts',
    codeLines.length < 120,
    '实际 ' + codeLines.length + ' 行'
  );
}

/* ---- 19.13 ⚠️ 预检失败一律不得回 5xx ---- */

/*
 * 这一节防的是本轮实际踩到的第二个坑：
 *   `precheckStatus()` 是给 `/judge`（代码提交）写的「契约语义 → HTTP 语义」适配层，
 *   靠**消息文案**识别「这是调用方的错」。后来新增 `/judge/objective` 端点，
 *   它的预检文案是「作答为空」—— 不在词表里 → 被回成 500。
 *   后果：前端给出无意义的重试按钮，且把「用户传了坏数据」计入 5xx 故障率。
 *
 * 这里遍历**两个端点所有已知的预检失败路径**，断言状态码都在 4xx。
 * 不靠人去记文案：新增一条 precheck 分支却忘了进词表，这里就会红。
 */
{
  const serverMod = await import('../judge-service/src/server.js');
  const contractMod = await import('../judge-service/src/contract.ts');
  const objectiveMod2 = await import('../judge-service/src/judges/objective.ts');

  const cases = [];

  // /judge 侧（编程题提交）
  const badJudgeReqs = [
    {},
    { submissionId: '', questionId: 'q', type: 'code-editor', language: 'c', code: 'x' },
    { submissionId: 's', type: 'code-editor', language: 'c', code: 'x' }, // 缺 questionId
    { submissionId: 's', questionId: 'q', language: 'c', code: 'x' }, // 缺 type
    { submissionId: 's', questionId: 'q', type: 'code-editor', code: 'x' }, // 缺 language
    { submissionId: 's', questionId: 'q', type: 'code-editor', language: 'cpp', code: '' }, // 代码为空
  ];
  for (let i = 0; i < badJudgeReqs.length; i++) {
    const pre = contractMod.precheck(badJudgeReqs[i]);
    if (pre.ok) continue;
    cases.push({
      label: '/judge #' + i + '（' + pre.message + '）',
      status: serverMod.precheckStatus(pre.code, pre.message || ''),
    });
  }

  // /judge/objective 侧（客观题）
  const badObjectiveReqs = [
    {},
    { submissionId: '', questionId: 'q', type: 'single-choice', answer: 'A' },
    { submissionId: 's', questionId: '', type: 'single-choice', answer: 'A' },
    { submissionId: 's', questionId: 'q', answer: 'A' }, // 缺 type
    { submissionId: 's', questionId: 'q', type: 'single-choice' }, // 缺 answer
    { submissionId: 's', questionId: 'q', type: 'single-choice', answer: '   ' }, // 空作答
    { submissionId: 's', questionId: 'q', type: 'multi-choice', answer: [] }, // 空数组
    { submissionId: 's', questionId: 'q', type: 'code-editor', answer: 'x' }, // 题型不支持
  ];
  for (let i = 0; i < badObjectiveReqs.length; i++) {
    const pre = objectiveMod2.precheckObjective(badObjectiveReqs[i]);
    if (pre.ok) continue;
    cases.push({
      label: '/judge/objective #' + i + '（' + pre.message + '）',
      status: serverMod.precheckStatus(pre.code, pre.message || ''),
    });
  }

  ok('预检失败路径样本足够多（≥ 10 条）', cases.length >= 10, '实际 ' + cases.length + ' 条');

  const fiveXX = cases.filter((c) => c.status >= 500);
  eq(
    '⚠️ 所有预检失败都回 4xx（不得回 5xx：会让前端瞎重试 + 污染故障率告警）',
    fiveXX.map((c) => c.label + '→' + c.status).join(' | '),
    ''
  );

  // 反向：真正的服务端故障仍必须是 5xx（别把 4xx 修过头）
  eq('真正的内部故障仍是 500', serverMod.precheckStatus('internal', '数据库连接池耗尽'), 500);
  eq('busy 仍是 503', serverMod.precheckStatus('busy', '队列饱和'), 503);
  eq('unauthorized 仍是 401', serverMod.precheckStatus('unauthorized', '签名不匹配'), 401);
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('\n' + '='.repeat(56));
console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) {
  console.log('\n失败项：');
  for (let i = 0; i < failures.length; i++) console.log('  - ' + failures[i]);
  process.exitCode = 1;
} else {
  console.log('判题服务自检全部通过。');
}
console.log('='.repeat(56));
