/**
 * 判题服务 · HMAC-SHA256 签名
 *
 * 纯函数，不碰网络、不碰存储。理由是这一段必须能被逐条单测——
 * 鉴权写错的后果不是报错，而是「要么全部 401（功能全挂）」或
 * 「要么全部放行（等于没有鉴权）」，两者都不会自己冒出来。
 *
 * 三条纪律：
 *   1. **常量时间比较**。用 === 比较签名会让攻击者通过响应耗时逐字节猜签名。
 *   2. **时间窗双向校验**。只查「是不是太旧」不够：时间戳在未来同样危险
 *      （等于给攻击者一个更长的重放窗口）。
 *   3. **body 哈希先行**。签名绑的是 body 的 SHA-256，不是 body 本身；
 *      任何一处对 body 做过二次加工（比如先 JSON.parse 再 stringify）都会
 *      改变字节，从而必然验签失败——所以哈希必须在**读完原始字节后立即算**。
 *
 * 本文件用 node:crypto。服务端专用；云函数侧是同一套算法的独立实现
 * （动机：云函数与主工程不共享依赖，且云函数用纯 JS 避免类型剥离差异）。
 * 两侧一致性由 tests/judge-http.test.mjs 用同一组测试向量校验。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AUTH_FAILURE_TEXT,
  AUTH_WINDOW_MS,
  canonicalString,
  JUDGE_AUTH_VERSION,
  NONCE_MAX_LEN,
  SIGNATURE_HEX_LEN,
  type AuthFailureCode,
  type AuthMaterial,
} from '../auth';

export interface SignInput {
  token: string;
  method: string;
  path: string;
  /** 毫秒时间戳。不传则用 now() */
  timestamp?: number;
  /** 毫秒时间戳字符串（直接给出时优先于 timestamp） */
  timestampText?: string;
  /** 随机串。不传则自动生成 */
  nonce?: string;
  /** 原始请求体字符串；与 bodyHash 二选一 */
  body?: string;
  /** 已算好的 body 哈希（服务端校验路径用这个，避免重复序列化） */
  bodyHash?: string;
  now?: () => number;
}

export interface SignedHeaders {
  [header: string]: string;
}

/** 生成签名所需的全部材料 + 请求头。云函数侧照此实现 */
export function sign(input: SignInput): { headers: SignedHeaders; signature: string; material: AuthMaterial } {
  const now = input.now || function () { return Date.now(); };
  const timestampText = input.timestampText || String(input.timestamp || now());
  const nonce = input.nonce || randomNonce();
  const bodyHash = input.bodyHash !== undefined ? input.bodyHash : sha256Hex(input.body === undefined ? '' : input.body);

  const material: AuthMaterial = {
    method: input.method,
    path: input.path,
    timestamp: timestampText,
    nonce: nonce,
    bodyHash: bodyHash,
  };

  const signature = hmacHex(input.token, canonicalString(material));

  return {
    signature: signature,
    material: material,
    headers: {
      // token 头在这里一起给出，理由：调用方最容易忘的就是它，
      // 忘了的表现是「本地签名自测通过、线上全部 401 缺少内部鉴权 token」。
      // 让 sign() 产出完整的一套头，这个坑就没有了。
      'x-judge-token': input.token,
      'x-judge-timestamp': timestampText,
      'x-judge-nonce': nonce,
      'x-judge-signature': signature,
    },
  };
}

export interface VerifyInput {
  /** 服务端配置的 token */
  token: string;
  /** 请求头（名大小写不敏感） */
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  /** 原始请求体字符串（未解析） */
  body?: string;
  /** 已算好的 body 哈希（优先） */
  bodyHash?: string;
  /** 允许的时钟偏移（毫秒），默认 5 分钟 */
  windowMs?: number;
  now?: () => number;
}

export interface VerifyResult {
  ok: boolean;
  code?: AuthFailureCode;
  message?: string;
  /** 校验通过时回带，供上层做 nonce 登记与日志 */
  material?: AuthMaterial;
}

