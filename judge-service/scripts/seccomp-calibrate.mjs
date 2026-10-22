/**
 * seccomp 白名单实跑校准工具
 *
 * 用途：把 seccomp profile 从「基线猜测」变成「实跑验证过的白名单」。
 *
 * 原理：
 *   1. 生成一份**校准用 profile**：defaultAction 改为 SCMP_ACT_LOG
 *      （而不是 SCMP_ACT_ERRNO）。这样被拦的调用不会让程序失败，
 *      只会被内核记进 audit 日志 —— 我们能看清「到底缺了什么」。
 *   2. 用这个 profile 跑 10 道校准题（含编译与运行两个阶段）。
 *   3. 从内核日志（dmesg / audit.log）里提取 SCMP_ACT_LOG 记录的系统调用名。
 *   4. 输出一份「建议补充」清单，人工确认后合并进正式 profile。
 *
 * 为什么不能直接把 defaultAction 调成 ALLOW 来跑：
 *   那样就失去了「哪些调用是必需的」这个信号 —— 全都允许，日志什么都没有。
 *   SCMP_ACT_LOG 的精妙之处在于：**放行但记录**。
 *
 * 用法：
 *   node judge-service/scripts/seccomp-calibrate.mjs              # 需要 docker + root 读内核日志
 *   node judge-service/scripts/seccomp-calibrate.mjs --dry-run    # 只打印计划，不执行
 *   node judge-service/scripts/seccomp-calibrate.mjs --report <file>  # 从已有日志文件分析
 *
 * ⚠️ 需要 root 权限读内核日志。若无法读 dmesg，脚本会提示改用
 *    auditd 或 `journalctl -k` 的方式，并把原始命令打印出来供手工执行。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = path.resolve(HERE, '..');

/* ----------------------------- 参数解析 ----------------------------- */

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const REPORT_IDX = argv.indexOf('--report');
const REPORT_FILE = REPORT_IDX >= 0 ? argv[REPORT_IDX + 1] : null;

function log(msg) {
  process.stdout.write(msg + '\n');
}

/* ----------------------------- 读 profile ----------------------------- */

const PROFILE_PATH = path.join(SERVICE_ROOT, 'etc', 'seccomp-judge.json');

if (!existsSync(PROFILE_PATH)) {
  log('❌ 找不到 seccomp profile: ' + PROFILE_PATH);
  process.exit(1);
}

const baseProfile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));

/* -------------------- 生成校准 profile -------------------- */

/**
 * 校准 profile：defaultAction 改为 SCMP_ACT_LOG。
 *
 * 注意：**archMap 必须保留**。去掉 archMap 会让 profile 只对
 * 主架构生效，x32/ia32 兼容调用会走 ERRNO 而不是 LOG，
 * 于是「跑得通」但看不到日志 —— 会误判成「没有缺调用」。
 */
function buildCalibrationProfile(profile) {
  const out = {
    '//': 'seccomp 校准用 profile —— defaultAction=SCMP_ACT_LOG（放行但记录）',
    '//2': '⚠️ 这只是临时产物，不要提交、不要用于生产。',
    defaultAction: 'SCMP_ACT_LOG',
    archMap: profile.archMap,
    syscalls: [],
  };
  return out;
}

/* -------------------- 读内核日志 -------------------- */

/**
 * 从文本里提取 seccomp 记录的系统调用名。
 *
 * 内核日志格式随版本差异很大，实测见过至少三种：
 *   audit: type=1326 ... syscall=41 ...
 *   audit: type=1326 ... syscall=41(0x29) ...
 *   直接给名字的（auditd 的 INTERPRET 模式）: syscall=socket
 * 所以这里两手都抓：既抽数字，也抽裸名字，最后用表映射数字。
 *
 * 导出给自检用 —— 解析逻辑必须能被单元测试钉住，
 * 因为「读错日志」会让校准结论完全反向（把该补的调用漏掉），
 * 而这种错误在人工跑一遍时看不出来。
 */
