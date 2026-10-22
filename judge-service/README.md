# 判题服务（judge-service）

> 对应方案 v1.1 §8.4 的 **12 项沙箱安全加固**，Phase 2 交付。
> 自检：`node tests/judge.test.mjs` 与 `node tests/judge-http.test.mjs`（都不需要 docker 即可跑通）

---

## 为什么这个服务必须独立于微信云开发

微信云函数运行在共享运行时里，**无法做容器隔离、无法限制系统调用、无法限制 CPU/内存**。
直接执行用户提交的任意代码 = 把服务器交出去。

所以判题只能落在自建服务上。业务层（用户、题库、进度、社交、订单）继续用云开发，
只有「执行用户代码」这一件事走自建——这是成本最低、职责最清晰的组合。

---

## 目录结构

```
judge-service/
├── src/
│   ├── contract.ts              ★ 跨端契约（与 miniprogram/services/judge-contract.ts 逐字节一致）
│   ├── auth.ts                  ★ 鉴权契约：请求头名、签名串拼法、失败原因码、时间窗
│   ├── auth/
│   │   ├── hmac.ts              ★ HMAC-SHA256 签名与校验（常量时间比较、双向时间窗）
│   │   └── nonce.ts             nonce 重放拦截（内存 / Redis / 自动降级）
│   ├── redis/
│   │   ├── client.ts            零依赖最小 RESP2 客户端（自动重连、命令超时）
│   │   ├── rate-counter.ts      ★ Redis 限流计数器（原子 Lua）+ fail-open 降级
│   │   └── result-cache.ts      ★ Redis 结果缓存（幂等跨实例共享）+ fail-open 降级
│   ├── server.js                ★ HTTP 入口（路由 / 鉴权 / nonce / 并发闸门 / 优雅退出）
│   ├── server.ts                ↑ 同一份内容的 TS 副本，仅用于自检 import（必须逐字节一致）
│   ├── bootstrap.ts             ★ 组装入口：环境变量 → 适配器 → JudgeService
│   ├── adapters.ts              基础适配器：内存题库/缓存、本地工作区、文件名
│   ├── sandbox/
│   │   ├── policy.ts            ★ 安全策略 → docker 参数（纯函数，可单测）
│   │   ├── runner.ts            编排：编译 → 收集产物 → 逐点运行；内部接口是注入式的
│   │   ├── docker-executor.ts   真机执行器（docker run / docker kill）
│   │   └── ratelimit.ts         提交频率限制（第 11 项加固）
│   ├── judges/
│   │   ├── classify.ts          ★ 结果分类：退出码/信号/内存/耗时 → 判题结论
│   │   ├── index.ts             主流程编排（不认识任何具体题库实现）
│   │   └── types-internal.ts    内部接口（依赖注入用）
│   └── questions/
│       ├── testcases.ts         测试点、比对口径、防泄题的 preview 生成
│       ├── source.ts            ★ 题库来源端口 + 内存/HTTP/云开发三通道 + 规范化
│       ├── providers.ts         ★ PlanRepository：缓存、错误语义、规范化接线
│       └── calibration-samples.ts ★ seccomp 校准用的 10 道题 + 禁止调用清单
├── etc/seccomp-judge.json       seccomp 白名单 profile（基线，需实跑校准）
├── images/                      ★ 沙箱镜像（自建，不能用公共镜像）
│   ├── Dockerfile.gcc           C / C++ 沙箱镜像
│   ├── Dockerfile.python        Python 沙箱镜像（删网络模块与 pip）
│   └── build.sh                 构建 + 自动校验（UID / 无外联工具 / 无 pip…）
├── scripts/
│   ├── seccomp-calibrate.mjs    ★ seccomp 白名单实跑校准工具
│   └── check-adapters.mjs       ★ 外部依赖入口体检（搭云服务前后各跑一次）
├── test/fixtures/               校准日志夹具（自检用，验证日志解析逻辑）
├── Dockerfile                   控制面镜像
└── docker-compose.yml           本地/内测编排
```

客户端与云函数侧：

```
miniprogram/services/
├── judge-contract.ts            契约客户端副本（与服务端逐字节一致）
├── judge-client.ts              走 wx.cloud.callFunction 交给云函数中转
└── judge.ts                     判分调度（本地 L1 / 远程 L2）

cloudfunctions/judgeSubmit/
├── index.js                     ★ 注入内部 token + HMAC 签名后转发（纯 JS，云函数无类型剥离）
├── package.json                 零依赖
└── config.json                  超时 20s
```

---

## HTTP 接口

### `POST /judge` —— 提交判题

请求头（全部必需）：

| 头 | 说明 |
|---|---|
| `X-Judge-Token` | 内部 token。**只标识调用方身份**，不参与防重放 |
| `X-Judge-Timestamp` | 毫秒时间戳字符串（纯数字，不接受科学计数法） |
| `X-Judge-Nonce` | 一次性随机串，每次请求都必须全新，≤ 96 字符 |
| `X-Judge-Signature` | HMAC-SHA256 的 hex（64 字符小写） |
| `X-Judge-Caller` | 可选，仅用于日志与排障，不参与签名 |

请求体：

