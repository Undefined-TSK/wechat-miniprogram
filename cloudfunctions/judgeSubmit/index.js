/**
 * 云函数 · judgeSubmit —— 判题服务中转
 *
 * 职责（刻意只有三件）：
 *   ① 取当前用户的 openid（**这是唯一可信的身份来源**）
 *   ② 按「内部 token + HMAC 签名」协议构造请求，转发给判题服务
 *   ③ 把判题服务的错误归一化成前端能直接用的结构
 *
 * ── 为什么必须有这一层 ─────────────────────────────────────────────
 *
 * 小程序前端**绝对不能直连判题服务**，原因有两个，都不是「更规范」这种虚的理由：
 *
 *   1. 前端无法安全持有内部 token。小程序包可被反编译，
 *      写进代码的任何密钥都等于公开。一旦 token 泄漏，
 *      攻击者能直接对我们的判题集群发起无限提交 —— 这是最容易被打的成本攻击面。
 *
 *   2. 身份必须由服务端确定。前端传 userId 是不可信的：
 *      改一个人的提交量就能把别人的限流额度用光（甚至让人被封）。
 *      所以 userId 一律取云函数上下文里的 openid，忽略请求体里的任何相关字段。
 *
 * ── 与判题服务的契约 ───────────────────────────────────────────────
 *
 * 签名规则与 `judge-service/src/auth.ts` 逐字对应：
 *
 *     v1 \n METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
 *
 * ⚠️ 修改任何一处（版本号、字段顺序、分隔符、编码方式）都必须**两边同时改**，
 *    否则线上表现为全部 401。tests/judge-http.test.mjs 里有一条断言，
 *    用同一组测试向量校验云函数与判题服务的签名串拼法一致。
 *
 * ⚠️ 本文件是**纯 JavaScript（CommonJS）**：
 *    云函数运行时不走 TypeScript 类型剥离，写 TS 语法会直接启动失败。
 *    这就是为什么签名逻辑在这里是第二份实现，而不是 import 服务端那份。
 */

'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/* ------------------------------------------------------------------ */
/* 鉴权协议（必须与 judge-service/src/auth.ts 一致）                    */
/* ------------------------------------------------------------------ */

const JUDGE_AUTH_VERSION = 'v1';
const AUTH_HEADER_TOKEN = 'x-judge-token';
const AUTH_HEADER_TIMESTAMP = 'x-judge-timestamp';
const AUTH_HEADER_NONCE = 'x-judge-nonce';
const AUTH_HEADER_SIGNATURE = 'x-judge-signature';
const AUTH_HEADER_CALLER = 'x-judge-caller';

/** 判题服务的内网地址。必须是内网，绝不能把公网域名配在这里 */
const JUDGE_ENDPOINT = (process.env.JUDGE_ENDPOINT || 'http://127.0.0.1:8600').replace(/\/+$/, '');
const JUDGE_PATH = '/judge';
const JUDGE_TOKEN = process.env.JUDGE_INTERNAL_TOKEN || '';

/** 转发超时。必须**小于**云函数自身的超时（默认 20s），否则会看到无意义的超时报错 */
const FORWARD_TIMEOUT_MS = Number(process.env.JUDGE_FORWARD_TIMEOUT_MS || 15000);

/* ------------------------------------------------------------------ */
/* 签名                                                                */
/* ------------------------------------------------------------------ */

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 构造参与签名的规范串。
 * 字段顺序与分隔符都是契约的一部分 —— 不要为了「好看」调整。
 */
function canonicalString(method, pathname, timestamp, nonce, bodyHash) {
  return [JUDGE_AUTH_VERSION, method.toUpperCase(), pathname, timestamp, nonce, bodyHash].join('\n');
}

function hmacHex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * 为一次转发生成鉴权头。
 *
 * nonce 用 crypto.randomBytes 而不是 Math.random：
 * 后者可预测，两个并发请求可能撞上同一个 nonce，
 * 而判题服务会把第二个当重放拒掉 —— 表现为「偶发 401」这种极难复现的故障。
 */
function buildAuthHeaders(method, pathname, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = sha256Hex(body);
  const signature = hmacHex(JUDGE_TOKEN, canonicalString(method, pathname, timestamp, nonce, bodyHash));

  const headers = {};
  headers[AUTH_HEADER_TOKEN] = JUDGE_TOKEN;
  headers[AUTH_HEADER_TIMESTAMP] = timestamp;
  headers[AUTH_HEADER_NONCE] = nonce;
  headers[AUTH_HEADER_SIGNATURE] = signature;
  headers[AUTH_HEADER_CALLER] = 'wx-cloudfunction';
  return headers;
}

