/**
 * 判题服务 · HTTP 通信层
 *
 * 📄 本文件同时以 `server.js` 与 `server.ts` 两份存在，**内容必须逐字节一致**：
 *    - `server.js` 是运行时入口（package.json 的 main / Dockerfile 的 CMD 都指向它），
 *      Docker 镜像里只有 .js，这样镜像不需要 Node 的类型剥离支持。
 *    - `server.ts` 只用于让主工程的自检能以 TS 方式 import（复用 tests/ts-resolver.mjs）。
 *    同步命令：`npm run sync:contract`（同时同步契约与这份副本）。
 *    tests/judge-http.test.mjs 里有断言校验两份一致。
 *
 * 纯 Node http，零依赖。**只做 HTTP 语义**：
 *   路由、请求体读取与限长、鉴权、nonce 登记、错误码 → HTTP 状态码映射、
 *   并发闸门、超时、优雅退出。
 *
 * 判题业务逻辑一律不在这里（在 judges/index.ts）。
 * 这样做的收益很直接：HTTP 层可以注入一个假的 JudgeService 单独测，
 * 判题层也能在没有 HTTP 的情况下测。两层各自可测，合起来才不会互相掩盖 bug。
 *
 * ── 六个必须做对的地方 ──────────────────────────────────────────────
 * ① **先看 Content-Length 再收流**。只靠流式累计会被「无限流」拖死：
 *    攻击者发一个 Content-Length: 10 但持续发数据的请求，我们边收边丢，
 *    连接和内存都白占。Content-Length 超限直接 413 并断连。
 * ② **先鉴权再解析 JSON**。签名绑定的是原始字节的哈希，如果先 JSON.parse
 *    再 stringify 去算哈希，哈希必然不同（键序、空白、Unicode 转义都会变），
 *    于是所有请求都验签失败——一个非常难查的 bug。所以哈希必须在
 *    「读完整原始字节」之后、任何解析之前算。
 * ③ **并发闸门返回 busy 而不是排队**。用户拿到 busy 会自己重试；
 *    排队会让请求撞上网关超时，用户看到的是「无响应」，体验更差，
 *    而且我们这边积压的请求还在消耗内存。
 * ④ **请求体读取超时**。慢速发送（slowloris）是必须挡的：不设超时，
 *    几百个半开的连接就能把服务拖住。
 * ⑤ **错误响应体永远不含内部细节**。stack、路径、容器名都不返回给调用方，
 *    只记服务端日志。返回体里只给 code + message。
 * ⑥ **优雅退出**。SIGTERM 后停止接新连接、等在途请求完成、再关 Redis。
 *    k8s / compose 滚动更新时不做这个，正在判的提交会被硬杀，
 *    用户看到的是「判题服务内部错误」。
 */

import http from 'node:http';
import { URL } from 'node:url';
import { AUTH_HEADERS, AUTH_FAILURE_TEXT, type AuthFailureCode } from './auth';
import { sha256Hex, verify, timingSafeEqualHex } from './auth/hmac';
import {
  MAX_CODE_BYTES,
  precheck,
  type JudgeErrorBody,
  type JudgeErrorCode,
  type JudgeRequest,
  type ObjectiveJudgeRequest,
} from './contract';
import type { JudgeBundle } from './bootstrap';
import {
  judgeObjective,
  objectiveStrategyOf,
  precheckObjective,
  sanitizeOutcome,
  type ObjectiveJudgeRequestLike,
} from './judges/objective';

/* ------------------------------------------------------------------ */
/* 错误码 → HTTP 状态码                                                */
/* ------------------------------------------------------------------ */

/**
 * 映射表。
 *
 * 为什么值得单独一张表：错误码分层（业务拒绝 vs 传输失败 vs 服务故障）
 * 与 HTTP 语义不是一一对应的。散在各处的 `res.statusCode = ...` 迟早会
 * 出现「限流返回 500」这种让前端重试策略失灵的错。
 *
 * 关键几个：
 *   - rate-limited → 429 且带 Retry-After。前端据此显示倒计时，
 *     不带这个头的话前端只能瞎猜。
 *   - busy → 503 而不是 429：语义是「我这边没资源」，不是「你请求太多」。
 *     前端对 503 的重试策略应当更保守（退避更久）。
 *   - unauthorized → 401，forbidden → 403。两者的区别是能不能靠「换凭证」解决。
 *   - system-error / internal → 500。
 */