```json
{
  "payload": {
    "submissionId": "q5-1a2b3c",
    "questionId": "q_prog_sum_1_to_n",
    "type": "code-editor",
    "language": "c",
    "code": "#include <stdio.h>\n...",
    "limits": { "runMs": 1000, "memoryMB": 256 }
  },
  "userId": "oXXXX-openid"
}
```

> `limits` 只能**收紧**，服务端会再夹一层硬上限（`contract.HARD_LIMITS`）。
> `userId` 只用于限流分桶；真正的身份由云函数从 `getWXContext().OPENID` 取，请求体里的值不可信。

响应（成功）：

```json
{
  "ok": true,
  "response": { "verdict": "accepted", "score": 1, "passed": 3, "total": 3, "cases": [], "cacheHit": false, ... },
  "result": { "correct": true, "partial": false, "score": 1, "detail": "全部测试点通过（3/3）", "layer": "remote", "strategy": "sandbox" }
}
```

响应（失败）：

```json
{ "error": { "code": "rate-limited", "message": "提交过于频繁（每分钟上限 30 次），请稍后再试", "retryAfterMs": 42000 } }
```

### 错误码 → HTTP 状态码

| 错误码 | 状态 | 说明 |
|---|---|---|
| `unauthorized` | 401 | 缺字段 / token 不符 / 时间戳超窗 / 签名不符 / nonce 重放 |
| `forbidden` | 403 | 无权访问该题（越权提交） |
| `rate-limited` | 429 | 频率超限，**带 `Retry-After`** |
| `payload-too-large` | 413 | 请求体或代码超限 |
| `unsupported-language` | 400 | 语言不支持 |
| `question-not-found` | 404 | 题目不存在或无判题计划 |
| `session-expired` | 410 | 场次已结束（资源存在但不可用，故用 410 而非 404） |
| `busy` | 503 | 判题队列饱和，**带 `Retry-After`**。语义是「我无资源」而非「你请求多」 |
| `internal` | 500 | 未分类错误（含输入非法：空代码等，见下方说明） |

**429 与 503 必须分开**：前端对 429 应当「等冷却时间再试」，对 503 应当「换实例 / 退避更久」。
合并成一个码会让整套重试策略失灵。

> 空代码、缺少必要字段这类**客户端输入错误**，`precheck()` 只能报 `internal`（契约里没有更细的码）。
> `server.js` 的 `precheckStatus()` 会按消息语义把它们纠正成 400。
> 不纠正的后果有两个：前端会给出「重试」按钮（而空代码重试一万次还是空代码），
> 以及监控把用户传坏数据算成我们的 5xx 故障率，导致真出事时告警被噪声淹没。

### `GET /healthz` —— liveness

不做鉴权（k8s 探针不会带 token），且**不检查任何外部依赖**。
进程活着就 200。依赖挂掉应当由 `readyz` 摘流量，而不是让 k8s 重启进程——
混淆两者会导致「Redis 抖一下，所有判题节点被重启」。

### `GET /readyz` —— readiness

```json
{ "ready": true, "reasons": [], "checks": { "redis": true, "capacity": true } }
```

判据只有一条：**还有并发容量**。饱和时返回 503，让负载均衡把新流量给别的实例
（这是过载时自动扩容的触发点）。

Redis 不可用**不算 not ready**：限流与重放拦截都有降级路径（见下），判题本身仍能跑。
把依赖故障一律当 not ready，会让「Redis 抖 5 秒」升级成「全部判题节点被摘」。

### `GET /metrics` —— 最小指标

只给 `inflight` / `uptimeMs` / `rateLimiterDegraded` 三项，**不带任何用户维度**。

---

## 鉴权协议

### 签名串拼法（契约，不要动）

```
v1 \n METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
```

- 版本号 `v1`：换算法时必须升版本，让新旧两端能共存一段时间。
- 分隔符是 `\n` 而不是 `|`：字段值（如路径 query）里可能出现任何可打印字符，
  用固定不可打印分隔符能从根上避免「字段值里带分隔符造成歧义」这类拼接漏洞。
- 签的是 body 的 **SHA-256 哈希**而不是 body 本身：body 可能 64KB，没必要每次都参与 HMAC；
  哈希已经绑定完整内容。

### 为什么是「token + HMAC 签名」而不是裸 token

| 方案 | 问题 |
|---|---|
| 裸 token | token 每个请求原样传输。一旦落到日志/代理/抓包里，攻击者能无限期伪造提交 |
| Basic Auth | 同上，且 base64 不是加密 |
| **token + HMAC** | 请求体被改则签名不匹配；时间戳 + nonce 让抓到的签名只能在极短时间内用一次 |

### 校验顺序（不能换）

```
① 字段齐全性 → ② 时间戳格式 → ③ 时间窗（双向） → ④ token → ⑤ 签名 → ⑥ nonce 登记
```

两个刻意的设计：

- **时间窗双向校验**。只查「太旧」不够：时间戳在未来同样危险，等于给攻击者一个更长的重放窗口。
- **只有验签通过才登记 nonce**。反过来的话，攻击者可以不带有效签名就消耗掉 nonce 空间（廉价 DoS），
  而且能把合法用户的 nonce 提前占掉。

### 三层验证目标（任意一层被绕过都是事故）

