/**
 * seccomp 白名单校准题集
 *
 * 用途：用这 10 道题**实跑**一遍完整编译运行路径，把 seccomp 白名单里
 * 缺失的系统调用找出来。
 *
 * 为什么必须是这 10 道而不是随便 1 道：
 *   不同的 C 库函数会触发完全不同的系统调用。比如
 *     printf   → write
 *     malloc   → brk / mmap
 *     qsort    → 无新调用（纯用户态）
 *     sqrt     → 可能触发浮点上下文相关调用
 *     scanf    → read
 *   只跑一道「hello world」只能覆盖 write/exit/brk 三个调用，
 *   白名单看起来「通过了」，上线后学生写个快排就 RE。
 *
 * 每道题都标注了它**专门用来暴露哪类调用**，这样将来加了新题型，
 * 可以照着这张表补样本。
 *
 * ⚠️ 这些题目只用于校准，不是题库内容。
 *    它们跑在**校准模式**下（seccomp 动作改为 SCMP_ACT_LOG），
 *    只收集日志，不产生判题结论。
 */

/** 校准模式下的单道样本 */
export interface CalibrationSample {
  id: string;
  /** 这道题考什么（写给运维看，不是给用户） */
  purpose: string;
  /** 预期会触及的系统调用族（用于人工核对，不是断言） */
  expectedSyscalls: string[];
  /** 需要 stdin 输入吗 */
  stdin?: string;
  code: string;
}

export const CALIBRATION_SAMPLES: CalibrationSample[] = [
  {
    id: 'cal-01-hello',
    purpose: '最小基线：验证进程能起、能写、能退出',
    expectedSyscalls: ['execve', 'write', 'exit_group', 'brk'],
    code: `#include <stdio.h>
int main(void) {
    printf("hello\\n");
    return 0;
}
`,
  },
  {
    id: 'cal-02-scanf',
    purpose: '标准输入：暴露 read / 可能的 poll / ioctl（stdin 是管道时）',
    expectedSyscalls: ['read', 'write', 'ioctl', 'fstat'],
    stdin: '42 7\n',
    code: `#include <stdio.h>
int main(void) {
    int a, b;
    if (scanf("%d %d", &a, &b) != 2) return 1;
    printf("%d\\n", a + b);
    return 0;
}
`,
  },
  {
    id: 'cal-03-malloc-large',
    purpose: '大块动态内存：暴露 mmap / munmap（超过 MMAP_THRESHOLD 时 glibc 走 mmap 而非 brk）',
    expectedSyscalls: ['mmap', 'munmap', 'brk', 'madvise'],
    code: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
    /* 1MB 远超默认 MMAP_THRESHOLD(128KB)，会走 mmap 分支 */
    size_t n = 1024 * 1024;
    char *p = (char *)malloc(n);
    if (!p) { printf("oom\\n"); return 1; }
    memset(p, 'A', n);
    printf("%c %zu\\n", p[n - 1], n);
    free(p);
    return 0;
}
`,
  },
  {
    id: 'cal-04-string',
    purpose: '字符串函数：验证无新调用（纯用户态），同时确认 strtod 不触发 locale 相关调用',
    expectedSyscalls: ['write', 'brk'],
    code: `#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(void) {
    char buf[128];
    strcpy(buf, "3.5 hello");
    char *end = NULL;
    double v = strtod(buf, &end);
    /* strstr / strtok / memmove 全在用户态 */
    char *tok = strtok(end, " ");
    printf("%.1f %s %zu\\n", v, tok ? tok : "nil", strlen(buf));
    return 0;
}
`,
  },
  {
    id: 'cal-05-qsort',
    purpose: '快排与递归：验证无新调用，但栈深度大时可能触发 mremap（栈增长）',
    expectedSyscalls: ['mremap', 'mmap', 'write'],
    code: `#include <stdio.h>
#include <stdlib.h>

static int cmp(const void *a, const void *b) {
    return (*(int *)a) - (*(int *)b);
}

int main(void) {
    int n = 100000;
    int *arr = (int *)malloc(sizeof(int) * n);
    if (!arr) return 1;
    unsigned seed = 12345;
    for (int i = 0; i < n; i++) {
        /* 线性同余，避免 rand() 触发 /dev/urandom 读取 */
        seed = seed * 1103515245u + 12345u;
        arr[i] = (int)(seed >> 16);
    }
    qsort(arr, n, sizeof(int), cmp);
    printf("%d %d\\n", arr[0], arr[n - 1]);
    free(arr);
    return 0;
}
`,
  },
  {
    id: 'cal-06-math',
    purpose: '数学库 + 浮点：暴露可能的 getcpu / rseq（线程/CPU 亲和相关）',
    expectedSyscalls: ['write', 'getcpu', 'rseq'],
    code: `#include <stdio.h>