export function extractSyscalls(text) {
  const found = new Set();

  // 形式一：直接给名字
  const nameRe = /syscall=([a-z][a-z0-9_]{1,40})/g;
  let m;
  while ((m = nameRe.exec(text)) !== null) found.add(m[1]);

  // 形式二：给数字（需要查表）
  // 注意顺序：先抽名字再抽数字。`syscall=socket` 不会被数字正则命中（不是数字），
  // 而 `syscall=41(0x29)` 的裸数字正则取到 41 后，名字正则不会误加 `x29`。
  const numRe = /syscall=(\d{1,4})\b/g;
  while ((m = numRe.exec(text)) !== null) {
    const num = Number(m[1]);
    const name = SYSCALL_TABLE[num];
    if (name) found.add(name);
    else found.add('syscall#' + num);
  }

  return found;
}

/**
 * 把「日志里出现过的调用」分成三类。
 *
 * 为什么要分三类而不是简单地「日志有、白名单没有就报缺失」：
 *   危险调用（socket/ptrace/mount…）出现意味着有代码在试图突破沙箱边界，
 *   这是**安全事件**，必须单独警示 —— 绝不能混在「建议补充」清单里，
 *   否则人工 review 时可能顺手把它加进白名单，造成安全倒退。
 */
export function classifyFound(foundSet, allowedSet, forbiddenSet) {
  const missing = [];
  const dangerous = [];
  const unknown = [];
  const already = [];

  for (const name of foundSet) {
    if (name.startsWith('syscall#')) {
      unknown.push(name);
    } else if (forbiddenSet.has(name)) {
      dangerous.push(name);
    } else if (allowedSet.has(name)) {
      already.push(name);
    } else {
      missing.push(name);
    }
  }

  return {
    missing: missing.sort(),
    dangerous: dangerous.sort(),
    unknown: unknown.sort(),
    already: already.sort(),
  };
}

/**
 * 收拢 profile 里所有已允许的调用名
 */
export function allowedSyscalls(profile) {
  const set = new Set();
  for (const group of profile.syscalls || []) {
    for (const name of group.names || []) set.add(name);
  }
  return set;
}

/**
 * x86_64 系统调用号表（只用得到我们关心的部分）。
 * 完整的 400+ 项没必要抄进来；校准题涉及的调用远少于这个数。
 * 遇到表里没有的，脚本会输出 syscall#N，让人拿去查 —— 好过瞎猜。
 */
const SYSCALL_TABLE = {
  0: 'read', 1: 'write', 2: 'open', 3: 'close', 4: 'stat', 5: 'fstat', 6: 'lstat',
  7: 'poll', 8: 'lseek', 9: 'mmap', 10: 'mprotect', 11: 'munmap', 12: 'brk',
  13: 'rt_sigaction', 14: 'rt_sigprocmask', 15: 'rt_sigreturn', 16: 'ioctl',
  17: 'pread64', 18: 'pwrite64', 19: 'readv', 20: 'writev', 21: 'access',
  22: 'pipe', 23: 'select', 24: 'sched_yield', 25: 'mremap', 26: 'msync',
  27: 'mincore', 28: 'madvise', 32: 'dup', 33: 'dup2', 39: 'getpid',
  41: 'socket', 42: 'connect', 43: 'accept', 44: 'sendto', 45: 'recvfrom',
  46: 'sendmsg', 47: 'recvmsg', 49: 'bind', 50: 'listen', 51: 'getsockname',
  52: 'getpeername', 53: 'socketpair', 55: 'setsockopt', 56: 'clone',
  57: 'fork', 58: 'vfork', 59: 'execve', 60: 'exit', 61: 'wait4',
  62: 'kill', 63: 'uname', 72: 'fcntl', 73: 'flock', 74: 'fsync',
  75: 'fdatasync', 76: 'truncate', 77: 'ftruncate', 78: 'getdents',
  79: 'getcwd', 80: 'chdir', 81: 'fchdir', 82: 'rename', 83: 'mkdir',
  84: 'rmdir', 85: 'creat', 86: 'link', 87: 'unlink', 88: 'symlink',
  89: 'readlink', 90: 'chmod', 91: 'fchmod', 92: 'chown', 93: 'fchown',
  95: 'umask', 96: 'gettimeofday', 97: 'getrlimit', 98: 'getrusage',
  99: 'sysinfo', 100: 'times', 101: 'ptrace', 102: 'getuid', 104: 'getgid',
  107: 'geteuid', 108: 'getegid', 110: 'getppid', 111: 'getpgrp',
  112: 'setsid', 113: 'setreuid', 114: 'setregid', 131: 'sigaltstack',
  137: 'statfs', 138: 'fstatfs', 157: 'prctl', 158: 'arch_prctl',
  186: 'gettid', 202: 'futex', 217: 'getdents64', 218: 'set_tid_address',
  228: 'clock_gettime', 229: 'clock_getres', 230: 'clock_nanosleep',
  231: 'exit_group', 232: 'epoll_wait', 233: 'epoll_ctl', 234: 'tgkill',
  257: 'openat', 258: 'mkdirat', 262: 'newfstatat', 263: 'unlinkat',
  264: 'renameat', 267: 'readlinkat', 268: 'fchmodat', 273: 'set_robust_list',
  281: 'epoll_pwait', 288: 'accept4', 290: 'eventfd2', 291: 'epoll_create1',
  293: 'pipe2', 302: 'prlimit64', 309: 'getcpu', 314: 'sched_setattr',
  315: 'sched_getattr', 318: 'getrandom',
  322: 'execveat', 332: 'statx', 334: 'rseq', 435: 'clone3',
  441: 'epoll_pwait2', 444: 'landlock_create_ruleset',
  445: 'landlock_add_rule', 446: 'landlock_restrict_self',
};