1. **token** —— 证明「调用方是业务层」，不参与防重放。
2. **HMAC 签名** —— 证明「这个请求体确实由持 token 的人构造过，且没被改过」。
3. **nonce 独占** —— 证明「这个请求没被重放过」。签名本身挡不住重放。

token 比较也走**常量时间**（先各自 SHA-256 再比较），理由：token 泄漏比签名更难发现，且同样可被暴力猜。

### nonce 重放的实现要点

⚠️ **不能先查后写**：

```js
// 错误：两个并发请求可以同时通过 has()，然后都 set() 成功 —— 重放成功
if (await has(nonce)) return replay;
await set(nonce);
```

```js
// 正确：把「写入并独占」当成唯一原语，写入失败即重放
const ok = await redis.command(['SET', key, '1', 'NX', 'PX', ttl]);   // 原子
return ok !== null;                                                    // nil = 已被用过
```

内存实现之所以在单进程里也安全：Node 单线程，只要 check-and-set 之间**没有 await** 就不会被打断。
自检里有一条显式的**并发重放**用例（`Promise.all` 四次 `claim`，只允许一次成功）——
顺序重放的用例过不了这一关，先查后写的实现能被它抓住。

---

## 限流与降级

### Redis 计数器：为什么必须用 Lua

```lua
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
```

两种朴素写法都是错的：

| 写法 | 后果 |
|---|---|
| `INCR` 然后 `PEXPIRE`（两步） | 两命令之间断连 → key **永不过期** → 该用户被永久限流。只在网络抖动时出现，本地测不出来 |
| 每次都 `PEXPIRE` | 窗口被无限续期 → 用户只要持续提交就永远不重置。那不是限流，是惩罚 |

脚本里还补了一段：`if ttl < 0 then PEXPIRE`（防上次脚本中断把 key 留成无过期时间）。

### fail-open：Redis 挂掉时放行

Redis 不可用时**跳过限流、放行、打点告警**。

理由：判题算力是**可恢复成本**（多烧点 CPU），而「所有用户都不能提交代码」是**用户可感知的功能故障**。
两害相权，宁可多花钱也不要让功能全挂。

保留**同实例内的本地兜底计数**：Redis 挂掉的瞬间，单实例上的高频攻击仍被挡住，
跨实例的绕过我们接受（毕竟已告警）。

⚠️ **这个取舍对重放拦截不适用**。那里方向相反：主存储不可用时退回单实例内存实现
（`FailoverNonceStore`），而不是什么都不做——放行重放是安全事件，不是成本事件。

**安全降级与限流降级的正确方向是相反的，不要抄。**

### 同步接口 vs 异步存储的张力

`RateCounter` 接口是同步的（业务层不该知道存储是不是异步的），而 Redis 只能异步取。
处理方式是显式的两层：

1. `RedisRateCounter.incr()` 同步返回本地值（可能偏乐观），同时异步发 `EVAL`。
2. `JudgeService.submit()` 在限流判定**之前** `await prefetch(userId)`，
   用 `MGET` 把权威计数拉回本地 —— 于是多实例下的判定是准确的。

> ⚠️ `prefetch` 里有一个不报错的坑：本地兜底表的键必须用 **bucket**（`rl:m:<userId>`），
> 不能加 Redis 前缀。用前缀会让 `prefetch` 写入 `local['judge:rl:rl:m:u9']`
> 而 `get()` 去读 `local['rl:m:u9']` —— 永远读不到，表现为「限流永远放行」。

---

## 12 项加固逐条落点

| # | 加固项 | 落点 | 自检用例 |
|---|---|---|---|
| 1 | seccomp 白名单 | `--security-opt seccomp=...` + `etc/seccomp-judge.json` | 白名单不含 ptrace/socket/mount/unshare |
| 2 | 非 root 运行 | `--user 1000:1000`、`no-new-privileges`、`--cap-drop ALL` | 参数断言 |
| 3 | cgroup v2 隔离 | `--cgroupns private`、`--memory`、`--memory-swap`（=memory，关 swap）、`--pids-limit` | memory 与 memory-swap 必须相等 |
| 4 | 编译与运行分容器 | `runner.compile()` / `runner.run()` 各自 buildPlan，产物经宿主 `docker cp` 中转 | 两个容器名不同；编译失败时运行阶段被跳过 |
| 5 | 代码大小上限 | `contract.precheck()` 单文件 64KB / UTF-8 实算 | 超长代码被拒 |
| 6 | 编译超时 | `--ulimit` + Node 侧墙钟定时器 kill | 编译超时判 CE 并带提示 |
| 7 | 禁 ptrace | seccomp 显式不列 + `cap_drop ALL` 双保险 | profile 断言 |
| 8 | 禁用网络 | `--network none` | 参数断言 |
| 9 | 只读根 fs + 独立 tmpfs | `--read-only`；`--tmpfs /tmp:noexec`（**两阶段都开**）；源码 `:ro` 挂载；产物独立**只读可执行**挂载 `/box-artifact` | tmpfs 恒 noexec；产物不在 tmpfs；`artifactDirFor` 路径断言 |
| 10 | 输出大小上限 | 包装脚本按字节截断 → 判 OLE | 输出超限优先于答案比对 |
| 11 | 提交频率限制 | `sandbox/ratelimit.ts` + `redis/rate-counter.ts`（30 次/分、300 次/日） | 限流 + 被拒请求不消耗配额 + 原子 Lua + fail-open |
| 12 | 判题节点网络隔离 | compose 只绑 `127.0.0.1`；生产走独立安全组 | compose 断言 |

