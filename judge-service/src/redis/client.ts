/**
 * 判题服务 · 最小 Redis 客户端（零依赖，RESP2 协议）
 *
 * 为什么不用 ioredis / node-redis：
 *   我们对 Redis 的需求只有四件事——SET NX PX、EVAL、GET、PING。
 *   为这四个命令引一个上万行的依赖，等于给「处理不可信输入的服务」
 *   额外增加一大块攻击面与供应链风险。判题服务是要暴露在网络上收
 *   任意代码的服务，依赖越少越好。
 *
 * 但这份实现的定位要说清楚：**它是给我们自己的内网 Redis 用的**，
 * 不是通用客户端。它不处理集群、不处理 pub/sub、不处理事务、
 * 不支持 RESP3。够用就好，多的都是负债。
 *
 * 关键行为：
 *   - 自动重连（指数退避 + 抖动），重连期间 available() === false
 *   - 命令超时（默认 3s）—— Redis 卡住时不能让 HTTP 请求一起卡住
 *   - 失败时 reject，由上层决定 fail-open 还是 fail-closed
 *   - 命令必须走**数组参数**，绝不用内联字符串拼接命令（防 RESP 注入）
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';

/** 上层只依赖这个接口，测试可注入假实现 */
export interface RedisCommandPort {
  command(args: string[]): Promise<unknown>;
  available(): boolean;
}

export interface RedisOptions {
  /** redis://user:pass@host:port/db */
  url: string;
  /** 单条命令超时（毫秒） */
  commandTimeoutMs?: number;
  /** 连接超时（毫秒） */
  connectTimeoutMs?: number;
  /** 日志钩子，便于测试与排障（不打印任何命令内容，避免泄漏用户 ID） */
  onLog?: (msg: string) => void;
}

interface PendingCommand {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RedisClient extends EventEmitter implements RedisCommandPort {
  private opts: Required<Pick<RedisOptions, 'commandTimeoutMs' | 'connectTimeoutMs'>> & RedisOptions;
  private socket: net.Socket | null = null;
  private buffer = '';
  private queue: PendingCommand[] = [];
  private connected = false;
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private log: (msg: string) => void;

  constructor(opts: RedisOptions) {
    super();
    this.opts = Object.assign({ commandTimeoutMs: 3000, connectTimeoutMs: 3000 }, opts);
    this.log = opts.onLog || function () { /* 默认静默 */ };
    this.connect();
  }

  available(): boolean {
    return this.connected && !this.closing;
  }

  /**
   * 发一条命令。
   *
   * ⚠️ 绝不提供「直接发原始字符串」的接口。所有调用方都必须传参数数组，
   *    由这里统一做 RESP 编码 —— 这样「参数里含 CRLF 导致命令注入」
   *    在架构上就不可能发生。
   */
  async command(args: string[]): Promise<unknown> {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('[redis] command 需要非空参数数组');
    }
    if (this.closing) throw new Error('[redis] 客户端已关闭');
    if (!this.socket || !this.connected) {
      throw new Error('[redis] 未连接');
    }