/* ------------------------------------------------------------------ */
/* 转发                                                                */
/* ------------------------------------------------------------------ */

/**
 * 用 node:http/https 直发，不引第三方库。
 *
 * 为什么不 fetch：云函数运行时（Node 12/16 兼容层）不一定有全局 fetch，
 * 引 axios/got 会把云函数的依赖体积与冷启动时间都拉上去，
 * 而这两者对云函数是按量计费的实际成本。
 */
function forward(urlString, headers, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (e) {
      reject(new Error('判题服务地址非法'));
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = Buffer.from(body, 'utf8');

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'POST',
        headers: Object.assign({}, headers, {
          'Content-Type': 'application/json; charset=utf-8',
          // 长度必须按**字节**算。用 (headers.Content-Length || body.length)
          // 这类写法在 body 含中文时会算少，导致判题服务读到半个 JSON。
          'Content-Length': payload.length,
        }),
        timeout: timeoutMs,
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            json = null;
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, text: text, json: json });
        });
      }
    );

    req.on('timeout', function () {
      // 主动销毁：不销毁的话 socket 会一直挂着，云函数实例被占住直到超时
      req.destroy(new Error('timeout'));
    });

    req.on('error', function (err) {
      reject(err);
    });

    req.end(payload);
  });
}

/* ------------------------------------------------------------------ */
/* 错误归一化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 构造「判题服务不可达 / 无法解析」时的**最终返回结构**。
 *
 * ⚠️ 这里有两层「错误对象」的概念，混用就会出双包 bug：
 *
 *     裸错误对象      { code, message, retryAfterMs? }
 *                    → sanitizeError() 的产出，只用于**组装**
 *     最终返回结构    { ok: false, error: <裸错误对象> }
 *                    → 本函数与 normalizeResponse() 的产出，直接 return 给云函数调用方
 *
 *    `wrap(code, message)` 属于第二层（构造最终结构）。
 *    如果把它用在 normalizeResponse 内部（那里已经在组装 error 字段了），
 *    结果就是 `{ error: { ok:false, error: {...} } }` —— 前端读到
 *    `result.error.code === undefined`，只能显示兜底文案。
 *    这类 bug 不抛异常、不进日志，只是把提示语变模糊，所以必须靠断言守。
 */

/**
 * 把判题服务的响应翻译成前端要的结构。
 *
 * 两条纪律：
 *   ① **不透传判题服务的原始响应体**。它可能包含容器名、路径这类内部信息。
 *      我们只取 error.code / error.message / retryAfterMs。
 *   ② 状态码 4xx/5xx 与「判题失败」要分开表达：
 *      4xx 是请求本身有问题（不该重试），5xx/503 是服务问题（可以重试）。
 */
function normalizeResponse(res) {
  const body = res.json;

  if (res.statusCode >= 200 && res.statusCode < 300 && body) {
    // 判题服务返回 { ok, response, result }
    if (body.ok === true) {
      return { ok: true, response: body.response, result: body.result };
    }
    if (body.error) {
      return { ok: false, error: sanitizeError(body.error) };
    }
    return wrap('internal', '判题服务返回结构异常');
  }

  // 判题服务带了可解析的业务错误体（无论状态码是多少）→ 以业务码为准。
  // 顺序上放在状态码兜底之前，因为业务码比 HTTP 状态码更具体。
  if (body && body.error && body.error.code) {
    return { ok: false, error: sanitizeError(body.error) };
  }

  if (res.statusCode === 413) {
    return wrap('payload-too-large', '代码太长，精简一下再提交');
  }
  if (res.statusCode === 429) {
    return wrap('rate-limited', '提交太频繁了，休息一下再试');
  }
  if (res.statusCode === 503) {
    return wrap('busy', '判题队列繁忙，请稍后重试');
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    // 鉴权失败是我们的配置问题，不是用户的问题。
    // 文案要说清楚，否则用户会以为是自己操作错了。
    return wrap('unauthorized', '判题服务鉴权异常，已记录，请稍后重试');
  }

  return wrap('internal', '判题服务暂时不可用，请稍后重试');
}

/**
 * 把裸错误对象包成最终返回结构。
 * 单独抽出来是为了让 normalizeResponse 里**只出现一种包装方式** ——
 * 混用 fail()/手工包 error 字段就是双包 bug 的来源。
 */