---

## 判题结论分类（最容易静默出错的地方）

```
① 编译失败          → compile-error            （最先判，编译不过谈不上运行）
② 输出超限          → output-limit-exceeded    （先于答案比对，输出爆炸时比对无意义）
③ 墙钟超时          → time-limit-exceeded
④ SIGXCPU           → time-limit-exceeded      （内核按 CPU 配额杀）
⑤ SIGKILL + 高内存  → memory-limit-exceeded    （有内存证据才算 MLE）
   SIGKILL + 低内存  → runtime-error            （不是用户内存超限，可能是外部终止）
⑥ 其他致命信号      → runtime-error            （SIGSEGV/SIGFPE/SIGABRT…）
⑦ 退出码非 0        → runtime-error
⑧ 输出比对          → accepted / wrong-answer
```

两个容易判错的地方，已在自检里专门覆盖：

- **SIGKILL 有双重语义**。它既可能是 OOM Killer（内存超限），也可能是运维强制终止。
  靠「峰值内存是否达到上限的 85%」区分。判错方向的话，用户会去优化一个不存在的内存问题。
- **SIGSYS 归到 system-error 而不是用户错误**。SIGSYS 意味着进程调用了 seccomp 白名单外的系统调用——
  通常是**我们的白名单缺了调用**，不是用户代码有问题。让用户背这个锅是错的。

---

## seccomp 白名单校准（🟡 工具已就绪，待真机执行）

`etc/seccomp-judge.json` 是**基线，不是最终版本**。校准工具已交付：

```bash
npm run seccomp:plan                    # 看校准计划（不碰 docker）
node judge-service/scripts/seccomp-calibrate.mjs    # 真跑 10 道校准题
npm run seccomp:report -- <内核日志文件>              # 分析结果
```

**核心设计：为什么用 `SCMP_ACT_LOG` 而不是 `SCMP_ACT_ALLOW`**

| 做法 | 结果 |
|---|---|
| `SCMP_ACT_ALLOW` | 全放行，**日志什么都没有** —— 收集不到信号 |
| `SCMP_ACT_ERRNO`（正式配置） | 被拦的调用直接失败，程序崩了但**不知道为什么崩** |
| **`SCMP_ACT_LOG`（校准用）** | **放行但记录** —— 程序正常跑完，同时把「本该被拦的调用」全记下来 |

我们需要的是「哪些调用是必需的」这个**信号**，而不是「拦住它们」这个**行为**。

**10 道校准题分工**（在 `src/questions/calibration-samples.ts`，每题都标注了用途）：
不同 C 库函数触发完全不同的系统调用，只跑 hello world 只能覆盖 3 个。

| 题 | 专门暴露什么 |
|---|---|
| cal-01 hello | 最小基线（execve/write/exit_group/brk） |
| cal-02 scanf | 标准输入的 read/ioctl/fstat |
| cal-03 大块 malloc | 超 MMAP_THRESHOLD 时走 mmap 而非 brk |
| cal-04 字符串 | 验证 strtod/strtok 无新调用（对照项） |
| cal-05 qsort | 大数组 + 栈增长触发 mremap |
| cal-06 数学库 | **暴露编译命令缺 `-lm`**（已修） |
| cal-07 文件 IO | openat/unlink（只读根 fs 下应只有 /tmp 可写） |
| cal-08 fork | **`clone3`** —— glibc 2.34+ 优先用它，老 profile 最常漏 |
| cal-09 计时 | clock_gettime/nanosleep |
| cal-10 深递归 | 栈自动增长（mremap）+ 信号处理路径 |

**分析器区分三类，而不是笼统报「缺失」**：

- **危险调用**（socket/ptrace/mount…）→ 单独警示为**安全事件**。
  绝不能混进「建议补充」清单，否则人工 review 时可能顺手加进白名单，造成安全倒退。
- **缺失调用** → 建议逐条确认后补充，并直接给出可合并的 JSON 片段。
- **未知编号** → 老实报 `syscall#7000` 让人去查，**不瞎猜**。

**为什么不能靠推测补白名单**：补错方向**比不补更糟**——补多了等于放开了安全边界，
补错了会让正常代码被判错。只有实跑日志能给出答案。

**校准结果合并后要做的回归**：把 `defaultAction` 换回 `SCMP_ACT_ERRNO`，
重跑 10 道题确认全部通过（这一步才是真正的验收）。

---

## 部署拓扑（⚠️ 与本地编排有重要差异）

本地 `docker-compose.yml` 为了省事直挂 `/var/run/docker.sock`。**生产不要这样做**：