/**
 * 校验签名。
 *
 * 注意本函数**不做 nonce 重放检查**——那需要存储。
 * 调用方必须在 ok=true 之后，用 material.nonce 去 NonceStore 登记；
 * 登记失败（已存在）才判重放。
 *
 * 为什么拆开：把所有检查塞进一个函数会让「无存储的纯校验」无法测试，
 * 也会让校验顺序变得隐晦。现在的顺序是显式且可断言的：
 *   ① 字段齐全性 → ② 时间戳格式 → ③ 时间窗 → ④ token → ⑤ 签名
 * 先查签名再查 token 是错的：那样攻击者可以不带 token 就消耗掉我们的 HMAC 计算。
 */
export function verify(input: VerifyInput): VerifyResult {
  const headers = normalizeHeaders(input.headers);
  const token = headers['x-judge-token'] || '';
  const timestampText = headers['x-judge-timestamp'] || '';
  const nonce = headers['x-judge-nonce'] || '';
  const signature = headers['x-judge-signature'] || '';

  if (!token) return fail('missing-token');
  if (!timestampText) return fail('missing-timestamp');
  if (!nonce) return fail('missing-nonce');
  if (!signature) return fail('missing-signature');

  if (nonce.length > NONCE_MAX_LEN) return fail('nonce-too-long');

  // 时间戳必须是纯数字。Number('') === 0、Number('1e3') === 1000 都是坑，
  // 所以用正则先卡格式，再转数值。
  if (!/^\d{1,15}$/.test(timestampText)) return fail('bad-timestamp');
  const ts = Number(timestampText);
  if (!isFinite(ts) || ts <= 0) return fail('bad-timestamp');

  const now = input.now || function () { return Date.now(); };
  const windowMs = input.windowMs === undefined ? AUTH_WINDOW_MS : input.windowMs;
  const drift = now() - ts;
  if (drift > windowMs || -drift > windowMs) return fail('clock-skew');

  // token 比较也走常量时间：token 泄漏比签名更难发现，且同样可暴力猜
  if (!timingSafeEqualHex(hashForCompare(token), hashForCompare(input.token))) {
    return fail('bad-token');
  }

  const bodyHash = input.bodyHash !== undefined ? input.bodyHash : sha256Hex(input.body === undefined ? '' : input.body);
  const material: AuthMaterial = {
    method: input.method,
    path: input.path,
    timestamp: timestampText,
    nonce: nonce,
    bodyHash: bodyHash,
  };

  const expected = hmacHex(input.token, canonicalString(material));
  if (signature.length !== SIGNATURE_HEX_LEN || !timingSafeEqualHex(signature.toLowerCase(), expected)) {
    return fail('bad-signature');
  }

  return { ok: true, material: material };
}

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/**
 * 常量时间比较两个 hex 字符串。
 *
 * 长度不等时必须直接 false —— 但**不能**用 `a.length !== b.length` 之外的
 * 提前返回暴露更多信息。这里先比长度是安全的：长度本身不是秘密（hex 长度固定）。
 * 真正的秘密是内容，内容只在长度相等时用时长恒定的比较。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 随机 nonce。16 字节 = 128 bit，碰撞概率可忽略 */
export function randomNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * token 先哈希再比较。
 * 目的：把「长度不同」这个信息也抹掉——直接比较原 token 时，
 * 长度不等的两个串走的是提前返回分支，而长度相等才进入常量时间比较。
 */
function hashForCompare(s: string): string {
  return sha256Hex(s);
}

function fail(code: AuthFailureCode): VerifyResult {
  return { ok: false, code: code, message: AUTH_FAILURE_TEXT[code] };
}

/** header 名统一小写；同名多值时取第一个（Node 对我们关心的这几个头不会合并） */
function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = Object.keys(raw || {});
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i].toLowerCase();
    if (out[k] !== undefined) continue;
    const v = raw[keys[i]];
    out[k] = Array.isArray(v) ? (v[0] === undefined ? '' : String(v[0])) : v === undefined ? '' : String(v);
  }
  return out;
}

/** 供日志用：不打印签名与 token 本身 */
export function describeAuth(m: AuthMaterial | undefined): string {
  if (!m) return 'auth[none]';
  return 'auth[' + JUDGE_AUTH_VERSION + ',ts=' + m.timestamp + ',nonce=' + m.nonce.slice(0, 8) + '…]';
}