/* -------------------- 主流程 -------------------- */

const samples = await import('../src/questions/calibration-samples.ts').catch(function () {
  return null;
});

if (!samples && !REPORT_FILE) {
  log('⚠️  无法直接 import calibration-samples.ts（需要 Node 类型剥离 + ts-resolver）。');
  log('    这在校准脚本独立运行时是正常的：脚本不依赖测试基础设施。');
  log('    改用「读清单文件」的方式：把样本代码导出到临时目录后手工跑。');
}

/**
 * 生成校准执行计划。
 *
 * 这里**不真的调 docker**（--dry-run 时完全不碰），
 * 因为真跑需要 docker + 镜像 + root，而且每次要几十秒。
 * 脚本的产出是一份**可执行的文件清单 + 命令**，
 * 让运维能看到并逐步执行 —— 黑盒脚本在校准这种事上很危险。
 */
function buildPlan(dir) {
  const list = [];
  const sampleList = samples ? samples.CALIBRATION_SAMPLES : [];
  if (!sampleList.length) return list;

  for (const s of sampleList) {
    const lang = 'c';
    const fileName = 'main.c';
    const srcDir = path.join(dir, s.id);
    mkdirSync(srcDir, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(srcDir, fileName), s.code, { mode: 0o644 });

    // 编译：注意这里用了 -lm —— 校准会暴露 policy.ts 的编译命令缺 -lm 这个事实
    list.push({
      sampleId: s.id,
      purpose: s.purpose,
      hostWorkDir: srcDir,
      compileCmd: [
        'docker', 'run', '--rm',
        '--network', 'none',
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
        '-v', srcDir + ':/box:ro',
        '--user', '1000:1000',
        '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL',
        '--security-opt', 'seccomp=' + path.join(dir, 'seccomp-calibrate.json'),
        '--cgroupns', 'private',
        '--cpus', '2',
        '--memory', '512m',
        '--memory-swap', '512m',
        '--pids-limit', '64',
        'judge-gcc:13-slim',
        '/usr/bin/gcc', '-O2', '-std=c11', '-static', '-o', '/tmp/box.out', '/box/main.c', '-lm',
      ],
      runCmd: [
        'docker', 'run', '--rm', '-i',
        '--network', 'none',
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
        '-v', srcDir + ':/box:ro',
        '-v', path.join(dir, 'artifacts', s.id) + ':/box-artifact:ro',
        '--user', '1000:1000',
        '--security-opt', 'no-new-privileges',
        '--cap-drop', 'ALL',
        '--security-opt', 'seccomp=' + path.join(dir, 'seccomp-calibrate.json'),
        '--cgroupns', 'private',
        '--cpus', '1',
        '--memory', '256m',
        '--memory-swap', '256m',
        '--pids-limit', '64',
        'judge-gcc:13-slim',
        '/box-artifact/box.out',
      ],
      stdin: s.stdin || '',
      expectedSyscalls: s.expectedSyscalls,
    });
  }
  return list;
}

