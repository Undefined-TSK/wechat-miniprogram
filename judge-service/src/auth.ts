/**
 * 判题服务 · 鉴权契约
 *
 * ⚠️ 与 contract.ts 不同：本文件**不参与跨端逐字节比对**（客户端拿不到 token，
 *    也不需要签名）。但里面每一处参数都会出现在云函数里，属于「跨仓库契约」，
 *    所以集中在这里定义，并留一枚指纹常量 AUTH_CONTRACT_FINGERPRINT，
 *    自检会同时校验服务端与云函数两侧的签名串拼法一致。
 *
 * 设计取舍：**为什么用「内部 token + HMAC 签名」而不是裸 token 或 Basic Auth**
 *
 *   裸 token：token 每个请求都原样传输。一旦有一条日志、一个代理、
 *            一次网络抓包落到别人手里，攻击者就能无限期伪造提交。
 *   HMAC 签名：请求体被改则签名不匹配；时间戳 + nonce 让抓到的签名
 *             只能在极短时间内用一次，且同一 nonce 只能用一次。
 *
 * 签名串拼法（**顺序与分隔符都是契约的一部分，不要动**）：
 *
 *     JUDGE_AUTH_VERSION \n METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256_HEX(BODY)
 *
 * 为什么把 body 的哈希放进签名而不是把 body 本身：body 可能有 64KB，
 * 每次都参与 HMAC 多算一遍没必要；哈希已经能绑定完整内容。
 *
 * 为什么用 \n 而不是 '|' 之类：请求头里任何可打印字符都可能出现在字段值里，
 * 用固定不可打印分隔符能避免「字段值里带分隔符导致歧义」这类拼接漏洞。
 */

/** 签名算法版本。将来换算法时**必须**升版本，让新旧两端能共存一段时间 */
export const JUDGE_AUTH_VERSION = 'v1';

/** 鉴权请求头。全部小写，因为 Node 的 http 会把 header 名归一化 */
export const AUTH_HEADERS = {
  /** 内部 token：只标识「调用方是业务层」，不参与防重放 */
  token: 'x-judge-token',
  /** 毫秒时间戳字符串 */
  timestamp: 'x-judge-timestamp',
  /** 一次性随机串（每次请求都必须是全新的） */
  nonce: 'x-judge-nonce',
  /** HMAC-SHA256 的 hex 小写 */
  signature: 'x-judge-signature',
  /** 可选：调用方标识，仅用于日志与按来源限流，不参与签名 */
  caller: 'x-judge-caller',
} as const;

/** 允许的时间偏移。太大则重放窗口大，太小则业务层与判题节点时钟略偏就被拒。 */
export const AUTH_WINDOW_MS = 5 * 60 * 1000;

/** nonce 保留时长。必须 ≥ 时间窗，否则「过期前又被重放一次」 */
export const NONCE_TTL_MS = AUTH_WINDOW_MS + 60 * 1000;

/** nonce 长度上限（防有人用超长 nonce 撑爆 Redis key） */
export const NONCE_MAX_LEN = 96;

/** 签名长度：HMAC-SHA256 的 hex 恒为 64 字符 */
export const SIGNATURE_HEX_LEN = 64;

/**
 * 鉴权失败原因码。
 *
 * 为什么要把「失败原因」分得这么细：全归到 401 的话，线上排查要靠猜。
 * 分开之后，看日志就能区分「云函数忘配 env」（缺 token）
 * 和「有人在重放请求」（时间戳过期），处置方式完全不同。
 */
export type AuthFailureCode =
  | 'missing-token'
  | 'bad-token'
  | 'missing-timestamp'
  | 'missing-nonce'
  | 'missing-signature'
  | 'bad-timestamp'
  | 'clock-skew'
  | 'bad-signature'
  | 'replay'
  | 'nonce-too-long';

export const AUTH_FAILURE_TEXT: Record<AuthFailureCode, string> = {
  'missing-token': '缺少内部鉴权 token',
  'bad-token': '内部鉴权 token 不匹配',
  'missing-timestamp': '缺少请求时间戳',
  'missing-nonce': '缺少请求随机串',
  'missing-signature': '缺少请求签名',
  'bad-timestamp': '请求时间戳格式非法',
  'clock-skew': '请求时间戳超出允许偏移',
  'bad-signature': '请求签名校验失败',
  replay: '请求随机串已被使用（疑似重放）',
  'nonce-too-long': '请求随机串过长',
};

/**
 * 之所以要显式声明「拿不到 body 时返回 undefined 而不是抛」：
 * 网关/代理偶尔会注入 content-encoding，导致我们拿不到原始字节。
 * 此时**必须先拒**，不能「读不到就跳过校验」——那等于把鉴权短路了。
 */
export interface AuthMaterial {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  /** **未经任何解析**的原始请求体字符串（或字节的 hex） */
  bodyHash: string;
}

/** 参与签名的规范串。服务端与云函数必须产出完全相同的字符串 */
export function canonicalString(m: AuthMaterial): string {
  return [
    JUDGE_AUTH_VERSION,
    m.method.toUpperCase(),
    m.path,
    m.timestamp,
    m.nonce,
    m.bodyHash,
  ].join('\n');
}

/**
 * 契约指纹：对「拼法」本身取哈希。
 *
 * 作用：sign() 与 canonicalString() 的实现分别存在于服务端与云函数，
 * 两边一旦漂移就是一个极难查的 401。自检会把这个指纹与云函数侧
 * 独立算出的指纹比对——比人肉核对字符串可靠。
 */
export function authContractFingerprint(): string {
  const sample = canonicalString({
    method: 'POST',
    path: '/judge',
    timestamp: '1700000000000',
    nonce: 'n0',
    bodyHash: 'h0',
  });
  return simpleHash(sample);
}

/** 与 contract.utf8Bytes 同口径的简单哈希，仅用于指纹比对，不用于安全用途 */
function simpleHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = (h1 * 16777619) >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, '0').slice(0, 16);
}