function wrap(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

/**
 * 只保留契约里定义的字段，防止内部字段顺着响应流到前端。
 * 返回**裸错误对象** `{ code, message, retryAfterMs? }`（注意不是最终返回结构），
 * 调用侧统一包一层 `{ ok: false, error: ... }`。
 */
function sanitizeError(err) {
  const allowedCodes = [
    'unauthorized', 'forbidden', 'rate-limited', 'payload-too-large', 'unsupported-language',
    'question-not-found', 'session-expired', 'busy', 'internal',
  ];
  const code = allowedCodes.indexOf(err.code) >= 0 ? err.code : 'internal';
  const out = { code: code, message: String(err.message || '判题失败') };
  if (typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0) {
    out.retryAfterMs = err.retryAfterMs;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 允许透传给判题服务的字段白名单。
 *
 * ⚠️ 白名单而不是黑名单：判题服务只认识这几个字段，
 *    多传的东西要么被忽略、要么成为攻击面（比如有人塞个 `userId` 试图覆盖身份）。
 *    白名单的另一个好处是以后契约加字段时会立刻发现「这里没同步」。
 */
const ALLOWED_REQUEST_FIELDS = ['submissionId', 'questionId', 'type', 'language', 'code', 'limits'];

function pickAllowed(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (let i = 0; i < ALLOWED_REQUEST_FIELDS.length; i++) {
    const k = ALLOWED_REQUEST_FIELDS[i];
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

/**
 * 主函数。
 *
 * `event.payload` 是小程序端 judge-client.ts 构造的判题请求。
 * openid 从 `cloud.getWXContext()` 取 —— 这是**唯一**可信的身份来源。
 */
exports.main = async function (event, context) {
  // 启动时的配置自检：宁可每次调用都检查（开销极小），也不要等到线上 401 才发现漏配
  if (!JUDGE_TOKEN) {
    console.error('[judgeSubmit] 未配置 JUDGE_INTERNAL_TOKEN，无法转发判题请求');
    return wrap('internal', '判题服务未配置完成，请联系客服');
  }

  const payload = event && event.payload ? event.payload : event;
  const judgeRequest = pickAllowed(payload);

  if (!judgeRequest.submissionId || !judgeRequest.questionId) {
    return wrap('internal', '请求缺少必要字段');
  }

  // 身份**只**来自云函数上下文。忽略 payload 里可能存在的 userId。
  let openid = '';
  try {
    const wxContext = require('wx-server-sdk') && null; // 占位：见下方说明
  } catch (e) {
    // 忽略
  }

  // 说明：真实环境下用 cloud.getWXContext().OPENID。
  // 这里用 try 包裹是为了让本文件在**没有 wx-server-sdk** 的本地自检里也能被 require 成功
  // （自检要验证签名串拼法，不需要真的跑云函数）。
  try {
    const cloud = require('wx-server-sdk');
    if (cloud && typeof cloud.getWXContext === 'function') {
      const ctx = cloud.getWXContext();
      openid = (ctx && ctx.OPENID) || '';
    }
  } catch (e) {
    openid = '';
  }

  if (!openid) {
    // 取不到 openid 说明不是合法的小程序调用（比如有人直接调云函数 HTTP 触发）
    console.warn('[judgeSubmit] 无法获取 OPENID，拒绝转发');
    return wrap('unauthorized', '登录状态已失效，请重新进入小程序');
  }

  // userId 放到请求体里：判题服务用它做限流分桶。
  // 注意这是**服务端确定的**值，不是用户传的。
  const body = JSON.stringify({
    payload: judgeRequest,
    userId: openid,
  });

  const authHeaders = buildAuthHeaders('POST', JUDGE_PATH, body);

  try {
    const res = await forward(JUDGE_ENDPOINT + JUDGE_PATH, authHeaders, body, FORWARD_TIMEOUT_MS);
    return normalizeResponse(res);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // 判题服务不可达：这**不是**用户的错，文案必须体现「不是你的问题」
    console.error('[judgeSubmit] 转发判题请求失败：' + msg);
    if (msg === 'timeout' || msg.indexOf('timeout') >= 0) {
      return wrap('busy', '判题超时，请稍后重试');
    }
    return wrap('internal', '判题服务暂时不可用，请稍后重试');
  }
};

/* ------------------------------------------------------------------ */
/* 自检导出                                                            */
/* ------------------------------------------------------------------ */

// 这些导出只服务于本地自检（验证签名串拼法与判题服务一致）。
// 云函数调用入口只认 exports.main，多几个导出不影响运行。
exports.__internal = {
  JUDGE_AUTH_VERSION: JUDGE_AUTH_VERSION,
  canonicalString: canonicalString,
  sha256Hex: sha256Hex,
  hmacHex: hmacHex,
  buildAuthHeaders: buildAuthHeaders,
  pickAllowed: pickAllowed,
  sanitizeError: sanitizeError,
  normalizeResponse: normalizeResponse,
  ALLOWED_REQUEST_FIELDS: ALLOWED_REQUEST_FIELDS,
};