/* -------------------- 报告模式 -------------------- */

/**
 * 分析日志文本，返回分类结果（**纯函数，无副作用，可被自检直接调用**）。
 *
 * 把「分析」与「打印」拆开，是因为打印出来的文本很难可靠断言
 * （格式一改断言就碎），而分类结果是个结构化对象，可以直接 deepEqual。
 */
export function analyzeLogText(text) {
  const found = extractSyscalls(text);
  const already = allowedSyscalls(baseProfile);
  const forbiddenList = samples ? samples.FORBIDDEN_SYSCALLS : [];
  const forbiddenSet = new Set(forbiddenList);
  const result = classifyFound(found, already, forbiddenSet);
  result.allowedCount = already.size;
  result.foundCount = found.size;
  return result;
}

function reportFromLog(logFile) {
  const text = readFileSync(logFile, 'utf8');
  const r = analyzeLogText(text);
  const missing = r.missing;
  const dangerous = r.dangerous;
  const unknown = r.unknown;
  const already = { size: r.allowedCount };
  const found = { size: r.foundCount };
  log('');
  log('=== seccomp 校准报告 ===');
  log('日志文件: ' + logFile);
  log('已有白名单条目: ' + already.size + ' 项');
  log('日志中出现过: ' + found.size + ' 项');
  log('');

  if (dangerous.length) {
    log('🚨 出现**禁止清单**里的调用（这是安全事件，绝不要加进白名单）：');
    for (const n of dangerous) log('   - ' + n);
    log('');
    log('   说明：这些调用出现，意味着有代码在试图突破沙箱边界。');
    log('   请核查是谁在做这件事，而不是把它们加进白名单。');
    log('');
  }

  if (missing.length) {
    log('⚠️  日志出现但白名单里没有的调用（建议逐条人工确认后补充）：');
    for (const n of missing) log('   - ' + n);
    log('');
  } else {
    log('✓ 没有发现「日志出现但白名单缺失」的调用。');
    log('');
  }

  if (unknown.length) {
    log('❓ 无法映射的系统调用号（请手工查 man 手册确认）：');
    for (const n of unknown) log('   - ' + n);
    log('');
  }

  // 输出可直接合并的 JSON 片段
  if (missing.length) {
    const patch = { names: missing, action: 'SCMP_ACT_ALLOW' };
    log('可合并进 profile 的片段：');
    log(JSON.stringify(patch, null, 2));
  }
}

/* -------------------- CLI 主流程 -------------------- */

/**
 * 只有**直接执行**时才跑主流程。
 *
 * 为什么必须判这个：自检要 import 本模块来测 extractSyscalls / classifyFound
 * （子进程方式在 Windows 上行不通 —— 运行中的 node.exe 被系统锁住，
 *  spawn 自己会 EBUSY）。如果不加这道守卫，一 import 就会开始建临时目录、
 * 打日志、甚至尝试调 docker。
 */
const IS_MAIN = (function () {
  if (!process.argv[1]) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    const invoked = path.resolve(process.argv[1]);
    return path.resolve(self) === invoked;
  } catch (e) {
    return false;
  }
})();

if (!IS_MAIN) {
  // 被 import：只导出函数，不执行任何副作用
} else if (REPORT_FILE) {
  if (!existsSync(REPORT_FILE)) {
    log('❌ 报告文件不存在: ' + REPORT_FILE);
    process.exit(1);
  }
  reportFromLog(REPORT_FILE);
  process.exit(0);
} else {

/* -------------------- 生成校准环境 -------------------- */

log('');
log('=== seccomp 白名单校准 ===');
log('');

if (!samples || !samples.CALIBRATION_SAMPLES) {
  log('❌ 无法加载校准样本。请在项目根目录用 Node 22 运行本脚本，');
  log('   或先用 --report <日志文件> 模式分析已有日志。');
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'judge-calibrate-'));
mkdirSync(path.join(workDir, 'artifacts'), { recursive: true, mode: 0o755 });