#include <math.h>
int main(void) {
    double x = 2.0;
    /* 链接时需 -lm；policy.ts 的编译命令目前没带 -lm，这道题会暴露出来 */
    double r = sqrt(x);
    printf("%.4f %.4f\\n", r, pow(x, 10));
    return 0;
}
`,
  },
  {
    id: 'cal-07-file-io',
    purpose: '文件读写：暴露 openat / unlink / fsync（在容器只读根 fs 下应只有 /tmp 可写）',
    expectedSyscalls: ['openat', 'write', 'read', 'close', 'unlink', 'fsync'],
    code: `#include <stdio.h>
#include <stdlib.h>
int main(void) {
    const char *path = "/tmp/cal-test.txt";
    FILE *f = fopen(path, "w");
    if (!f) { printf("open-fail\\n"); return 1; }
    fprintf(f, "calibration\\n");
    fclose(f);

    f = fopen(path, "r");
    if (!f) { printf("reopen-fail\\n"); return 1; }
    char buf[64] = {0};
    if (!fgets(buf, sizeof(buf), f)) { fclose(f); return 1; }
    fclose(f);
    printf("%s", buf);
    remove(path);
    return 0;
}
`,
  },
  {
    id: 'cal-08-fork',
    purpose: '进程创建：暴露 clone3（新版 glibc 优先用 clone3，老 profile 常漏）',
    expectedSyscalls: ['clone', 'clone3', 'wait4', 'exit_group'],
    code: `#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
    pid_t pid = fork();
    if (pid < 0) { printf("fork-fail\\n"); return 1; }
    if (pid == 0) {
        printf("child\\n");
        _exit(0);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    printf("parent %d\\n", WEXITSTATUS(st));
    return 0;
}
`,
  },
  {
    id: 'cal-09-time',
    purpose: '时间与计时：暴露 clock_gettime / gettimeofday / nanosleep',
    expectedSyscalls: ['clock_gettime', 'nanosleep', 'write'],
    code: `#include <stdio.h>
#include <time.h>
int main(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    long sec = (long)ts.tv_sec;
    struct timespec req = {0, 1000000}; /* 1ms */
    nanosleep(&req, NULL);
    printf("%ld\\n", sec > 0 ? 1 : 0);
    return 0;
}
`,
  },
  {
    id: 'cal-10-deep-recursion',
    purpose: '深递归 + 大栈：暴露栈自动增长（mremap）与可能的 SIGSEGV 处理路径',
    expectedSyscalls: ['mremap', 'mmap', 'rt_sigaction', 'write'],
    code: `#include <stdio.h>

static long sum(long n) {
    if (n <= 0) return 0;
    /* 递归深度 50000：栈会自动增长，触发 mremap */
    return n + sum(n - 1);
}

int main(void) {
    printf("%ld\\n", sum(50000));
    return 0;
}
`,
  },
];

/**
 * 校准模式专用：这些调用是**我们刻意要拒绝**的。
 *
 * 如果日志里出现了它们，说明用户代码在尝试突破沙箱边界 ——
 * 这是安全事件，不是白名单遗漏，**绝不能**把它们加进白名单。
 *
 * 用途：校准脚本用这份清单做「误加保护」——
 * 如果有人在白名单里补了这些调用，自检会失败。
 */
export const FORBIDDEN_SYSCALLS: string[] = [
  'socket',
  'socketpair',
  'connect',
  'bind',
  'listen',
  'accept',
  'accept4',
  'sendto',
  'recvfrom',
  'sendmsg',
  'recvmsg',
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'mount',
  'umount',
  'umount2',
  'pivot_root',
  'unshare',
  'setns',
  'reboot',
  'kexec_load',
  'init_module',
  'finit_module',
  'delete_module',
  'bpf',
  'perf_event_open',
  'userfaultfd',
  'keyctl',
  'add_key',
  'request_key',
  'io_uring_setup',
  'io_uring_enter',
  'io_uring_register',
  'open_by_handle_at',
  'name_to_handle_at',
  'acct',
  'settimeofday',
  'clock_settime',
  'adjtimex',
  'swapon',
  'swapoff',
  'quotactl',
];

/**
 * 常见但**容易误判**的调用：它们看起来危险，实际是正常程序必需的。
 *
 * 校准脚本会把它们单独列出来，避免人工 review 时误删。
 */
export const COMMONLY_MISJUDGED: Array<{ name: string; reason: string }> = [
  { name: 'clone3', reason: 'glibc 2.34+ 的 fork/pthread 优先走 clone3。老 profile 常只有 clone，导致 fork 直接 EPERM' },
  { name: 'rseq', reason: 'glibc 2.35+ 启动时注册 rseq（重启序列），缺失会导致线程创建异常' },
  { name: 'mremap', reason: '栈自动增长、realloc 大块内存时会用。缺了会表现为「深递归莫名段错误」' },
  { name: 'getcpu', reason: '某些 libc 版本启动时探测 CPU，缺失不致命但会产生噪声日志' },
  { name: 'landlock_*', reason: '内核 LSM 调用。容器里通常用不到，但 glibc 探测时会尝试（失败也继续）' },
  { name: 'ioctl', reason: '看似危险，实际 isatty()、终端尺寸探测都需要。禁掉会让 printf 在没有 tty 时行为异常' },
  { name: 'prlimit64', reason: '常见的误判对象——它只读/改自身 rlimit，不给提权' },
];