```
                    ┌──────────────────────────┐
   小程序 → 云函数中转 │  业务层（云函数 judgeSubmit）│  ← 持 token，算签名
                    └────────────┬─────────────┘
                                 │ 内网 + token + HMAC 签名 + nonce
                    ┌────────────▼─────────────┐
                    │  判题控制面（本服务）      │  独立安全组，只接受业务层调用
                    └────────────┬─────────────┘
                                 │ Docker API
                    ┌────────────▼─────────────┐
                    │  一次性沙箱容器（跑用户码） │  --network none / 只读 / 限资源
                    └──────────────────────────┘
```

五个必须做的加固：

1. **判题节点独立安全组**，只放行来自业务层的来源 IP 与端口；不接受公网直连。
2. **控制面以非特权方式访问 Docker**。三种选择，按隔离强度递增：
   - 挂 socket + 控制面本身 `cap_drop ALL`（最省事，隔离最弱）
   - 独立的 **docker-socket-proxy**，只放行 `containers.create/start/kill/inspect`（推荐）
   - 判题节点与控制面分离，控制面通过远端 Docker API 调度（隔离最强，改造量最大）
3. **镜像与提交 ID 白名单**。`policy.ts` 里镜像名与命令全部来自服务端常量表；
   容器名由服务端生成并做字符白名单过滤（`sanitize()`）。**用户输入永远不进命令行**。
4. **独立磁盘与配额**。工作区挂独立卷并设 quota；容器 `--rm`，但控制面侧仍需 `finally` 清理
   （执行器崩溃时容器可能残留）。
5. **Redis 不得发布到宿主网卡**。限流计数一旦能从外部清掉，等于没有限流。
   compose 里 redis 只用 `expose`（内部 DNS 可达），**不用 `ports`**——
   docker 的端口发布默认绕过 ufw/iptables，`ports` 会把 6379 暴露到全网。

---

## 环境变量

| 变量 | 默认 | 必填 | 说明 |
|---|---|---|---|
| `JUDGE_INTERNAL_TOKEN` | — | **生产必填** | 缺则拒绝启动（不裸奔）。开发环境回落到带警告的占位值 |
| `JUDGE_SANDBOX` | `docker` | | **执行后端**：`docker`（12 项隔离，上线用）/ `local`（本机直跑，**零隔离**，仅自己开发/录题）。见下方「本地模式」 |
| `JUDGE_REDIS_URL` | — | 建议 | 缺则限流、重放拦截、结果缓存三处都退化为单实例内存实现并告警 |
| `JUDGE_PLAN_SOURCE` | `memory` | | 题库来源：`memory` / `http` / `cloud`。见下方「题库来源」 |
| `JUDGE_PLAN_BASE_URL` | — | http/cloud 必填 | 题库接口基址（cloud 填云开发 HTTP 访问服务域名） |
| `JUDGE_CLOUD_ENV_ID` | — | cloud 必填 | 云开发环境 ID |
| `JUDGE_PLAN_TOKEN` | — | 建议 | 题库接口凭据。**只从环境变量读，绝不进客户端** |
| `JUDGE_PLAN_TIMEOUT_MS` | 3000 | | 题库查询超时。题库慢不能拖住判题 |
| `JUDGE_PLAN_CACHE_TTL_MS` | 300000 | | 测试点缓存时长（判题是高 QPS 路径，不能每题打题库） |
| `JUDGE_RESULT_CACHE` | `auto` | | `auto` / `memory` / `redis`。auto = 有 Redis 就用 Redis |
| `JUDGE_RESULT_CACHE_TTL_MS` | 86400000 | | 幂等结果保留时长 |
| `JUDGE_PORT` | 8600 | | 监听端口 |
| `JUDGE_HOST` | 0.0.0.0 | | 监听地址（生产应在网络层限制来源） |
| `JUDGE_WORKSPACE_ROOT` | 系统临时目录 | | 判题工作区根目录 |
| `JUDGE_SECCOMP_PROFILE` | `/etc/judge/seccomp-judge.json` | | seccomp profile 路径 |
| `JUDGE_PER_MINUTE` | 30 | | 每分钟提交上限 |
| `JUDGE_PER_DAY` | 300 | | 每日提交上限 |
| `JUDGE_COOLDOWN_MS` | 60000 | | 超限冷却时长 |
| `JUDGE_MAX_BODY_BYTES` | 512 KB | | 请求体大小上限 |
| `JUDGE_MAX_CONCURRENT` | CPU 核数 | | 并发判题上限。超过 CPU×4 会告警（判题是 CPU 密集，超订让全部请求一起变慢） |
| `JUDGE_REQUEST_TIMEOUT_MS` | 60000 | | 单请求总超时（含判题），也用作请求体读取超时 |
| `JUDGE_AUTH_WINDOW_MS` | 300000 | | 签名时间窗（双向） |
| `JUDGE_NONCE_TTL_MS` | 360000 | | nonce 保留时长，**必须 ≥ 时间窗** |
| `NODE_ENV` | development | | `production` 下缺 token 直接抛错 |

云函数侧：

| 变量 | 说明 |
|---|---|
| `JUDGE_ENDPOINT` | 判题服务内网地址，**绝不要配公网域名** |
| `JUDGE_INTERNAL_TOKEN` | 与判题服务一致（两边必须同时轮换） |
| `JUDGE_FORWARD_TIMEOUT_MS` | 转发超时，默认 15000。**必须小于云函数超时（config.json 里 20s）** |

### 题库来源（外部依赖入口）