export const ERROR_STATUS: Record<JudgeErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  'rate-limited': 429,
  'payload-too-large': 413,
  'unsupported-language': 400,
  'question-not-found': 404,
  'session-expired': 410,
  busy: 503,
  internal: 500,
};

/**
 * 预检失败时的状态码覆盖表。
 *
 * 为什么需要这张表：`precheck()` 是**跨端**函数，它的 `code` 字段取值受
 * 客户端契约约束（客户端只有这几个错误码），所以「代码为空」只能报 `internal`。
 * 但把客户端输入错误回成 500 会误导两件事：
 *   - 前端：500 会触发「重试」按钮，而空代码重试一万次也是空代码
 *   - 监控：500 会被计入服务端错误率，把「用户传了坏数据」算成我们的故障，
 *          导致错误率告警长期处于噪声状态，真出事时反而被忽略
 * 所以在这里按**消息语义**把明显属于 4xx 的预检失败纠正过来。
 *
 * ⚠️ 这是「契约语义」与「HTTP 语义」之间的一层适配，不是补丁。
 *    将来给契约加一个 `bad-request` 错误码时，这张表可以删掉。
 *
 * ⚠️ 历史坑：这张表最初只覆盖 `/judge`（代码提交）的文案（`代码为空`/`缺少`/…），
 *    后来新增 `/judge/objective` 端点，它的预检文案是「作答为空」—— 不在词表里，
 *    于是空作答被判成 500，重新踩了同一个坑。
 *    现在两条防线：① 词表补全；② 自检遍历**两个端点的所有预检失败路径**，
 *    断言一律不是 5xx（结构上锁死，不靠人去记文案）。
 */
export function precheckStatus(code: JudgeErrorCode | undefined, message: string): number {
  if (code === 'internal' && /代码为空|作答为空|缺少|必须是字符串|必须是数组|不支持/.test(message || '')) {
    return 400;
  }
  return ERROR_STATUS[code || 'internal'] || 500;
}

/**
 * 传输层的错误（还没走到判题业务就失败的）。
 * 这些不是 JudgeErrorCode，因为它们描述的是 HTTP 层的问题。
 */
export type TransportErrorCode =
  | 'unauthorized'
  | 'payload-too-large'
  | 'busy'
  | 'internal'
  | 'method-not-allowed'
  | 'not-found';

export const TRANSPORT_STATUS: Record<TransportErrorCode, number> = {
  unauthorized: 401,
  'payload-too-large': 413,
  busy: 503,
  internal: 500,
  'method-not-allowed': 405,
  'not-found': 404,
};

/* ------------------------------------------------------------------ */
/* 请求上下文                                                          */
/* ------------------------------------------------------------------ */

/** 只允许这两个路径进判题流程。白名单比黑名单可靠 */
export const ROUTES = {
  judge: '/judge',
  /**
   * 客观题判分（选择题 / 填空题 / 程序输出题）。
   *
   * 为什么不复用 /judge：
   *   /judge 是**沙箱**链路 —— 要占容器、要走并发闸门、要限流。
   *   客观题只是「取答案 → 比对」，微秒级、零外部资源。
   *   混在一个端点的后果：Boss 关的选择题会被沙箱的并发闸门挡住返回 503，
   *   而其实它根本不消耗任何容器 —— 属于「用错工具导致的假故障」。
   */
  objective: '/judge/objective',
  healthz: '/healthz',
  readyz: '/readyz',
  metrics: '/metrics',
} as const;

export interface HttpDeps {
  bundle: JudgeBundle;
  /** 日志。默认写 stdout/stderr */
  logger?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** 覆盖当前时间，供自检构造过期签名 */
  now?: () => number;
  /** 注入判题调用（自检用假实现，避免真的起 docker） */
  submit?: (userId: string, req: JudgeRequest) => Promise<unknown>;
}

interface JsonResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export interface JudgeHttpServer {
  server: http.Server;
  listen: () => Promise<void>;
  close: () => Promise<void>;
  /** 当前在途请求数，供自检与指标使用 */
  inflight: () => number;
  address: () => { host: string; port: number } | null;
}