    const self = this;
    return new Promise<unknown>(function (resolve, reject) {
      const timer = setTimeout(function () {
        const idx = self.queue.findIndex(function (p) { return p.resolve === resolve; });
        if (idx >= 0) self.queue.splice(idx, 1);
        reject(new Error('[redis] 命令超时（' + self.opts.commandTimeoutMs + 'ms）'));
      }, self.opts.commandTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      self.queue.push({ resolve: resolve, reject: reject, timer: timer });
      try {
        self.socket!.write(encodeCommand(args));
      } catch (e) {
        clearTimeout(timer);
        const idx = self.queue.findIndex(function (p) { return p.resolve === resolve; });
        if (idx >= 0) self.queue.splice(idx, 1);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 优雅关闭：等命令队列清空后断连 */
  async quit(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket && this.connected) {
      try {
        await this.command(['QUIT']).catch(function () { /* 尽力而为 */ });
      } catch (e) {
        // 忽略
      }
    }
    this.destroySocket();
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.destroySocket();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private connect(): void {
    if (this.closing) return;

    let parsed: URL;
    try {
      parsed = new URL(this.opts.url);
    } catch (e) {
      this.log('[redis] URL 解析失败，客户端不可用');
      return;
    }

    const port = parsed.port ? Number(parsed.port) : 6379;
    const host = parsed.hostname || '127.0.0.1';
    const self = this;

    const socket = net.createConnection({ host: host, port: port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.opts.connectTimeoutMs);

    socket.on('connect', function () {
      socket.setTimeout(0);
      self.connected = true;
      self.reconnectAttempt = 0;
      self.log('[redis] 已连接 ' + host + ':' + port);

      const auth = self.authCommand(parsed);
      if (auth) {
        self.command(auth)
          .then(function () { self.emit('ready'); })
          .catch(function (e) {
            self.log('[redis] 鉴权失败：' + String(e && e.message));
            socket.destroy();
          });
      } else {
        self.emit('ready');
      }
    });

    socket.on('data', function (chunk: Buffer) {
      self.buffer += chunk.toString('utf8');
      self.drain();
    });

    socket.on('timeout', function () {
      // 连接阶段超时
      self.log('[redis] 连接超时');
      socket.destroy();
    });

    socket.on('error', function (err: Error) {
      self.log('[redis] 连接错误：' + err.message);
    });

    socket.on('close', function () {
      const wasConnected = self.connected;
      self.connected = false;
      self.socket = null;
      if (wasConnected) self.log('[redis] 连接已断开');
      self.failPending(new Error('[redis] 连接已断开'));
      self.scheduleReconnect();
    });
  }

  private authCommand(parsed: URL): string[] | null {
    const user = decodeURIComponent(parsed.username || '');
    const pass = decodeURIComponent(parsed.password || '');
    if (!pass) return null;
    // Redis 6+ 的 ACL：有用户名就用 AUTH user pass，否则 AUTH pass
    return user ? ['AUTH', user, pass] : ['AUTH', pass];
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    this.reconnectAttempt++;
    // 指数退避 + 抖动：避免多实例同时重连把 Redis 打死
    const base = Math.min(30000, 200 * Math.pow(2, Math.min(this.reconnectAttempt, 7)));
    const jitter = Math.floor(Math.random() * 200);
    const self = this;
    this.reconnectTimer = setTimeout(function () {
      self.reconnectTimer = undefined;
      self.connect();
    }, base + jitter);
    if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') {
      this.reconnectTimer.unref();
    }
  }

  private destroySocket(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (e) {
        // 忽略
      }
      this.socket = null;
    }
    this.connected = false;
    this.failPending(new Error('[redis] 客户端已关闭'));
  }

  private failPending(err: Error): void {
    const q = this.queue;
    this.queue = [];
    for (let i = 0; i < q.length; i++) {
      clearTimeout(q[i].timer);
      q[i].reject(err);
    }
  }

  /** 解析缓冲区里能解析出的完整回复 */
  private drain(): void {
    for (;;) {
      const parsed = parseReply(this.buffer, 0);
      if (!parsed) return;
      this.buffer = this.buffer.slice(parsed.next);
      const cmd = this.queue.shift();
      if (!cmd) continue;
      clearTimeout(cmd.timer);
      if (parsed.error) cmd.reject(new Error(parsed.error));
      else cmd.resolve(parsed.value);
    }
  }
}

/* ------------------------------------------------------------------ */
/* RESP 编码 / 解码                                                    */
/* ------------------------------------------------------------------ */

/**
 * RESP2 编码：恒用多 bulk string 数组形式（`*N\r\n$len\r\n...`）。
 * 不用内联命令形式，因为内联形式要靠空格切分，参数里带空格就错了，
 * 而且给了注入面。
 */
export function encodeCommand(args: string[]): Buffer {
  const parts: string[] = ['*' + args.length + '\r\n'];
  for (let i = 0; i < args.length; i++) {
    const s = String(args[i]);
    const bytes = Buffer.byteLength(s, 'utf8');
    // 长度用**字节数**而不是字符数：中文参数用字符数会截断
    parts.push('$' + bytes + '\r\n' + s + '\r\n');
  }
  return Buffer.from(parts.join(''), 'utf8');
}

interface ParsedReply {
  value: unknown;
  next: number;
  error?: string;
}

/**
 * 解析一条回复。
 * 返回 null 表示「缓冲区里还没有完整的一条」——调用方应当等待更多数据。
 *
 * 支持 RESP2 的全部 5 种类型：
 *   +简单字符串  -错误  :整数  $bulk  *数组
 * 数组元素可以是 null（RESP 的 `$-1` / `*-1`），Redis 的 SET NX 失败就靠这个表达。
 */
export function parseReply(buf: string, offset: number): ParsedReply | null {
  if (offset >= buf.length) return null;
  const type = buf[offset];
  const lineEnd = buf.indexOf('\r\n', offset + 1);
  if (lineEnd < 0) return null;
  const line = buf.slice(offset + 1, lineEnd);

  switch (type) {
    case '+':
      return { value: line, next: lineEnd + 2 };

    case '-':
      return { value: null, next: lineEnd + 2, error: line };

    case ':': {
      const n = Number(line);
      if (!isFinite(n)) return { value: null, next: lineEnd + 2, error: '非法整数回复' };
      return { value: n, next: lineEnd + 2 };
    }

    case '$': {
      const len = Number(line);
      if (len === -1) return { value: null, next: lineEnd + 2 };
      if (!isFinite(len) || len < 0) return { value: null, next: lineEnd + 2, error: '非法 bulk 长度' };
      const dataStart = lineEnd + 2;
      // ⚠️ len 是字节数。这里按字节截取，避免中文/emoji 被切坏。
      const dataEnd = byteOffsetOf(buf, dataStart, len);
      if (dataEnd < 0) return null; // 数据还没到齐
      const value = buf.slice(dataStart, dataEnd);
      return { value: value, next: dataEnd + 2 };
    }

    case '*': {
      const count = Number(line);
      if (count === -1) return { value: null, next: lineEnd + 2 };
      if (!isFinite(count) || count < 0) return { value: null, next: lineEnd + 2, error: '非法数组长度' };
      const arr: unknown[] = [];
      let cursor = lineEnd + 2;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, cursor);
        if (!item) return null;
        if (item.error) return { value: null, next: item.next, error: item.error };
        arr.push(item.value);
        cursor = item.next;
      }
      return { value: arr, next: cursor };
    }

    default:
      // 不认识的类型：把这一行吃掉，避免死循环。
      // 不能直接认为「没有数据」——那会让 drain 卡住，队列里的命令全部超时。
      return { value: null, next: lineEnd + 2, error: '未知回复类型：' + String(type) };
  }
}

/**
 * 从 start（字符索引）开始，前进 n 个**字节**后的字符索引。
 * 返回 -1 表示缓冲区还不够长。
 */
function byteOffsetOf(buf: string, start: number, n: number): number {
  let bytes = 0;
  let i = start;
  while (i < buf.length && bytes < n) {
    const code = buf.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < buf.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
    i++;
  }
  if (bytes < n) return -1;
  return i;
}