判题服务需要「某道题在某语言下的测试点」。这些数据的来源被抽成一个端口，三种实现：

| `JUDGE_PLAN_SOURCE` | 用途 | 备注 |
|---|---|---|
| `memory`（默认） | 开发与自检 | 内置样例题，只能判演示题 |
| `http` | 自建题库后台 | 与判题服务同网段 |
| `cloud` | 云开发 HTTP 访问服务 | 不引 `@cloudbase/node-sdk`，用内置 fetch 走 HTTP |

接口形状：

```
GET {JUDGE_PLAN_BASE_URL}/plans/{questionId}/{language}
Authorization: Bearer {JUDGE_PLAN_TOKEN}
→ 200 JudgePlan（或包一层 { plan } / { data }）
→ 404        题目确实没有判题计划
→ 401/403    凭据错（不可重试）
→ 5xx        可重试
```

**换了题库来源不用改判题主流程**——`src/judges/index.ts` 只认 `PlanProvider` 接口，
自检会断言它不 import 任何具体实现。

**三件必须做对的事**（见 `src/questions/source.ts` 文件头）：

1. **绝不把网络错误说成「题目不存在」**：前者该重试、后者该去反馈。
   混在一起用户会对着「题目不存在」反复重试 —— 白等。
2. **成功才缓存，失败与「确实没有」都不缓存**：缓存失败会把抖动固化成永久故障；
   缓存空结果会撞上「先建题后录测试点」的窗口期。
3. **规范化不是可选项**：题库是人工录入的，脏数据会一路突破到比对，
   表现为「答案全对但判错」。能修的修（补 index、转类型、归一 `\r\n`），
   不能修的拒（期望输出超长**不截断** —— 截断会让输出正确的用户判错）。

---

## 与客户端的契约同步

`src/contract.ts` 与 `miniprogram/services/judge-contract.ts` **必须逐字节一致**。
`src/server.js` 与 `src/server.ts` 也必须逐字节一致。

自检里有两条 SHA-256 比对。改契约或改 server 时：

```bash
npm run sync:contract     # 同时同步契约与 server 副本
node tests/judge-http.test.mjs
```

为什么不共享一份文件：小程序端不能 `import` 主工程外的路径。
但契约分家之后极易出现「服务端加了新 verdict，客户端映射没跟上 → UI 显示 null」，
所以用自动比对替代人工纪律。

### 鉴权协议的三份实现，一致性怎么保证

签名逻辑存在于三处，走的是「同构实现 + 测试向量」而不是「共享模块」：

| 位置 | 语言 | 为什么不能共享 |
|---|---|---|
| `judge-service/src/auth/hmac.ts` | TS | 服务端 |
| `cloudfunctions/judgeSubmit/index.js` | 纯 JS (CJS) | 云函数不走类型剥离，写 TS 语法直接启动失败 |
| `docs/判题服务-接口与验收-v0.2.md` | 文档 | 人读 |

保证方式：自检里用**同一组测试向量**分别调两边的 `canonicalString()`，断言逐字节相同；
再用云函数产出的请求头去调服务端的 `verify()`，跑通完整验签链路。

> 这是刻意的取舍。共享模块需要打包流程，而「打包流程本身出 bug」比
> 「两处实现漂移」更难发现。测试向量的方式慢一点，但每次跑自检都会验证。

---

## 本地运行

```bash
# 1. 只跑逻辑自检（不需要 docker、不需要 Redis）
node tests/judge.test.mjs
node tests/judge-http.test.mjs

# 2. 起服务（需要 docker 与 redis）
export JUDGE_INTERNAL_TOKEN=dev-token-please-change
docker compose up --build

# 3. 探活
curl -s http://127.0.0.1:8600/healthz
curl -s http://127.0.0.1:8600/readyz

# 4. 带签名提交（本地调试脚本）
node -e '
const crypto = require("crypto");
const token = "dev-token-please-change";
const body = JSON.stringify({ payload: {
  submissionId: "local-" + Date.now(), questionId: "q_prog_sum_1_to_n",
  type: "code-editor", language: "c",
  code: "#include <stdio.h>\nint main(){long n,s=0;scanf(\"%ld\",&n);for(long i=1;i<=n;i++)s+=i;printf(\"%ld\\n\",s);return 0;}"
}, userId: "local-dev" });
const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString("hex");
const h = crypto.createHash("sha256").update(body).digest("hex");
const sig = crypto.createHmac("sha256", token)
  .update(["v1","POST","/judge",ts,nonce,h].join("\n")).digest("hex");
fetch("http://127.0.0.1:8600/judge", { method: "POST",
  headers: { "Content-Type": "application/json", "X-Judge-Token": token,
             "X-Judge-Timestamp": ts, "X-Judge-Nonce": nonce, "X-Judge-Signature": sig },
  body }).then(r => r.text()).then(console.log);
'
```

⚠️ `judge-gcc:13-slim` 与 `judge-python:3.12-slim` 是**自建镜像**，不在 Docker Hub 上。
构建脚本已交付：

```bash
npm run sandbox:build     # 构建两个镜像 + 自动校验
npm run sandbox:verify    # 只校验，不构建
```