export function createHttpServer(deps: HttpDeps): JudgeHttpServer {
  const config = deps.bundle.config;
  const log = deps.logger || defaultLogger;
  const now = deps.now || function () { return Date.now(); };
  const submitFn = deps.submit || function (userId: string, req: JudgeRequest) {
    return deps.bundle.service.submit(userId, req);
  };

  let inflight = 0;
  let closing = false;
  /** 正在处理中的响应，优雅退出时要等它们结束 */
  const pending = new Set<http.ServerResponse>();
  let startAt = Date.now();

  const server = http.createServer(function (req, res) {
    void handle(req, res);
  });

  // keep-alive 超时：不设的话空闲连接会一直占着 fd
  server.keepAliveTimeout = 30 * 1000;
  server.headersTimeout = 15 * 1000;
  // 请求头超时（Node 18+）：慢速发头也挡掉
  server.requestTimeout = config.requestTimeoutMs;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    pending.add(res);
    let finished = false;
    const done = function () {
      if (finished) return;
      finished = true;
      pending.delete(res);
    };
    res.on('close', done);

    try {
      if (closing) {
        respond(res, { status: 503, body: errBody('busy', '服务正在重启，请稍后重试') });
        return;
      }

      const rawUrl = req.url || '/';
      let pathname: string;
      try {
        pathname = new URL(rawUrl, 'http://internal').pathname;
      } catch (e) {
        respond(res, { status: 400, body: errBody('internal', '请求路径非法') });
        return;
      }

      // 规范化尾斜杠：/judge/ 与 /judge 应该同义。
      // 不做这个的话，客户端多写一个斜杠就变成 404，排查起来很费时间。
      //
      // ⚠️ 规范化必须发生在**算 bodyHash 与验签之前**，而且前后用的是同一个值。
      //    否则签名是对 '/judge' 算的、verify 传的是 '/judge/'，所有请求都会 401。
      //    这里在整条链路上只用 `pathname` 这一个变量，不在别处再取 req.url。
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

      /* ------------------------ 无鉴权探针 ------------------------ */

      // 健康检查故意不做鉴权：k8s 探针不会带 token，
      // 而且这两个端点不暴露任何业务信息（不泄漏题目、不泄漏队列长度）。
      if (pathname === ROUTES.healthz) {
        // liveness：进程还活着就 200。**不检查 Redis/docker**——
        // 依赖挂掉时应该由 readyz 摘流量，而不是让 k8s 重启进程。
        // 混淆这两者的后果是「Redis 抖一下，所有判题节点被重启」。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          respond(res, methodNotAllowed('GET'));
          return;
        }
        respond(res, {
          status: 200,
          body: { status: 'ok', uptimeMs: now() - startAt, inflight: inflight },
        });
        return;
      }

      if (pathname === ROUTES.readyz) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          respond(res, methodNotAllowed('GET'));
          return;
        }
        const ready = computeReady();
        respond(res, { status: ready.ready ? 200 : 503, body: ready });
        return;
      }

      if (pathname === ROUTES.metrics) {
        // 指标端点：生产应只在内网暴露。这里只给最少的几项，
        // 且**不带用户维度**（否则等于泄漏用户 ID）。
        respond(res, {
          status: 200,
          body: {
            inflight: inflight,
            uptimeMs: now() - startAt,
            rateLimiterDegraded: deps.bundle.rateLimiterDegraded,
          },
        });
        return;
      }

      if (pathname !== ROUTES.judge && pathname !== ROUTES.objective) {
        respond(res, { status: 404, body: errBody('internal', '未知端点') });
        return;
      }

      // ⚠️ 尾斜杠与 "//judge" 这类变体不额外处理：路径规范化只做一次（上面），
      //    之后所有判定都用同一个 pathname。多一处 pathname 计算就多一处漂移风险。
      //    `/judge/objective` 内部含斜杠，但规范化只剥**末尾**斜杠，所以不受影响。

      if (req.method !== 'POST') {
        respond(res, methodNotAllowed('POST'));
        return;
      }

      /* ------------------------ ① 请求体限长 ------------------------ */

      const contentLength = req.headers['content-length'];
      if (contentLength !== undefined) {
        const len = Number(contentLength);
        // 非法 Content-Length 直接拒：不能让后续逻辑拿到 NaN 后自己猜
        if (!isFinite(len) || len < 0) {
          respond(res, { status: 400, body: errBody('internal', 'Content-Length 非法') });
          return;
        }
        if (len > config.maxBodyBytes) {
          respond(res, {
            status: 413,
            body: errBody('payload-too-large', '请求体超限（' + config.maxBodyBytes + ' 字节）'),
          });
          // ⚠️ 只 respond 不 destroy：
          //    主动 destroy 会在对端还在发数据时直接 RST，客户端常常表现为
          //    ECONNRESET —— 它看到的是「连接被重置」，而不是我们精心构造的 413，
          //    于是前端的「代码太长」提示永远不会出现。
          //    正确做法是回应 413 并让 Node 在读完后正常收尾。
          //    （readBody 里还有一道累计长度检查，用于 chunked 场景，
          //      那道检查才需要真的停下来不再读。）
          req.resume();
          return;
        }
      }

      /* ------------------------ ② 读原始字节 ------------------------ */

      // 从这里开始是鉴权与 nonce 的关键区：body 必须保持原始字符串，
      // 任何解析都要等到 verify 通过之后。
      let rawBody: string;
      try {
        rawBody = await readBody(req, config.maxBodyBytes, config.requestTimeoutMs);
      } catch (e) {
        // 区分「超限」与「读失败」：超限是我们**主动**拒的（413 且不是服务端故障），
        // 读失败是传输层问题（400 且日志里应当能看到原因）。
        // 一律归 500 的话，运维会把「客户端提前断开」当成服务端 bug 去查。
        if (e instanceof BodyTooLargeError) {
          respond(res, {
            status: 413,
            body: errBody('payload-too-large', e.message),
          });
          req.resume();
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        log('warn', '[http] 读取请求体失败：' + msg);
        respond(res, { status: 400, body: errBody('internal', '请求体读取失败') });
        return;
      }

      /* ------------------------ ③ 签名校验 ------------------------ */

      const bodyHash = sha256Hex(rawBody);
      const auth = verify({
        token: config.token,
        headers: req.headers as Record<string, string | string[] | undefined>,
        method: 'POST',
        path: pathname,
        bodyHash: bodyHash,
        windowMs: config.authWindowMs,
        now: now,
      });

      if (!auth.ok) {
        log('warn', '[http] 鉴权失败：' + String(auth.code) + ' from ' + clientIp(req));
        // ⚠️ 返回体里**不回显**具体是哪个字段错了。
        // 回显会给攻击者一个 oracle（"签名对了但 nonce 错了" 说明签名算法猜对了）。
        // 具体原因只进服务端日志。
        respond(res, {
          status: 401,
          body: errBody('unauthorized', '鉴权失败：' + (AUTH_FAILURE_TEXT[auth.code as AuthFailureCode] || '未知原因')),
        });
        // 消耗掉请求体，避免 keep-alive 连接里残留数据污染下一个请求
        req.resume();
        return;
      }

      /* ------------------------ ④ nonce 重放拦截 ------------------------ */

      // 顺序刻意如此：**先验签再登记 nonce**。
      // 反过来的话，攻击者可以不带有效签名就消耗掉 nonce 空间（一种廉价 DoS），
      // 而且会把合法用户的 nonce 提前占掉（如果攻击者能猜到 nonce 的话）。
      const nonceClaimed = await deps.bundle.nonceStore.claim(auth.material!.nonce, config.nonceTtlMs);
      if (!nonceClaimed) {
        log('warn', '[http] 检测到重放：nonce=' + auth.material!.nonce.slice(0, 8) + '… from ' + clientIp(req));
        respond(res, {
          status: 401,
          body: errBody('unauthorized', AUTH_FAILURE_TEXT.replay),
        });
        return;
      }

      /* ------------------------ ⑤ 解析请求 ------------------------ */

      let payload: { payload?: JudgeRequest } & Partial<JudgeRequest>;
      try {
        payload = JSON.parse(rawBody);
      } catch (e) {
        respond(res, { status: 400, body: errBody('internal', '请求体不是合法 JSON') });
        return;
      }

      // 兼容两种形态：{ payload: {...} } （云函数中转）与裸对象（直连调试）
      const judgeReq = (payload && payload.payload ? payload.payload : payload) as JudgeRequest;
      if (!judgeReq || typeof judgeReq !== 'object') {
        respond(res, { status: 400, body: errBody('internal', '缺少请求体') });
        return;
      }

      /* ------------------ ⑤-b 客观题分支（/judge/objective） ------------------ */

      // 分流判据放在**路径**上而不是请求体形状上：
      //   形状分流（有 code 走沙箱、有 answer 走客观题）看起来很省事，
      //   但一旦请求体两个字段都有（或都缺），行为就是「最后一个 if 说了算」，
      //   排查时非常费解。路径是显式的，客户端与日志里都看得见。
      if (pathname === ROUTES.objective) {
        await handleObjective(res, judgeReq, log, now);
        return;
      }

      const pre = precheck(judgeReq);
      if (!pre.ok) {
        respond(res, {
          status: precheckStatus(pre.code, pre.message || ''),
          body: errBody(pre.code || 'internal', pre.message || '请求不合法'),
        });
        return;
      }

      /* ------------------------ ⑥ 并发闸门 ------------------------ */

      if (inflight >= config.maxConcurrent) {
        // 关键决策：**拒绝而不是排队**。
        // 排队会积压内存并最终撞上网关超时（用户看到「无响应」）；
        // 直接 busy 让前端能立刻给出「稍后重试」，体验明显更好。
        log('warn', '[http] 并发饱和（' + inflight + '/' + config.maxConcurrent + '），拒绝本次提交');
        respond(res, {
          status: 503,
          body: errBody('busy', '判题队列繁忙，请稍后重试'),
          headers: { 'Retry-After': '3' },
        });
        return;
      }

      /* ------------------------ ⑦ 判题 ------------------------ */

      inflight++;
      const startedAt = now();
      try {
        // 带超时的判题调用：判题本身应当被沙箱的墙钟限制住，
        // 但「编排层卡死」（比如 docker daemon 无响应）不会自己退出。
        // 这里兜一层，保证连接一定会被释放。
        const outcome = await withTimeout(
          Promise.resolve(submitFn(userIdOf(judgeReq), judgeReq)),
          config.requestTimeoutMs,
          '判题超时'
        );

        const resObj = outcome as {
          ok?: boolean;
          response?: unknown;
          result?: unknown;
          error?: { code: JudgeErrorCode; message: string; retryAfterMs?: number };
        };

        if (resObj && resObj.ok === false && resObj.error) {
          const code = resObj.error.code || 'internal';
          const status = ERROR_STATUS[code] || 500;
          const headers = code === 'rate-limited' && resObj.error.retryAfterMs
            ? { 'Retry-After': String(Math.ceil(resObj.error.retryAfterMs / 1000)) }
            : undefined;
          respond(res, {
            status: status,
            body: errBody(code, resObj.error.message, resObj.error.retryAfterMs),
            headers: headers,
          });
          return;
        }

        respond(res, {
          status: 200,
          body: {
            ok: true,
            response: resObj.response,
            // result 一并回传：云函数要把 verdict 映射成引擎结果，少一次解析
            result: resObj.result,
          },
        });
        log('info', '[http] 判题完成 ' + judgeReq.submissionId + ' 用时 ' + (now() - startedAt) + 'ms');
      } finally {
        inflight--;
      }
    } catch (err) {
      // 兜底：任何未预期异常都必须是 500 + 不回显内部细节
      log('error', '[http] 未处理异常：' + (err instanceof Error ? err.stack || err.message : String(err)));
      if (!res.headersSent) {
        respond(res, { status: 500, body: errBody('internal', '服务内部错误') });
      } else {
        try {
          res.end();
        } catch (e) {
          // 忽略
        }
      }
    } finally {
      done();
    }
  }

  /**
   * 客观题判分（Boss 关 / 挑战关的选择、填空、程序输出题）。
   *
   * ═══════════════════════════════════════════════════════════════════
   *  为什么这条路**不走并发闸门**
   * ═══════════════════════════════════════════════════════════════════
   *
   * 并发闸门是为了保护**容器资源**（一次判题要起沙箱，成本高）。
   * 客观题只是「从题库取答案 → 字符串比对」，微秒级、零外部资源。
   *
   * 如果也走闸门，会出现：判题队列被编程题占满 → Boss 关的选择题返回 503
   * 「判题队列繁忙」→ 但用户只是选了个单选题。这是「用错工具导致的假故障」。
   *
   * 所以客观题不占 inflight。它自己也不需要闸门：Node 单线程，
   * 这个函数里没有任何 await 会让出（题库读取是缓存/内存的），
   * 天然不会被并发打爆。
   */
  async function handleObjective(
    res: http.ServerResponse,
    req: Partial<ObjectiveJudgeRequestLike>,
    log: (level: 'info' | 'warn' | 'error', msg: string) => void,
    nowFn: () => number
  ): Promise<void> {
    const startedAt = nowFn();

    // ① 结构预检
    const pre = precheckObjective(req);
    if (!pre.ok) {
      // ⚠️ 400 而不是 500：CLIENT 发错了请求（少了字段/作答为空），
      //    这不是服务端故障，不该污染 5xx 故障率告警。
      respond(res, {
        status: precheckStatus(pre.code, pre.message || ''),
        body: errBody(pre.code || 'internal', pre.message || '请求不合法'),
      });
      return;
    }

    const strategy = objectiveStrategyOf(req.type || '');
    if (!strategy) {
      respond(res, {
        status: 400,
        body: errBody('unsupported-language', '该题型不支持客观题判分：' + req.type),
      });
      return;
    }

    // ② 从题库取答案
    //
    //   ⚠️ 三态必须分开（这是整个服务的核心纪律）：
    //      plan 存在          → 正常判分
    //      plan 不存在        → 404 question-not-found（题库明确说没有这道题）
    //      provider 抛异常    → 500 internal（服务端此刻查不到，可重试）
    //
    //   混成一种的后果：题库抖一下，用户看到「题目不存在」，
    //   然后去问运营「这题是不是下架了」—— 白等一场。
    let plan;
    try {
      plan = await deps.bundle.objectivePlans.getAnswer(req.questionId || '');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('error', '[objective] 题库查询失败 ' + req.questionId + '：' + msg);
      respond(res, {
        status: 500,
        body: errBody('internal', '题库暂时不可用，请稍后重试'),
      });
      return;
    }

    if (!plan) {
      respond(res, {
        status: 404,
        body: errBody('question-not-found', '题目不存在或未配置答案'),
      });
      return;
    }

    // ③ 题型交叉校验：客户端报的题型必须与题库一致。
    //    不一致说明客户端版本与题库不同步（或有人手工构造请求）。
    //    这时按题库为准判分会导致「用户看到的题」和「被判的题」不是同一道，
    //    所以直接拒绝更安全。
    if (plan.type && plan.type !== req.type) {
      log('warn', '[objective] 题型不一致 ' + req.questionId + '：客户端 ' + req.type + ' 题库 ' + plan.type);
      respond(res, {
        status: 400,
        body: errBody('internal', '题型与题库不一致，请更新小程序版本'),
      });
      return;
    }

    // ④ 判分
    const outcome = judgeObjective(strategy, req.answer, plan.answer, plan.options);

    // ⑤ 净化：抹掉 detail 里的正确答案（Boss 关答案从不下发）
    const safe = sanitizeOutcome(outcome);

    respond(res, {
      status: 200,
      body: {
        ok: true,
        result: {
          correct: safe.correct,
          partial: safe.partial,
          score: safe.score,
          detail: safe.detail,
          layer: 'remote',
          strategy: strategy,
        },
      },
    });

    log(
      'info',
      '[objective] 判分完成 ' + req.questionId + ' ' + (safe.correct ? 'AC' : safe.partial ? 'PART' : 'WA') +
        ' 用时 ' + (nowFn() - startedAt) + 'ms'
    );
  }

  function computeReady(): { ready: boolean; reasons: string[]; checks: Record<string, boolean> } {
    const reasons: string[] = [];
    const checks: Record<string, boolean> = {};

    if (deps.bundle.redis) {
      // ⚠️ 判据必须是「Redis 连接本身可用」，而不是「限流器是否降级」。
      //    限流器降级是**运行时**状态（可能因为一次命令失败就置位），
      //    一段时间不恢复就会让 readyz 永远 503 —— 那会把一个本来健康的
      //    实例摘掉流量，属于把「能降级」的故障放大成「整体不可用」。
      checks.redis = deps.bundle.redis.available();
      if (!checks.redis) reasons.push('redis-unavailable-degraded');
    } else {
      // 没配 Redis：这是已知的降级形态（单实例内测），不是「不健康」
      checks.redis = false;
      reasons.push('redis-not-configured-memory-fallback');
    }

    // 并发已满 → 不 ready，让负载均衡把新流量给别的实例。
    // 这是 readyz 最容易被忽略但最有价值的一条：能在过载时自动扩容。
    const hasCapacity = inflight < config.maxConcurrent;
    checks.capacity = hasCapacity;
    if (!hasCapacity) reasons.push('saturated');

    // 只有「容量满」才算 not ready。
    // Redis 不可用不算：限流与重放拦截都有降级路径（见各自注释），
    // 判题本身仍然能跑。把依赖故障一律当成 not ready，
    // 会让「Redis 抖 5 秒」变成「所有判题节点被摘」。
    const ready = hasCapacity;
    return { ready: ready, reasons: reasons, checks: checks };
  }

  const api: JudgeHttpServer = {
    server: server,
    inflight: function () { return inflight; },
    address: function () {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return null;
      return { host: addr.address, port: addr.port };
    },
    listen: function () {
      startAt = Date.now();
      return new Promise<void>(function (resolve, reject) {
        server.once('error', reject);
        // 监听到配置的 host。默认 0.0.0.0 是为了容器内可访问，
        // 但生产必须在网络层限制来源（见 README 部署拓扑）。
        server.listen(config.port, config.host, function () {
          log('info', '[http] 监听 ' + config.host + ':' + config.port);
          resolve();
        });
      });
    },
    close: function () {
      return new Promise<void>(function (resolve) {
        closing = true;
        // 先停止接受新连接，再等在途响应结束。
        // 不给 waiting 的请求无限期等待：超过 requestTimeoutMs 就放弃。
        const deadline = setTimeout(function () {
          try {
            server.closeAllConnections();
          } catch (e) {
            // Node <18.2 没有这个 API
          }
          resolve();
        }, config.requestTimeoutMs + 5000);
        if (typeof deadline.unref === 'function') deadline.unref();

        server.close(function () {
          clearTimeout(deadline);
          resolve();
        });

        // 已有的 keep-alive 空闲连接会阻止 close 回调，
        // 所以主动关掉空闲连接（Node 18.2+）
        if (typeof (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections === 'function') {
          (server as unknown as { closeIdleConnections: () => void }).closeIdleConnections();
        }
      });
    },
  };

  return api;
}

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