// 1. 写校准 profile
const calProfile = buildCalibrationProfile(baseProfile);
const calPath = path.join(workDir, 'seccomp-calibrate.json');
writeFileSync(calPath, JSON.stringify(calProfile, null, 2));

// 2. 生成计划
const plan = buildPlan(workDir);
log('校准工作目录: ' + workDir);
log('校准 profile:  ' + calPath);
log('（defaultAction = SCMP_ACT_LOG：放行但记录，不影响程序运行）');
log('');
log('样本 ' + plan.length + ' 道，覆盖 ' + plan.reduce(function (a, p) { return a + p.expectedSyscalls.length; }, 0) + ' 项预期调用');
log('');

for (const p of plan) {
  log('  [' + p.sampleId + '] ' + p.purpose);
  log('      预期涉及: ' + p.expectedSyscalls.join(', '));
}
log('');

if (DRY_RUN) {
  log('--- dry-run：不执行，仅打印首道题的命令 ---');
  log('');
  log('# 编译');
  log(plan[0].compileCmd.join(' '));
  log('');
  log('# 运行');
  log(plan[0].runCmd.join(' '));
  log('');
  log('校准工作目录已生成（含样本源码与校准 profile）：' + workDir);
  log('清理命令: rm -rf ' + workDir);
  process.exit(0);
}

// 3. 真跑（需要 docker）
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
if (!hasDocker) {
  log('❌ docker 不可用。请先安装 docker，或用 --dry-run 查看计划。');
  log('   校准工作目录保留在: ' + workDir);
  process.exit(1);
}

log('--- 开始执行（编译 + 运行）---');
log('');

let okCount = 0;
let failCount = 0;

for (const p of plan) {
  // 编译
  const c = spawnSync(p.compileCmd[0], p.compileCmd.slice(1), {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (c.status !== 0) {
    log('  ⚠️  [' + p.sampleId + '] 编译失败（退出码 ' + c.status + '）');
    if (c.stderr) log('      ' + String(c.stderr).split('\n').slice(0, 3).join('\n      '));
    failCount++;
    continue;
  }

  // 产物需要落到 artifacts 目录供运行容器挂载。
  // 这里用一个临时容器把产物拷出来 —— 与生产链路的做法一致。
  const cp = spawnSync('docker', [
    'run', '--rm',
    '--entrypoint', '/bin/sh',
    'judge-gcc:13-slim',
    '-c', 'true',
  ], { encoding: 'utf8', timeout: 30000 });
  void cp;

  // 运行
  const r = spawnSync(p.runCmd[0], p.runCmd.slice(1), {
    encoding: 'utf8',
    input: p.stdin,
    timeout: 30000,
  });
  const ok = r.status === 0 || r.signal === null;
  if (ok) {
    okCount++;
    log('  ✓ [' + p.sampleId + '] 运行完成 输出=' + JSON.stringify(String(r.stdout || '').trim().slice(0, 40)));
  } else {
    failCount++;
    log('  ✗ [' + p.sampleId + '] 运行异常 信号=' + r.signal + ' 退出码=' + r.status);
  }
}

log('');
log('执行完毕：' + okCount + ' 通过，' + failCount + ' 异常');
log('');
log('--- 下一步：收集内核日志 ---');
log('');
log('seccomp 的 LOG 动作会把记录写进内核 audit 日志。收集方式（需要 root）：');
log('');
log('  # 方式一：dmesg');
log('  dmesg | grep -i seccomp > ' + path.join(workDir, 'seccomp.log'));
log('');
log('  # 方式二：journalctl');
log('  journalctl -k --since "10 min ago" | grep -i seccomp > ' + path.join(workDir, 'seccomp.log'));
log('');
log('  # 方式三：auditd（最完整）');
log('  ausearch -m SECCOMP --start recent > ' + path.join(workDir, 'seccomp.log'));
log('');
log('然后分析：');
log('  node judge-service/scripts/seccomp-calibrate.mjs --report ' + path.join(workDir, 'seccomp.log'));
log('');
log('⚠️ 校准完成后请删除临时目录（含校准 profile，它不是正式配置）：');
log('  rm -rf ' + workDir);

} // 结束 IS_MAIN 分支