**为什么不用公共镜像**：这是全系统唯一「主动执行陌生人代码」的地方。镜像自带
curl/wget 等外联工具时，「禁网」配置稍有疏漏就会失效。自建成本约半天。

**构建脚本会自动校验**（构建完不算完）：

- `curl`/`wget`/`nc`/`ssh` 不存在（禁网第二道防线）
- 默认 UID = 1000（与 `policy.ts` 的 `--user 1000:1000` 强绑定）
- 镜像名与 `policy.ts` 的 `LANG_TABLE` 一致（不一致会在**用户提交时**才炸）
- gcc 镜像能 `-static` 链接；python 镜像 `import socket` 失败、无 pip
- python 的 `PYTHONHASHSEED=0`（不关则 set/dict 遍历顺序不稳定 → **判题不可复现**）

---

## 本地模式（不装 docker、不买服务器也能判题）

> **给「还没有服务器、想先在自己电脑上把判题跑通」的情况。**
> 面向非技术读者的完整说明见 `docs/本机跑起来-保姆级说明.md`。

```bash
# 一条命令验证整条判题链路（不需 docker、不需 Redis、不需任何配置）
node judge-service/scripts/local-smoke.mjs
```

真机跑通的样子（C/C++ + Python，覆盖四种典型结论）：

```
通过  正确答案 → 应判 AC        → accepted（通过 3/3 个测试点）
通过  用 int 会溢出 → 应判 WA   → wrong-answer（通过 2/3 个测试点）
通过  语法错误 → 应判 CE        → compile-error
通过  数组越界崩溃 → 应判 RE    → runtime-error
通过  Python 正确答案 → 应判 AC → accepted（通过 2/2 个测试点）
```

第 2 项特意用 `int` 存累加和：小数据能过、大数据溢出，被判 `2/3`
——恰好证明隐藏测试点在起作用（防「硬编码蒙过」）。

### 怎么开

```bash
JUDGE_SANDBOX=local npm start        # bash
$env:JUDGE_SANDBOX="local"; npm start # PowerShell
```

还需要本机有工具链：C/C++ 要 `gcc`，Python 要 `python3`。
冒烟脚本会**自动探测常见安装位置**（winget 包目录 / Program Files / MSYS2 / MinGW）并补进
`PATH` 与 `Path` 两个变量——因为「刚装完终端没刷新 PATH」是高频误判来源。

### 本地模式失效的防护（必须知道边界）

| 防护 | docker | local | 后果 |
|---|---|---|---|
| 内存上限 | ✅ | ❌ | 超内存（MLE）**判不出来** |
| 进程数上限 | ✅ | ❌ | fork 炸弹能真的炸掉机器 |
| 网络隔离 | ✅ | ❌ | 用户代码可以联网 |
| 只读文件系统 | ✅ | ❌ | 用户代码能改本机文件 |

所以服务启动时会打一条**醒目告警**，并且：

- **`JUDGE_SANDBOX` 默认值是 `docker`**（安全选项才是默认值）
- **生产环境（`NODE_ENV=production`）+ local = 直接拒绝启动**（唯一安全闸门）
- 未知取值 → 告警后按 `docker` 处理，不会静默跑在不安全模式

### 什么时候必须切回 docker

只要满足任一条：**有第二个人能提交代码** / **小程序能连到这台机器** / **上线**。

### 工程上的两个关键设计

1. **`Executor` 接口双实现**（`DockerExecutor` / `LocalExecutor`），编排层对它无感知。
   `SandboxPlan` 是同一个纯函数产出的，本地模式做的是**路径翻译**
   （容器路径 `/box`、`/box-artifact` → 宿主路径），而不是第二套语言配置——
   避免「两套配置漂移」。
2. **本地模式自己解析工具链绝对路径**，不依赖系统 PATH 查找。
   原因：Node 在 Windows 上**优先读 `Path` 而非 `PATH`**，两者不一致时追加 `PATH` 会
   **静默失效**；且 env 注入 PATH 时**不补 `.exe`**。这两处都会表现为
   「明明装了 gcc 却报 ENOENT」，用户会去反复重装。生产同样受益（systemd/cron/容器里
   PATH 常常只有 `/usr/bin`）。

---

## 交付状态与下一阶段（非技术读者可直接看本节）

**已交付**：判题链路（编译→运行→比对→8 种结论）、HTTP 入口、HMAC 鉴权、
Redis 限流与 nonce 拦截、云函数中转、沙箱镜像构建脚本、tmpfs noexec 加固、
seccomp 校准工具、题库来源适配层、结果缓存 Redis 化、外部依赖体检脚本，
**964 项自检全绿**。
以上全部可在**本机**运行验证，**不需要服务器、不需要用户做任何配置**。

**剩余阶段**（均为技术实现细节，不需要用户参与决策）：

| # | 事项 | 状态 |
|---|---|---|
| 1 | **seccomp 白名单实跑校准** | 🟡 工具已就绪，待真机跑一次 |
| 2 | 沙箱镜像构建脚本（gcc / python） | ✅ 已交付 |
| 3 | 临时目录 noexec 改造 | ✅ 已交付 |
| 4 | 题库适配层（内存 / HTTP / 云开发三通道） | ✅ 已交付（代码链路） |
| 5 | 结果缓存 Redis 化 | ✅ 已交付（代码链路） |
| 6 | **云服务真正接入**（服务器 / 云开发 / Redis） | ⏳ 用户说的「后话」，填配置即可 |
| 7 | 队列与优先级 | ⏳ 有并发压力后做 |
| 8 | gVisor / Prometheus / 节点健康探针 | ⏳ 优化项，不阻塞上线 |