function respond(res: http.ServerResponse, r: JsonResponse): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(r.body);
  const headers: Record<string, string> = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(text, 'utf8')),
      // 判题响应含用户自己的代码输出，绝不能被中间层缓存
      'Cache-Control': 'no-store',
      // 安全头：JSON 接口不该被当 HTML 解析
      'X-Content-Type-Options': 'nosniff',
    },
    r.headers || {}
  );
  res.writeHead(r.status, headers);
  res.end(text);
}

function errBody(code: JudgeErrorCode, message: string, retryAfterMs?: number): JudgeErrorBody {
  const body: JudgeErrorBody = { error: { code: code, message: message } };
  if (retryAfterMs !== undefined) body.error.retryAfterMs = retryAfterMs;
  return body;
}

function methodNotAllowed(allow: string): JsonResponse {
  return {
    status: 405,
    body: errBody('internal', '方法不允许，应使用 ' + allow),
    headers: { Allow: allow },
  };
}

export class BodyTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * 读请求体。
 *
 * 三层保护：
 *   ① Content-Length 预检（在 handle 里做了）
 *   ② 累计长度检查 —— 对 chunked 编码（没有 Content-Length）必须靠这个
 *   ③ 读取超时 —— 挡 slowloris
 *
 * 为什么 ② 不能省：`Transfer-Encoding: chunked` 的请求没有 Content-Length，
 * 唯一能拦住无限流的就是累计长度。只做 ① 的话，chunked 就是一条绕过路径。
 */
export function readBody(req: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise<string>(function (resolve, reject) {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const timer = setTimeout(function () {
      finish(new Error('读取请求体超时'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(err: Error | null, value?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      if (err) reject(err);
      else resolve(value === undefined ? '' : value);
    }

    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > maxBytes) {
        // 超限立刻停：不要「继续收但丢弃」——那仍然在消耗带宽与内存
        req.pause();
        finish(new BodyTooLargeError('请求体超过 ' + maxBytes + ' 字节上限'));
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      // 用 Buffer.concat 再 toString：直接逐块 toString 会把多字节字符切坏
      // （一个中文字符的 UTF-8 字节被拆到两个 chunk 里就变成乱码，进而哈希不同）
      finish(null, Buffer.concat(chunks).toString('utf8'));
    }

    function onError(err: Error): void {
      finish(err);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * 从请求体里取 userId。
 *
 * ⚠️ 这里**不信任请求体里的 userId**：它只是用来做限流分桶的。
 *    真正的越权校验在业务层（云函数已校验 openid 与题目归属）。
 *    但即便如此，也不能让请求体里的任意字符串撑爆 Redis key 空间，
 *    所以做长度与字符限制。
 */
export function userIdOf(req: JudgeRequest): string {
  const raw = (req as unknown as { userId?: unknown }).userId;
  const s = typeof raw === 'string' ? raw : '';
  return s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anonymous';
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new Error(message + '（' + ms + 'ms）'));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      function (v) {
        clearTimeout(timer);
        resolve(v);
      },
      function (e) {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function clientIp(req: http.IncomingMessage): string {
  // 只在可信代理后面才应该信 X-Forwarded-For；这里仅用于日志，风险可接受。
  // ⚠️ 不要用它做限流或鉴权判断。
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function defaultLogger(level: 'info' | 'warn' | 'error', msg: string): void {
  if (level === 'error') console.error(msg);
  else if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

/* ------------------------------------------------------------------ */
/* 进程入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 启动服务并接管信号。
 *
 * 注意这里用动态 import：让本文件可以在自检里被 import 而**不自动启动服务**
 * （只有真的作为入口执行时才启动）。判据是 import.meta.url 与 argv[1] 是否一致。
 */
export async function main(): Promise<void> {
  const { loadConfig, buildJudge } = await import('./bootstrap');
  const { config, warnings } = loadConfig();

  const bundle = buildJudge({ config: config });
  for (let i = 0; i < warnings.length; i++) console.warn('[judge] 配置提示：' + warnings[i]);
  for (let i = 0; i < bundle.warnings.length; i++) console.warn('[judge] ' + bundle.warnings[i]);

  const httpServer = createHttpServer({ bundle: bundle });
  await httpServer.listen();

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[judge] 收到 ' + signal + '，开始优雅退出');
    try {
      await httpServer.close();
    } catch (e) {
      console.error('[judge] 关闭 HTTP 出错：' + String(e));
    }
    try {
      await bundle.shutdown();
    } catch (e) {
      console.error('[judge] 关闭依赖出错：' + String(e));
    }
    console.log('[judge] 已退出');
    process.exit(0);
  }

  process.on('SIGTERM', function () { void shutdown('SIGTERM'); });
  process.on('SIGINT', function () { void shutdown('SIGINT'); });

  // 未捕获异常与未处理 Promise：记日志后**退出**。
  // 不退出的话进程会处于一个不确定的状态继续接请求，
  // 那种「看起来在跑但行为诡异」的进程比直接崩溃难排查十倍。
  process.on('uncaughtException', function (err) {
    console.error('[judge] uncaughtException：' + (err && err.stack ? err.stack : String(err)));
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', function (reason) {
    console.error('[judge] unhandledRejection：' + String(reason));
  });
}

// 仅在被当作入口执行时启动
const isMain = (function () {
  try {
    const entry = process.argv[1] || '';
    return entry.endsWith('server.js') || entry.endsWith('server.ts');
  } catch (e) {
    return false;
  }
})();

if (isMain) {
  main().catch(function (err) {
    console.error('[judge] 启动失败：' + (err && err.stack ? err.stack : String(err)));
    process.exit(1);
  });
}

// 复导出，方便自检从这里取（避免再 import 一次 bootstrap）
export { timingSafeEqualHex, MAX_CODE_BYTES };