**第 4、5 项为什么标「代码链路已交付」而不是「已完成」**：
接口、实现、降级、自检全部到位，但**没有连真实云服务**。现在跑在安全默认值上
（题库 = 内置样例题；缓存/限流/nonce = 单实例内存）。

等服务器、云开发、Redis 就绪后**只需填环境变量，不碰代码**：

```bash
npm run adapters:check    # 看每一项当前是什么实现、缺什么、要填哪个变量
```

**第 1 项为什么只到「工具已就绪」**：校准必须在**真机**上跑（需要 docker 起容器 +
root 读内核 audit 日志）。校准脚本、10 道校准题、日志分析器都已就绪且自检通过，
剩下的是执行一次并把结果并回白名单。

**这件事为什么不能靠推测**：白名单补错方向**比不补更糟**——补多了等于放开了安全边界，
补错了会让正常代码被判错。只有实跑日志能给出答案。

**唯一需要用户知道的事**：第 1 项执行完之前，编程题上线后会持续收到
「我代码明明是对的，为什么判我错」的反馈，而我们**无法从日志区分是白名单漏调用还是真错**。

**已定结论（原列为「待决策」，实际是纯技术判断，不该抛给非技术决策者）**：

| 项 | 结论 | 理由 |
|---|---|---|
| 控制面访问 Docker | docker-socket-proxy | 判题服务最可能被攻破，不能给它宿主机的钥匙 |
| token 来源 | 初期环境变量，上线前切密钥管理 | 纯运维动作，不影响代码 |
| 判题节点是否公网暴露 | **绝不**，走内网安全组 | 鉴权是第二道防线，不是第一道 |

---

## 已知未完成（排期，不是遗漏）

| 项 | 说明 | 排期 |
|---|---|---|
| seccomp 白名单校准 | 工具已就绪（`npm run seccomp:plan`），需真机跑一次并合并结果 | **最高优先级** |
| 云服务接入 | 题库 / Redis / 云开发三处填环境变量即可，代码已就绪。用 `npm run adapters:check` 查看缺口 | 用户说的「后话」 |
| 题库来源的真实接口 | `PlanSource` 三通道已实现；HTTP 接口形状已定（见文档 §15.3），但**题库后台本身还没建** | 与云开发同期 |
| 结果缓存 Redis 化 | ✅ 已交付（`redis/result-cache.ts`）；未配 Redis 时自动退回内存 | —— |
| 队列与并发控制 | 当前是「有容量就跑，满了返 busy」；高并发需要真正的排队 + 优先级 | Phase 4 |
| gVisor 升级 | 对外开放编程题或遭遇攻击时 | Phase 5（可选） |
| 判题节点健康探针 | 节点故障时的自动摘除 | Phase 4 |
| 指标导出 | 仅有 `/metrics` 最小项，未接 Prometheus | Phase 4 |
| 镜像锁 digest | 当前锁到主版本/日期，未锁 `@sha256:` | 需要绝对可复现时 |

### 技术债

1. **seccomp profile 需真机实跑校准**（最高优先级）。
   工具在 `scripts/seccomp-calibrate.mjs`，自检已覆盖日志解析逻辑（固定夹具 +
   三种内核日志格式 + 危险/缺失/未知三类分类），但**白名单最终内容必须来自实跑日志**。
   缺调用会表现为 CE/RE，很容易被误判成用户代码错，且日志无法区分。
2. `docker-compose.yml` 直挂 docker.sock **仅限本地**；生产按上表用 docker-socket-proxy。
3. `MemoryRateCounter` / `MemoryNonceStore` / `MemoryResultCache` 都只适用于单实例。
   注意差别：限流用内存版在**多实例下会直接失效**（放行量 = 配置值 × 实例数），
   而结果缓存用内存版只是**重复判题**（浪费算力但不影响正确性）。前者必须优先解决。
   生产必须配 `JUDGE_REDIS_URL`，否则启动日志里会有明确告警。
   三者的降级方向不同（这是刻意设计，见 `redis/result-cache.ts` 的 `DEGRADE_POLICY`）：
   限流 fail-open、结果缓存 fail-open、nonce **fail-degraded**。不要顺手抄成一致。
4. `precheck()` 的错误码粒度不足（「空代码」只能报 `internal`），
   `server.js` 用 `precheckStatus()` 按消息语义纠正成 400。
   给契约加一个 `bad-request` 码之后可以删掉这层适配。
5. `docs/判题服务-接口与验收-v0.2.md` 与 README 有部分重复，需要定期对齐。
6. 校准脚本的纯逻辑与 CLI 在同一文件，靠 `IS_MAIN` 守卫区分——
   这样写是为了让自检能 import（Windows 上 spawn 自身会 EBUSY）。
   若校准逻辑变复杂，应拆成 `lib/` + `cli.mjs`。
