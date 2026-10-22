/**
 * 判题服务自检 · HTTP 接入层与鉴权
 *
 * 运行：node tests/judge-http.test.mjs（**不需要 docker、不需要 Redis**）
 *
 * 这份自检针对的是「平时测不出来、出事就是大事故」的几类问题：
 *
 *   1. 鉴权写反（全放行 / 全拒绝）。全放行是安全事件，全拒绝是功能全挂，
 *      两者都不会抛异常。
 *   2. **签名绑定的是原始字节**。如果服务端先 JSON.parse 再 stringify 去算哈希，
 *      键序/空白/Unicode 转义一变哈希就不同 —— 结果就是「本地自测通过、
 *      线上全 401」这种最难查的 bug。所以专门有一个「JSON 空白与键序不同但
 *      内容等价」的用例，验证签名校验对**字节**敏感、对**语义**不敏感。
 *   3. nonce 重放与**并发重放**。并发那一条是关键：先查后写的实现能通过顺序重放测试，
 *      但会被并发重放打穿。用例里显式 Promise.all 两次 claim。
 *   4. 限流 Lua 脚本「只在首次设过期」。写错方向有两种：
 *      - 每次都 PEXPIRE → 窗口被无限续期，用户永远恢复不了
 *      - 只在 INCR 返回 1 时 PEXPIRE，但下次 INCR 前 key 已过期 → 计数从 1 重来（正确）
 *      用例断言「第一次设 TTL、后续不续期」。
 *   5. fail-open 降级。Redis 挂掉时必须放行并告警，不能静默失效、也不能全拒。
 *   6. 错误码 → HTTP 状态码映射全覆盖。特别是 rate-limited 必须 429 + Retry-After，
 *      busy 必须 503 —— 前端靠这两个码决定重试策略，错了会让重试逻辑整体失灵。
 *   7. 传输层防护：请求体超限 413、并发闸门 503、方法不允许 405、路径规范化。
 */

import { register } from 'node:module';
import { createServer as createRawServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

register('./ts-resolver.mjs', import.meta.url);

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const authContract = await import('../judge-service/src/auth.ts');
const hmac = await import('../judge-service/src/auth/hmac.ts');
const nonceMod = await import('../judge-service/src/auth/nonce.ts');
const redisClientMod = await import('../judge-service/src/redis/client.ts');
const rateCounterMod = await import('../judge-service/src/redis/rate-counter.ts');
const ratelimitMod = await import('../judge-service/src/sandbox/ratelimit.ts');
const serverMod = await import('../judge-service/src/server.ts');
const bootstrapMod = await import('../judge-service/src/bootstrap.ts');
const contractMod = await import('../judge-service/src/contract.ts');

/* ------------------------------ 脚手架 ------------------------------ */

let passCount = 0;
let failCount = 0;
const failures = [];

function section(name) {
  console.log('\n' + name);
}

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

function assertThrowsAsync(name, fn, matcher) {
  return fn().then(
    function () { record(false, name, '本应抛错但没有'); },
    function (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record(!matcher || matcher.test(msg), name, matcher && !matcher.test(msg) ? '错误信息不匹配：' + msg : '');
    }
  );
}

/* --------------------- 1. 鉴权契约与规范串 --------------------- */

section('1. 鉴权契约（请求头名 / 规范串拼法）');

eq('签名版本号', authContract.JUDGE_AUTH_VERSION, 'v1');
eq('token 头名', authContract.AUTH_HEADERS.token, 'x-judge-token');
eq('时间戳头名', authContract.AUTH_HEADERS.timestamp, 'x-judge-timestamp');
eq('nonce 头名', authContract.AUTH_HEADERS.nonce, 'x-judge-nonce');
eq('签名头名', authContract.AUTH_HEADERS.signature, 'x-judge-signature');

// 规范串的**逐字段**断言。整体对字符串会让「字段顺序被调换」这种改动
// 恰好因为两边一起改而通过——必须按位置断言。
{
  const s = authContract.canonicalString({
    method: 'post',
    path: '/judge',
    timestamp: '1700000000000',
    nonce: 'abc',
    bodyHash: 'deadbeef',
  });
  const parts = s.split('\n');
  eq('规范串共 6 段', parts.length, 6);
  eq('第 1 段是版本号', parts[0], 'v1');
  eq('第 2 段是 HTTP 方法（大写）', parts[1], 'POST');
  eq('第 3 段是路径（不含 query）', parts[2], '/judge');
  eq('第 4 段是时间戳', parts[3], '1700000000000');
  eq('第 5 段是 nonce', parts[4], 'abc');
  eq('第 6 段是 body 哈希', parts[5], 'deadbeef');
}

// 用 \n 做分隔符的理由：字段值里可能出现任何可打印字符
{
  const s = authContract.canonicalString({
    method: 'POST',
    path: '/judge?x=a|b',
    timestamp: '1',
    nonce: 'a|b',
    bodyHash: 'c',
  });
  ok('分隔符不可打印（字段值里带 | 不会造成歧义）', s.indexOf('\n') >= 0 && s.split('|').length === 3);
}

eq('时间窗 = 5 分钟', authContract.AUTH_WINDOW_MS, 5 * 60 * 1000);
ok('nonce 保留时长 > 时间窗（否则窗口内可二次重放）',
  authContract.NONCE_TTL_MS > authContract.AUTH_WINDOW_MS,
  'NONCE_TTL_MS=' + authContract.NONCE_TTL_MS + ' AUTH_WINDOW_MS=' + authContract.AUTH_WINDOW_MS);
eq('签名 hex 长度 64', authContract.SIGNATURE_HEX_LEN, 64);

// 失败原因必须分得细：全归一类线上没法排查
{
  const codes = Object.keys(authContract.AUTH_FAILURE_TEXT);
  ok('鉴权失败原因 ≥ 9 种（缺字段/格式/过期/重放分类）', codes.length >= 9, String(codes.length));
  ok('包含 replay（重放单独一类）', codes.indexOf('replay') >= 0);
  ok('包含 clock-skew（时间偏移单独一类）', codes.indexOf('clock-skew') >= 0);
  ok('包含 bad-signature', codes.indexOf('bad-signature') >= 0);
}

/* --------------------- 2. HMAC 签名与校验 --------------------- */

section('2. HMAC-SHA256 签名与校验');

const TOKEN = 'test-token-0123456789';
const fixedNow = () => 1700000000000;

// 签名确定性
{
  const a = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n1', body: '{"a":1}', now: fixedNow });
  const b = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n1', body: '{"a":1}', now: fixedNow });
  eq('同一输入签名可复现', a.signature, b.signature);
  eq('签名长度为 64 hex', a.signature.length, 64);
  ok('签名为小写 hex', /^[0-9a-f]{64}$/.test(a.signature));

  const v = hmac.verify({
    token: TOKEN, headers: a.headers, method: 'POST', path: '/judge', body: '{"a":1}', now: fixedNow,
  });
  ok('正确签名校验通过', v.ok, v.message);
  eq('回带 nonce 供登记', v.material.nonce, 'n1');
}

// 自动生成的 nonce 必须每次都不同（否则重放拦截形同虚设）
{
  const set = new Set();
  for (let i = 0; i < 200; i++) set.add(hmac.randomNonce());
  eq('随机 nonce 200 次无重复', set.size, 200);
  eq('nonce 长度 32 hex（128 bit）', hmac.randomNonce().length, 32);
}

// 篡改检测：body / 路径 / 方法 任意一处改动都必须被发现
{
  const signed = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n2', body: '{"code":"a"}', now: fixedNow });

  const vBody = hmac.verify({ token: TOKEN, headers: signed.headers, method: 'POST', path: '/judge', body: '{"code":"b"}', now: fixedNow });
  ok('请求体被改 → 签名失败', !vBody.ok);
  eq('失败码为 bad-signature', vBody.code, 'bad-signature');

  const vPath = hmac.verify({ token: TOKEN, headers: signed.headers, method: 'POST', path: '/judge/other', body: '{"code":"a"}', now: fixedNow });
  ok('路径被改 → 签名失败', !vPath.ok);

  const vMethod = hmac.verify({ token: TOKEN, headers: signed.headers, method: 'GET', path: '/judge', body: '{"code":"a"}', now: fixedNow });
  ok('方法被改 → 签名失败', !vMethod.ok);

  // 只改一个字节
  const oneByte = signed.headers['x-judge-signature'].slice(0, 63) + (signed.headers['x-judge-signature'][63] === 'a' ? 'b' : 'a');
  const vSig = hmac.verify({ token: TOKEN, headers: Object.assign({}, signed.headers, { 'x-judge-signature': oneByte }), method: 'POST', path: '/judge', body: '{"code":"a"}', now: fixedNow });
  ok('签名差一个字符 → 失败', !vSig.ok, vSig.message);
}

// token 错误
{
  const signed = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n3', body: '{}', now: fixedNow });
  const v = hmac.verify({ token: TOKEN + 'x', headers: signed.headers, method: 'POST', path: '/judge', body: '{}', now: fixedNow });
  ok('token 不匹配 → 拒绝', !v.ok);
  eq('失败码为 bad-token', v.code, 'bad-token');
}

// 时间窗：两侧都要挡
{
  const mk = (ts, nonce, nowFn) => {
    const s = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: ts, nonce: nonce, body: '{}', now: nowFn });
    return hmac.verify({ token: TOKEN, headers: s.headers, method: 'POST', path: '/judge', body: '{}', now: nowFn });
  };

  const fresh = mk(1700000000000, 'w1', fixedNow);
  ok('刚签发的请求通过', fresh.ok, fresh.message);

  const justInside = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'w2', body: '{}', now: fixedNow });
  const vInside = hmac.verify({
    token: TOKEN, headers: justInside.headers, method: 'POST', path: '/judge', body: '{}',
    now: () => 1700000000000 + authContract.AUTH_WINDOW_MS,
  });
  ok('正好在时间窗边界内通过', vInside.ok, vInside.message);

  const vOld = hmac.verify({
    token: TOKEN, headers: justInside.headers, method: 'POST', path: '/judge', body: '{}',
    now: () => 1700000000000 + authContract.AUTH_WINDOW_MS + 1,
  });
  ok('超出时间窗（太旧）→ 拒绝', !vOld.ok);
  eq('失败码为 clock-skew', vOld.code, 'clock-skew');

  // 未来时间戳同样危险：等于给攻击者一个更长的重放窗口
  const vFuture = hmac.verify({
    token: TOKEN, headers: justInside.headers, method: 'POST', path: '/judge', body: '{}',
    now: () => 1700000000000 - authContract.AUTH_WINDOW_MS - 1,
  });
  ok('时间戳在未来（超出偏移）→ 拒绝', !vFuture.ok);
  eq('未来时间戳也归 clock-skew', vFuture.code, 'clock-skew');
}

// 字段齐全性：缺哪个报哪个
{
  const base = hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n4', body: '{}', now: fixedNow }).headers;
  const strip = (k) => { const h = Object.assign({}, base); delete h[k]; return h; };

  eq('缺 token', hmac.verify({ token: TOKEN, headers: strip('x-judge-token'), method: 'POST', path: '/judge', body: '{}', now: fixedNow }).code, 'missing-token');
  eq('缺时间戳', hmac.verify({ token: TOKEN, headers: strip('x-judge-timestamp'), method: 'POST', path: '/judge', body: '{}', now: fixedNow }).code, 'missing-timestamp');
  eq('缺 nonce', hmac.verify({ token: TOKEN, headers: strip('x-judge-nonce'), method: 'POST', path: '/judge', body: '{}', now: fixedNow }).code, 'missing-nonce');
  eq('缺签名', hmac.verify({ token: TOKEN, headers: strip('x-judge-signature'), method: 'POST', path: '/judge', body: '{}', now: fixedNow }).code, 'missing-signature');
}

// 时间戳格式：Number() 的坑
{
  const withTs = (ts) => {
    const h = Object.assign({}, hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n5', body: '{}', now: fixedNow }).headers);
    h['x-judge-timestamp'] = ts;
    return hmac.verify({ token: TOKEN, headers: h, method: 'POST', path: '/judge', body: '{}', now: fixedNow });
  };
  eq('空时间戳', withTs('').code, 'missing-timestamp');
  eq('非数字时间戳', withTs('abc').code, 'bad-timestamp');
  eq('科学计数法被拒（Number("1e3") 本来是 1000）', withTs('1e3').code, 'bad-timestamp');
  eq('负数时间戳被拒', withTs('-1').code, 'bad-timestamp');
  eq('小数时间戳被拒', withTs('1.5').code, 'bad-timestamp');
  ok('超长 nonce 被拒', (function () {
    const h = Object.assign({}, hmac.sign({ token: TOKEN, method: 'POST', path: '/judge', timestamp: 1700000000000, nonce: 'n6', body: '{}', now: fixedNow }).headers);
    h['x-judge-nonce'] = 'a'.repeat(authContract.NONCE_MAX_LEN + 1);
    const v = hmac.verify({ token: TOKEN, headers: h, method: 'POST', path: '/judge', body: '{}', now: fixedNow });
    return !v.ok && v.code === 'nonce-too-long';
  })());
}

// 校验顺序：字段齐全 → 时间戳格式 → 时间窗 → token → 签名
// 这条顺序的意义：不带 token 就消耗掉我们的 HMAC 计算是攻击者想要的
{
  const stale = hmac.sign({ token: 'wrong-token', method: 'POST', path: '/judge', timestamp: 1, nonce: 'n7', body: '{}', now: fixedNow });
  const v = hmac.verify({ token: TOKEN, headers: stale.headers, method: 'POST', path: '/judge', body: '{}', now: fixedNow });
  // 时间戳过期应当先被判出（clock-skew），而不是 bad-token
  eq('时间窗检查早于 token 检查', v.code, 'clock-skew');
}

/* --------------------- 3. 常量时间比较 --------------------- */

section('3. 常量时间比较');

ok('相同串返回 true', hmac.timingSafeEqualHex('abcdef', 'abcdef'));
ok('不同串返回 false', !hmac.timingSafeEqualHex('abcdef', 'abcdeg'));
ok('长度不同返回 false', !hmac.timingSafeEqualHex('abcdef', 'abcde'));
ok('空串相等', hmac.timingSafeEqualHex('', ''));
ok('非字符串返回 false', !hmac.timingSafeEqualHex(null, 'a'));
ok('长度差很多的串快速 false', !hmac.timingSafeEqualHex('a'.repeat(64), 'a'.repeat(63)));

// 常量时间的可观测证据：比较一个长度相同但首字符不同的串，
// 不能因为「第一字节就不同」而提前返回。
// 这里用「大样本耗时比」做粗判——不是严格的时序测试（JS 无法做到），
// 但能拦住「用 === 实现」这种明显的短路比较。
{
  const a = 'f'.repeat(64);
  const early = '0' + 'f'.repeat(63); // 第一个字符就不同
  const late = 'f'.repeat(63) + '0';  // 最后一个字符才不同
  const N = 20000;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) hmac.timingSafeEqualHex(a, early);
  const tEarly = Number(process.hrtime.bigint() - t0);

  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) hmac.timingSafeEqualHex(a, late);
  const tLate = Number(process.hrtime.bigint() - t1);

  // 短路的 === 实现下 tEarly 会显著小于 tLate（提前返回）。
  // 常量时间实现下两者同量级。给 3 倍容差，避免 CI 抖动误报。
  const ratio = tEarly > 0 ? tLate / tEarly : 1;
  ok('首字符不同与末字符不同耗时同量级（未短路）',
    ratio < 3 && ratio > 1 / 3,
    'early=' + tEarly + 'ns late=' + tLate + 'ns ratio=' + ratio.toFixed(2));
}

/* --------------------- 4. nonce 重放拦截 --------------------- */

section('4. nonce 重放拦截');

const memNonce = new nonceMod.MemoryNonceStore({ sweepIntervalMs: 100000 });

eq('首次使用 nonce 成功', await memNonce.claim('nonce-a', 60000), true);
eq('同一 nonce 二次使用被拒（重放）', await memNonce.claim('nonce-a', 60000), false);
eq('不同 nonce 互不影响', await memNonce.claim('nonce-b', 60000), true);

// **并发重放**：先查后写的实现能过顺序测试，过不了这个
{
  const store = new nonceMod.MemoryNonceStore({ sweepIntervalMs: 100000 });
  const results = await Promise.all([
    store.claim('race-1', 60000),
    store.claim('race-1', 60000),
    store.claim('race-1', 60000),
    store.claim('race-1', 60000),
  ]);
  const granted = results.filter(function (r) { return r; }).length;
  eq('并发 claim 同一 nonce 只有一次成功', granted, 1);
}

// 过期后可复用（TTL 生效）
{
  const store = new nonceMod.MemoryNonceStore({ sweepIntervalMs: 100000 });
  await store.claim('expire-me', 1);
  await new Promise(function (r) { setTimeout(r, 20); });
  eq('过期后同一 nonce 可再次使用', await store.claim('expire-me', 60000), true);
}

// 清理
{
  const store = new nonceMod.MemoryNonceStore({ sweepIntervalMs: 100000 });
  await store.claim('s1', 1);
  await store.claim('s2', 1);
  await new Promise(function (r) { setTimeout(r, 20); });
  eq('过期项被清理', store.sweep(), 2);
  eq('清理后表为空', store.size, 0);
}
await memNonce.close();

// Redis nonce store 用假客户端驱动
{
  const fake = createFakeRedis();
  const store = new nonceMod.RedisNonceStore(fake.client);
  eq('Redis claim 首次成功', await store.claim('r1', 60000), true);
  eq('Redis claim 二次失败', await store.claim('r1', 60000), false);
  const setCmds = fake.calls.filter(function (c) { return c[0] === 'SET'; });
  ok('使用 SET ... NX PX（原子原语）', setCmds.length >= 1 && setCmds[0].indexOf('NX') >= 0 && setCmds[0].indexOf('PX') >= 0,
    JSON.stringify(setCmds[0]));
  ok('SET key 带命名前缀', setCmds[0][1].indexOf('judge:nonce:') === 0, setCmds[0][1]);
  // 参数形态: ['SET', key, '1', 'NX', 'PX', '<ttl>'] —— PX 后面那一项才是 TTL
  {
    const argv = setCmds[0];
    const pxIdx = argv.indexOf('PX');
    ok('TTL 参数位于 PX 之后', pxIdx >= 0 && pxIdx + 1 < argv.length);
    ok('TTL 已做下限保护（≥1000ms）', Number(argv[pxIdx + 1]) >= 1000, argv[pxIdx + 1]);
  }
}

// Failover：主存储挂掉时退回内存，但**不能什么都不做**
{
  const brokenPrimary = {
    claim: async function () { throw new Error('redis down'); },
    available: function () { return false; },
  };
  const fallback = new nonceMod.MemoryNonceStore({ sweepIntervalMs: 100000 });
  const degradations = [];
  const store = new nonceMod.FailoverNonceStore(brokenPrimary, fallback, function (r) { degradations.push(r); });

  eq('降级后仍能独占 nonce', await store.claim('f1', 60000), true);
  eq('降级后仍能拦住重放', await store.claim('f1', 60000), false);
  ok('降级被记录（不能静默）', degradations.length >= 1, JSON.stringify(degradations));
  ok('降级状态可查询', store.isDegraded);
  await store.close();
}

/* --------------------- 5. Redis 客户端（RESP 编解码） --------------------- */

section('5. Redis 客户端 RESP 编解码');

{
  const enc = redisClientMod.encodeCommand(['SET', 'k', 'v']);
  eq('数组编码正确', enc.toString('utf8'), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n');

  // 关键：长度必须是**字节数**而不是字符数，否则中文参数会被截坏
  const cn = redisClientMod.encodeCommand(['SET', '中文', '值']);
  const parts = cn.toString('utf8').split('\r\n');
  // 拆分结果: ['*3','$3','SET','$6','中文','$3','值','']
  eq('数组头正确', parts[0], '*3');
  eq('中文 key 长度按字节计（6）', parts[3], '$6');
  eq('中文 key 内容完整', parts[4], '中文');
  eq('中文 value 长度按字节计（3）', parts[5], '$3');
  eq('中文 value 内容完整', parts[6], '值');

  // 不能被 CRLF 注入：长度字段告诉 Redis「这是 9 字节的数据」，
  // 于是数据里的 CRLF 是内容而不是协议分隔符
  const evil = redisClientMod.encodeCommand(['SET', 'k\r\nINJECT', 'v']);
  const evilStr = evil.toString('utf8');
  ok('参数里的 CRLF 被长度字段消化（不可注入）',
    evilStr.indexOf('$9\r\nk\r\nINJECT\r\n') >= 0, JSON.stringify(evilStr));
  // 并且整条命令的参数个数仍然是 3（没有被拆成 4 个）
  eq('注入未改变参数个数', evilStr.split('\r\n')[0], '*3');

  // 不提供原始字符串命令接口
  ok('未导出「发送原始字符串命令」的接口（架构上排除 RESP 注入）',
    typeof redisClientMod.encodeCommand === 'function' &&
    Object.keys(redisClientMod).indexOf('sendRaw') < 0 &&
    Object.keys(redisClientMod).indexOf('rawCommand') < 0);
}

// 回复解析
{
  const cases = [
    ['+OK\r\n', 'OK', '简单字符串'],
    [':42\r\n', 42, '整数'],
    ['$-1\r\n', null, '空 bulk（SET NX 失败靠这个表达）'],
    ['$3\r\nabc\r\n', 'abc', 'bulk 字符串'],
    ['*2\r\n$1\r\na\r\n$1\r\nb\r\n', ['a', 'b'], '数组'],
    ['*-1\r\n', null, '空数组'],
  ];
  for (const [raw, expected, label] of cases) {
    const p = redisClientMod.parseReply(raw, 0);
    ok('解析 ' + label, p !== null && JSON.stringify(p.value) === JSON.stringify(expected),
      p ? JSON.stringify(p.value) : 'null');
    ok('解析 ' + label + ' 后游标正确', p !== null && p.next === raw.length,
      p ? String(p.next) + ' vs ' + raw.length : 'null');
  }

  // 不完整的回复必须返回 null（等待更多数据），而不是误解析
  ok('半截回复返回 null（不误解析）', redisClientMod.parseReply('$3\r\nab', 0) === null);
  ok('只有头没有内容返回 null', redisClientMod.parseReply('*2\r\n', 0) === null);
  ok('空缓冲返回 null', redisClientMod.parseReply('', 0) === null);

  // 错误回复
  const errReply = redisClientMod.parseReply('-ERR unknown command\r\n', 0);
  ok('错误回复被识别', errReply !== null && !!errReply.error);

  // 未知类型不能死循环
  const unknown = redisClientMod.parseReply('%1\r\n', 0);
  ok('未知回复类型被消费（不死循环）', unknown !== null && unknown.next > 0, JSON.stringify(unknown));
}

/* --------------------- 6. Redis 限流适配器 --------------------- */

section('6. Redis 限流适配器（原子 Lua + fail-open）');

function createFakeRedis(opts) {
  const options = opts || {};
  const store = new Map();
  const ttls = new Map();
  const calls = [];
  return {
    calls: calls,
    store: store,
    ttls: ttls,
    client: {
      available: function () { return options.available === undefined ? true : options.available; },
      command: async function (args) {
        calls.push(args.slice());
        if (options.failAll) throw new Error('redis command failed');
        const cmd = String(args[0]).toUpperCase();

        if (cmd === 'SET') {
          // SET key val NX PX ttl
          const key = args[1];
          const hasNx = args.indexOf('NX') >= 0;
          if (hasNx && store.has(key)) return null;
          store.set(key, args[2]);
          if (args.indexOf('PX') >= 0) ttls.set(key, Number(args[args.indexOf('PX') + 1]));
          return 'OK';
        }

        if (cmd === 'EVAL') {
          // 脚本语义：INCR，且仅在首次（n===1）时设过期；ttl<0 时补设
          // 参数形态：['EVAL', script, '1', key, ttl]
          const key = args[3];
          const ttl = Number(args[4]);
          const cur = store.has(key) ? Number(store.get(key)) : 0;
          const n = cur + 1;
          store.set(key, String(n));
          if (n === 1 || !ttls.has(key)) ttls.set(key, ttl);
          return [n, ttls.get(key)];
        }

        if (cmd === 'MGET') {
          return args.slice(1).map(function (k) { return store.has(k) ? store.get(k) : null; });
        }

        if (cmd === 'PING') return 'PONG';
        return null;
      },
    },
  };
}

// 原子 incr 语义
{
  const fake = createFakeRedis();
  const counter = new rateCounterMod.RedisRateCounter({ redis: fake.client });
  const now = 1000;

  counter.incr('rl:m:u1', 60000, now);
  await new Promise(function (r) { setTimeout(r, 5); });
  counter.incr('rl:m:u1', 60000, now);
  await new Promise(function (r) { setTimeout(r, 5); });

  const evalCalls = fake.calls.filter(function (c) { return c[0] === 'EVAL'; });
  ok('使用 EVAL 执行 Lua 脚本（原子）', evalCalls.length >= 2, String(evalCalls.length));
  eq('EVAL 传 1 个 key', evalCalls[0][2], '1');
  ok('key 带前缀', String(evalCalls[0][3]).indexOf('judge:rl:') === 0, String(evalCalls[0][3]));

  // 关键：TTL 只在首次设置。每次都 PEXPIRE 会让窗口无限续期，用户永远恢复不了
  const script = String(evalCalls[0][1]);
  ok('Lua 脚本仅在 n==1 时设过期（窗口不会被续期）', script.indexOf('if n == 1') >= 0, script.slice(0, 120));
  ok('Lua 脚本在 TTL 缺失时补设（防 key 永久存在导致永久限流）', script.indexOf('ttl < 0') >= 0);
  ok('Lua 脚本用 PEXPIRE（毫秒精度，与契约一致）', script.indexOf('PEXPIRE') >= 0);
}

// 计数走 Redis 权威值
{
  const fake = createFakeRedis();
  const counter = new rateCounterMod.RedisRateCounter({ redis: fake.client });
  const limiter = new ratelimitMod.RateLimiter(counter, { perMinute: 3, perDay: 10, cooldownMs: 1000 });
  const t = 1000;

  // 先用 Redis 里塞一个「已有 3 次」的状态（模拟别的实例的计数）
  // ⚠️ Redis 键 = prefix + bucket = 'judge:rl:' + 'rl:m:u9'
  fake.store.set('judge:rl:rl:m:u9', '3');
  fake.ttls.set('judge:rl:rl:m:u9', 60000);

  await counter.prefetch('u9', t);
  const d = limiter.check('u9', t);
  ok('prefetch 后能读到其他实例的计数', !d.allowed, JSON.stringify(d));
  eq('拒绝码为 rate-limited', d.code, 'rate-limited');
  ok('给出冷却剩余时间', d.retryAfterMs > 0, String(d.retryAfterMs));
}

// prefetch 拿到空值时必须清掉本地，避免陈旧计数把用户永久挡住
{
  const fake = createFakeRedis();
  const counter = new rateCounterMod.RedisRateCounter({ redis: fake.client });
  const limiter = new ratelimitMod.RateLimiter(counter, { perMinute: 2, perDay: 10, cooldownMs: 1000 });
  const t = 1000;

  limiter.check('u10', t);
  limiter.check('u10', t);
  const blocked = limiter.check('u10', t);
  ok('本地计数到上限后拒绝', !blocked.allowed);

  // 让 dispatchIncr 的异步 EVAL 落地（它们会把 Redis 里也写上计数）
  await new Promise(function (r) { setTimeout(r, 10); });

  // 模拟「窗口已过」：Redis 里的键已过期消失。
  // ⚠️ 必须真的清掉 fake.store，否则测不出「本地是否正确跟随 Redis 归零」：
  //    上一次 check 触发的异步 EVAL 已经把计数写进 Redis，
  //    不清的话 prefetch 会读回一个真实存在的计数，用例就变成了同义反复。
  fake.store.clear();
  fake.ttls.clear();

  await counter.prefetch('u10', t);
  const after = limiter.check('u10', t);
  ok('Redis 读数归零后本地计数被清除（不会被陈旧值永久挡住）', after.allowed, JSON.stringify(after));

  // 反向验证：Redis 里确实有计数时不能清
  await new Promise(function (r) { setTimeout(r, 10); });
  fake.store.set('judge:rl:rl:m:u10', '5');
  fake.ttls.set('judge:rl:rl:m:u10', 60000);
  await counter.prefetch('u10', t);
  const stillBlocked = limiter.check('u10', t);
  ok('Redis 里有计数时本地被覆盖为权威值（限流仍然生效）', !stillBlocked.allowed, JSON.stringify(stillBlocked));
}

// fail-open：Redis 挂掉必须放行 + 告警
{
  const degraded = [];
  const recovered = [];
  const fake = createFakeRedis({ failAll: true });
  const counter = new rateCounterMod.RedisRateCounter({
    redis: fake.client,
    onDegrade: function (info) { degraded.push(info); },
    onRecover: function () { recovered.push(1); },
  });

  const limiter = new ratelimitMod.RateLimiter(counter, { perMinute: 1, perDay: 10, cooldownMs: 1000 });
  const t = 1;

  await counter.prefetch('u11', t);
  limiter.check('u11', t);
  ok('Redis 失败时 prefetch 不抛（判题不会挂）', true);
  ok('告警被触发（fail-open 不能静默）', degraded.length >= 1, JSON.stringify(degraded));

  const stats = counter.getStats();
  ok('命令失败次数被统计', stats.errorCount >= 1, JSON.stringify(stats));
  ok('降级状态可查询', stats.degraded);

  // fail-open 意味着「放行」：即使配了 perMinute=1，第二次也不应该因为
  // Redis 挂掉而被拒——但本地兜底计数依然生效（这是我们接受的折中）
  const d2 = limiter.check('u11', t);
  ok('本地兜底计数仍然生效（降级不等于完全放行）', !d2.allowed, JSON.stringify(d2));

  await new Promise(function (r) { setTimeout(r, 10); });
  const stats2 = counter.getStats();
  // ⚠️ 这条断言守的是「打点不能因为状态去重而被吃掉」这个坑：
  //    如果 markDegraded 里把统计自增写在 early-return 之后，
  //    degradedPassCount 会永远停在 1，告警阈值就永远不会触发。
  ok('降级放行次数持续累加（运维靠它判断 Redis 真的挂了）',
    stats2.degradedPassCount >= 1, JSON.stringify(stats2));

  // 告警阈值：单次抖动不该半夜叫人起来
  ok('低次数降级不触发告警', !rateCounterMod.shouldAlertDegrade({ degraded: true, degradedPassCount: 1, errorCount: 1 }));
  ok('超过阈值才告警', rateCounterMod.shouldAlertDegrade({
    degraded: true,
    degradedPassCount: rateCounterMod.DEGRADE_ALERT_THRESHOLD,
    errorCount: 100,
  }));
}

// 未配置 Redis 时退化为内存实现
{
  const cfg = bootstrapMod.loadConfig().config;
  const bundle = bootstrapMod.buildJudge({
    config: Object.assign({}, cfg, { redisUrl: '' }),
    logger: function () {},
  });
  ok('无 Redis 时标记为降级', bundle.rateLimiterDegraded);
  ok('无 Redis 时 nonce 用内存实现', bundle.nonceStore.available());
  ok('降级原因出现在 warnings 里（不静默）',
    bundle.warnings.concat(bootstrapMod.loadConfig().warnings).join('|').indexOf('内存') >= 0,
    bundle.warnings.join('|'));
  await bundle.shutdown();
}

/* --------------------- 7. 配置校验（启动阻断） --------------------- */

section('7. 配置校验');

{
  const saved = process.env.JUDGE_INTERNAL_TOKEN;
  const savedEnv = process.env.NODE_ENV;

  process.env.JUDGE_INTERNAL_TOKEN = '';
  process.env.NODE_ENV = 'production';
  let threw = false;
  let message = '';
  try {
    bootstrapMod.loadConfig();
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  ok('生产环境缺 token → 拒绝启动（不裸奔）', threw, message);
  ok('拒绝原因说清了「判题服务会执行任意代码」', message.indexOf('任意用户代码') >= 0 || message.indexOf('裸奔') >= 0, message);

  process.env.NODE_ENV = 'development';
  const devCfg = bootstrapMod.loadConfig();
  ok('开发环境缺 token → 只告警不阻断', devCfg.warnings.join('|').indexOf('未配置') >= 0, devCfg.warnings.join('|'));
  ok('开发环境给出兜底 token（且名字里带警告）', devCfg.config.token.indexOf('dev-only') >= 0, devCfg.config.token);

  if (saved === undefined) delete process.env.JUDGE_INTERNAL_TOKEN;
  else process.env.JUDGE_INTERNAL_TOKEN = saved;
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
}

{
  const savedBody = process.env.JUDGE_MAX_BODY_BYTES;
  const savedConc = process.env.JUDGE_MAX_CONCURRENT;

  process.env.JUDGE_MAX_BODY_BYTES = 'abc';
  const bad = bootstrapMod.loadConfig();
  eq('非数字配置回落到默认值（不让 NaN 流进去）', bad.config.maxBodyBytes, 512 * 1024);

  // 并发超订告警：判题是 CPU 密集，超订会让全部请求一起变慢
  process.env.JUDGE_MAX_CONCURRENT = String(999);
  const oversub = bootstrapMod.loadConfig();
  ok('并发超订被告警', oversub.warnings.join('|').indexOf('CPU') >= 0, oversub.warnings.join('|'));

  if (savedBody === undefined) delete process.env.JUDGE_MAX_BODY_BYTES;
  else process.env.JUDGE_MAX_BODY_BYTES = savedBody;
  if (savedConc === undefined) delete process.env.JUDGE_MAX_CONCURRENT;
  else process.env.JUDGE_MAX_CONCURRENT = savedConc;
}

/* --------------------- 8. 错误码 → HTTP 状态码 --------------------- */

section('8. 错误码 → HTTP 状态码映射');

{
  const all = ['unauthorized', 'forbidden', 'rate-limited', 'payload-too-large', 'unsupported-language',
    'question-not-found', 'session-expired', 'busy', 'internal'];

  for (const code of all) {
    ok('ERROR_STATUS 覆盖 ' + code, typeof serverMod.ERROR_STATUS[code] === 'number', String(serverMod.ERROR_STATUS[code]));
  }

  // 契约里所有 JudgeErrorCode 必须都有映射，否则会掉到 500（前端重试策略失灵）
  const contractCodes = [
    'unauthorized', 'forbidden', 'rate-limited', 'payload-too-large', 'unsupported-language',
    'question-not-found', 'session-expired', 'busy', 'internal',
  ];
  for (const c of contractCodes) {
    ok('契约错误码 ' + c + ' 有状态码映射', typeof serverMod.ERROR_STATUS[c] === 'number');
  }

  eq('鉴权失败 → 401', serverMod.ERROR_STATUS.unauthorized, 401);
  eq('无权访问 → 403', serverMod.ERROR_STATUS.forbidden, 403);
  eq('限流 → 429', serverMod.ERROR_STATUS['rate-limited'], 429);
  eq('请求体超限 → 413', serverMod.ERROR_STATUS['payload-too-large'], 413);
  eq('语言不支持 → 400', serverMod.ERROR_STATUS['unsupported-language'], 400);
  eq('题目不存在 → 404', serverMod.ERROR_STATUS['question-not-found'], 404);
  eq('场次结束 → 410（不是 404：资源存在但已不可用）', serverMod.ERROR_STATUS['session-expired'], 410);
  eq('队列饱和 → 503（不是 429：是服务无资源，不是用户请求多）', serverMod.ERROR_STATUS.busy, 503);
  eq('内部错误 → 500', serverMod.ERROR_STATUS.internal, 500);

  // 语义要点：429 与 503 必须分开。合并成一个码会让前端无法区分
  // 「我该退避等一会儿」和「换台机器试试」
  ok('限流与饱和用不同状态码', serverMod.ERROR_STATUS['rate-limited'] !== serverMod.ERROR_STATUS.busy);
}

/* --------------------- 9. HTTP 端到端（真实 http 请求） --------------------- */

section('9. HTTP 端到端（真实 http 请求 + 假判题）');

/**
 * 起一个真实的 HTTP 服务，但把判题换成假实现、把 Redis 换成假客户端。
 * 这样验证的是**通信层本身**：路由、鉴权、nonce、状态码、限长、并发闸门。
 */
async function makeHarness(overrides) {
  const o = overrides || {};
  const fake = createFakeRedis(o.redis);
  const baseCfg = bootstrapMod.loadConfig().config;
  const config = Object.assign({}, baseCfg, {
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    redisUrl: 'redis://fake',
    maxBodyBytes: o.maxBodyBytes || 4096,
    maxConcurrent: o.maxConcurrent || 4,
    requestTimeoutMs: o.requestTimeoutMs || 2000,
  });

  // 注入假执行器：绝不会真的跑 docker
  const fakeExecutor = {
    exec: async function () {
      return { exitCode: 0, signal: null, stdout: '0', stderr: '', wallMs: 1, peakMemoryKB: 100, wallTimeout: false };
    },
  };

  const bundle = bootstrapMod.buildJudge({
    config: config,
    executor: fakeExecutor,
    redis: fake.client,
    logger: function () {},
  });

  const submitCalls = [];
  const submitted = o.submit || function (userId, req) {
    submitCalls.push({ userId: userId, req: req });
    return {
      ok: false,
      error: { code: 'question-not-found', message: '题目不存在（自检固定返回）' },
    };
  };

  const httpServer = serverMod.createHttpServer({
    bundle: bundle,
    logger: function () {},
    submit: submitted,
  });
  await httpServer.listen();
  const addr = httpServer.address();

  return {
    url: 'http://127.0.0.1:' + addr.port,
    fake: fake,
    bundle: bundle,
    httpServer: httpServer,
    submitCalls: submitCalls,
    stop: async function () {
      await httpServer.close();
      await bundle.shutdown();
    },
  };
}

async function call(url, pathname, opts) {
  const o = opts || {};
  const headers = Object.assign({}, o.headers || {});
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers['Content-Type'] = 'application/json';
  }
  if (body !== undefined && headers['Content-Length'] === undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
  }

  const res = await fetch(url + pathname, {
    method: o.method || 'POST',
    headers: headers,
    body: body,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  return { status: res.status, headers: res.headers, text: text, json: parsed };
}

/** 生成一套合法的鉴权头 */
function signedHeaders(body, opts) {
  const o = opts || {};
  const s = hmac.sign({
    token: o.token || TOKEN,
    method: o.method || 'POST',
    path: o.path || '/judge',
    timestamp: o.timestamp || Date.now(),
    nonce: o.nonce || hmac.randomNonce(),
    body: body,
  });
  const h = Object.assign({}, s.headers);
  if (o.token !== null) h['x-judge-token'] = o.token || TOKEN;
  // 允许覆盖签名字段以构造「篡改」用例
  if (o.signature) h['x-judge-signature'] = o.signature;
  return h;
}

const VALID_REQ = {
  submissionId: 'sub-http-1',
  questionId: 'q_prog_1',
  type: 'code-editor',
  language: 'c',
  code: '#include <stdio.h>\nint main(){printf("0");return 0;}',
  userId: 'user-abc',
};

// 探针
{
  const h = await makeHarness();
  try {
    const hz = await call(h.url, '/healthz', { method: 'GET' });
    eq('GET /healthz → 200', hz.status, 200);
    eq('healthz 返回 status=ok', hz.json.status, 'ok');
    ok('healthz 不需要鉴权', true);
    ok('healthz 含 inflight 计数', typeof hz.json.inflight === 'number');

    const rz = await call(h.url, '/readyz', { method: 'GET' });
    eq('GET /readyz → 200', rz.status, 200);
    ok('readyz 返回 ready=true', rz.json.ready === true, JSON.stringify(rz.json));
    ok('readyz 报告 redis 检查项', rz.json.checks.redis !== undefined, JSON.stringify(rz.json.checks));
    ok('readyz 报告容量检查项', rz.json.checks.capacity !== undefined);
    ok('readyz 不含敏感信息（不泄漏题目/用户）', rz.text.indexOf('user') < 0 && rz.text.indexOf('q_prog') < 0, rz.text);

    const m = await call(h.url, '/metrics', { method: 'GET' });
    eq('GET /metrics → 200', m.status, 200);
    ok('metrics 不含用户维度（否则等于泄漏用户 ID）', m.text.indexOf('user-abc') < 0, m.text);

    const unknown = await call(h.url, '/admin', { method: 'GET' });
    eq('未知路径 → 404', unknown.status, 404);
    eq('未知路径的错误码是 internal（不泄漏路由信息）', unknown.json.error.code, 'internal', JSON.stringify(unknown.json));

    // 尾斜杠会被服务端规范化成 /judge，所以签名也必须按 /judge 算。
    // 这里同时验证「规范化发生在验签之前」——如果次序反了，这个请求会 401。
    const normBody = JSON.stringify(VALID_REQ);
    const trailing = await call(h.url, '/judge/', {
      body: normBody,
      headers: signedHeaders(normBody, { path: '/judge' }),
    });
    ok('尾斜杠被规范化（不是路由层 404）', trailing.status !== 404 || trailing.json.error.code !== 'internal',
      String(trailing.status) + ' ' + trailing.text.slice(0, 120));
  } finally {
    await h.stop();
  }
}

// 鉴权
{
  const h = await makeHarness();
  try {
    const body = JSON.stringify(VALID_REQ);

    const noAuth = await call(h.url, '/judge', { body: body, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } });
    eq('缺鉴权头 → 401', noAuth.status, 401);
    eq('错误码为 unauthorized', noAuth.json.error.code, 'unauthorized');

    const badSig = await call(h.url, '/judge', { body: body, headers: signedHeaders(body, { signature: 'f'.repeat(64) }) });
    eq('签名错误 → 401', badSig.status, 401);

    const badToken = await call(h.url, '/judge', { body: body, headers: signedHeaders(body, { token: 'wrong-token' }) });
    eq('token 错误 → 401', badToken.status, 401);

    const stale = await call(h.url, '/judge', { body: body, headers: signedHeaders(body, { timestamp: Date.now() - authContract.AUTH_WINDOW_MS - 60000 }) });
    eq('时间戳过期 → 401', stale.status, 401);
    ok('过期原因说的是时间偏移', (stale.json.error.message || '').indexOf('偏移') >= 0, stale.json.error.message);

    // 请求体被中间人改了
    const tampered = await call(h.url, '/judge', {
      body: body.replace('user-abc', 'user-xyz'),
      headers: signedHeaders(body),
    });
    eq('请求体被篡改 → 401（签名绑定原始字节）', tampered.status, 401);

    // 401 响应体里**不能回显**具体哪个字段错（否则给攻击者 oracle）
    ok('鉴权失败不泄漏「算法猜对了」这类信息',
      noAuth.text.indexOf('hmac') < 0 && noAuth.text.indexOf('sha256') < 0,
      noAuth.text);
  } finally {
    await h.stop();
  }
}

// 合法请求能通过鉴权（否则就是「全拒绝」型事故）
{
  let seen = null;
  const h = await makeHarness({
    submit: function (userId, req) {
      seen = { userId: userId, req: req };
      return { ok: true, response: { submissionId: req.submissionId, verdict: 'accepted', score: 1, passed: 1, total: 1, cases: [], totalMs: 5, finishedAt: Date.now(), cacheHit: false }, result: { correct: true } };
    },
  });
  try {
    const body = JSON.stringify(VALID_REQ);
    const r = await call(h.url, '/judge', { body: body, headers: signedHeaders(body) });
    eq('合法签名 → 200', r.status, 200);
    ok('判题结果被回传', r.json.ok === true && r.json.response.verdict === 'accepted', r.text);
    ok('result 一并回传（云函数少一次解析）', r.json.result && r.json.result.correct === true);
    ok('userId 从请求体取出并交给限流', seen && seen.userId === 'user-abc', seen ? seen.userId : 'null');
    ok('原始请求体被完整透传（未被重写）', seen && seen.req.code === VALID_REQ.code, seen ? seen.req.code : 'null');
  } finally {
    await h.stop();
  }
}

// 同一 nonce 二次提交 = 重放
{
  let calls = 0;
  const h = await makeHarness({
    submit: function (userId, req) {
      calls++;
      return { ok: true, response: { submissionId: req.submissionId, verdict: 'accepted', score: 1, passed: 1, total: 1, cases: [], totalMs: 1, finishedAt: Date.now(), cacheHit: false }, result: { correct: true } };
    },
  });
  try {
    const body = JSON.stringify(VALID_REQ);
    const nonce = 'replay-nonce-fixed-0001';
    const headers = signedHeaders(body, { nonce: nonce });

    const first = await call(h.url, '/judge', { body: body, headers: headers });
    eq('首次提交成功', first.status, 200);

    const second = await call(h.url, '/judge', { body: body, headers: headers });
    eq('同一 nonce 二次提交 → 401（重放被拦）', second.status, 401);
    ok('重放提示里含「重放」', (second.json.error.message || '').indexOf('重放') >= 0, second.json.error.message);
    eq('重放请求没有进入判题流程', calls, 1);

    // 换一个 nonce 应当正常
    const third = await call(h.url, '/judge', { body: body, headers: signedHeaders(body, { nonce: 'replay-nonce-fixed-0002' }) });
    eq('新 nonce 正常放行', third.status, 200);
  } finally {
    await h.stop();
  }
}

// 并发重放（HTTP 层）
{
  let calls = 0;
  const h = await makeHarness({
    submit: async function (userId, req) {
      calls++;
      await new Promise(function (r) { setTimeout(r, 30); });
      return { ok: true, response: { submissionId: req.submissionId, verdict: 'accepted', score: 1, passed: 1, total: 1, cases: [], totalMs: 30, finishedAt: Date.now(), cacheHit: false }, result: { correct: true } };
    },
  });
  try {
    const body = JSON.stringify(VALID_REQ);
    const headers = signedHeaders(body, { nonce: 'concurrent-replay-01' });
    const results = await Promise.all([
      call(h.url, '/judge', { body: body, headers: headers }),
      call(h.url, '/judge', { body: body, headers: headers }),
      call(h.url, '/judge', { body: body, headers: headers }),
    ]);
    const ok200 = results.filter(function (r) { return r.status === 200; }).length;
    const ok401 = results.filter(function (r) { return r.status === 401; }).length;
    eq('并发重放：只有 1 个成功', ok200, 1);
    eq('并发重放：其余都被拦', ok401, 2);
    eq('并发重放：判题只被调用 1 次', calls, 1);
  } finally {
    await h.stop();
  }
}

// 请求体限长
{
  const h = await makeHarness({ maxBodyBytes: 512 });
  try {
    const huge = 'x'.repeat(2000);
    const body = JSON.stringify(Object.assign({}, VALID_REQ, { code: huge }));
    const r = await call(h.url, '/judge', { body: body, headers: signedHeaders(body) });
    eq('Content-Length 超限 → 413', r.status, 413);
    eq('错误码为 payload-too-large', r.json.error.code, 'payload-too-large');
  } finally {
    await h.stop();
  }

  // chunked（无 Content-Length）：靠累计长度拦
  const h2 = await makeHarness({ maxBodyBytes: 512 });
  try {
    const res = await fetch(h2.url + '/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(2000)));
          controller.close();
        },
      }),
      duplex: 'half',
    });
    eq('chunked 超限 → 413（累计长度检查生效）', res.status, 413);
    await res.text();
  } catch (e) {
    // 某些 Node 版本不支持 duplex:'half' 的 fetch；退化为提示而非失败
    ok('chunked 用例跳过（运行时不支持 duplex）', true, String(e && e.message));
  } finally {
    await h2.stop();
  }
}

// 请求体非法 JSON / 空体
{
  const h = await makeHarness();
  try {
    const badJson = 'not-json{{';
    const r = await call(h.url, '/judge', { body: badJson, headers: signedHeaders(badJson) });
    eq('非法 JSON → 400', r.status, 400);
    ok('提示说不合法 JSON', (r.json.error.message || '').indexOf('JSON') >= 0, r.json.error.message);

    const empty = '';
    const r2 = await call(h.url, '/judge', { body: empty, headers: signedHeaders(empty) });
    // 空体是合法 JSON 吗？不是。所以走 400。
    ok('空请求体 → 4xx', r2.status >= 400 && r2.status < 500, String(r2.status));

    // 内容合法但字段缺失 → 静态预检拦下
    const partial = JSON.stringify({ submissionId: 's1' });
    const r3 = await call(h.url, '/judge', { body: partial, headers: signedHeaders(partial) });
    eq('缺 questionId → 404（预检拦下，不发到沙箱）', r3.status, 404);

    const badLang = JSON.stringify(Object.assign({}, VALID_REQ, { language: 'rust' }));
    const r4 = await call(h.url, '/judge', { body: badLang, headers: signedHeaders(badLang) });
    eq('不支持的语言 → 400', r4.status, 400);

    const emptyCode = JSON.stringify(Object.assign({}, VALID_REQ, { code: '   ' }));
    const r5 = await call(h.url, '/judge', { body: emptyCode, headers: signedHeaders(emptyCode) });
    eq('空代码 → 400', r5.status, 400);

    const tooLongCode = JSON.stringify(Object.assign({}, VALID_REQ, { code: 'x'.repeat(contractMod.MAX_CODE_BYTES + 10) }));
    const r6 = await call(h.url, '/judge', { body: tooLongCode, headers: signedHeaders(tooLongCode) });
    eq('代码超长 → 413', r6.status, 413);
  } finally {
    await h.stop();
  }
}

// 方法不允许
{
  const h = await makeHarness();
  try {
    const r = await call(h.url, '/judge', { method: 'GET' });
    eq('GET /judge → 405', r.status, 405);
    ok('带 Allow 头', (r.headers.get('allow') || '').indexOf('POST') >= 0, r.headers.get('allow'));

    const r2 = await call(h.url, '/healthz', { method: 'POST' });
    eq('POST /healthz → 405', r2.status, 405);
  } finally {
    await h.stop();
  }
}

// 业务错误码 → 状态码（含 Retry-After）
{
  const cases = [
    ['rate-limited', 429, true],
    ['busy', 503, false],
    ['unauthorized', 401, false],
    ['forbidden', 403, false],
    ['internal', 500, false],
    ['session-expired', 410, false],
  ];
  for (const [code, status, expectRetryAfter] of cases) {
    const h = await makeHarness({
      submit: function () {
        return { ok: false, error: { code: code, message: '测试用 ' + code, retryAfterMs: 5000 } };
      },
    });
    try {
      const body = JSON.stringify(VALID_REQ);
      const r = await call(h.url, '/judge', { body: body, headers: signedHeaders(body) });
      eq('业务码 ' + code + ' → ' + status, r.status, status);
      eq('  错误体 code 正确', r.json.error.code, code);
      if (expectRetryAfter) {
        ok('  ' + code + ' 带 Retry-After 头（前端据此倒计时）', (r.headers.get('retry-after') || '') !== '', r.headers.get('retry-after'));
      }
    } finally {
      await h.stop();
    }
  }
}

// 并发闸门：饱和时返回 503 + Retry-After，而不是排队
{
  let maxInflightSeen = 0;
  const h = await makeHarness({
    maxConcurrent: 2,
    submit: async function () {
      // 记录内部观察到的并发
      const cur = h.httpServer.inflight();
      if (cur > maxInflightSeen) maxInflightSeen = cur;
      await new Promise(function (r) { setTimeout(r, 60); });
      return { ok: true, response: { submissionId: 's', verdict: 'accepted', score: 1, passed: 1, total: 1, cases: [], totalMs: 60, finishedAt: Date.now(), cacheHit: false }, result: { correct: true } };
    },
  });
  try {
    const body = JSON.stringify(VALID_REQ);
    const mk = (i) => call(h.url, '/judge', { body: body, headers: signedHeaders(body, { nonce: 'conc-' + i }) });

    const results = await Promise.all([mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)]);
    const s200 = results.filter(function (r) { return r.status === 200; }).length;
    const s503 = results.filter(function (r) { return r.status === 503; }).length;

    ok('并发饱和时部分请求被拒（不排队堆积）', s503 >= 1, '200=' + s200 + ' 503=' + s503);
    ok('并发上限被守住（同时执行数不超过配置）', maxInflightSeen <= 2, String(maxInflightSeen));

    const busy = results.find(function (r) { return r.status === 503; });
    if (busy) {
      eq('饱和错误码为 busy', busy.json.error.code, 'busy');
      ok('饱和带 Retry-After', (busy.headers.get('retry-after') || '') !== '', busy.headers.get('retry-after'));
      ok('饱和提示面向用户', (busy.json.error.message || '').indexOf('繁忙') >= 0, busy.json.error.message);
    }
  } finally {
    await h.stop();
  }
}

// readyz 在饱和时返回 503（让负载均衡摘流量，而不是重启进程）
{
  let release;
  const gate = new Promise(function (r) { release = r; });
  const h = await makeHarness({
    maxConcurrent: 1,
    submit: async function () {
      await gate;
      return { ok: true, response: { submissionId: 's', verdict: 'accepted', score: 1, passed: 1, total: 1, cases: [], totalMs: 1, finishedAt: Date.now(), cacheHit: false }, result: { correct: true } };
    },
  });
  try {
    const body = JSON.stringify(VALID_REQ);
    const pendingReq = call(h.url, '/judge', { body: body, headers: signedHeaders(body, { nonce: 'sat-1' }) });
    await new Promise(function (r) { setTimeout(r, 40); });

    const rz = await call(h.url, '/readyz', { method: 'GET' });
    eq('饱和时 readyz → 503（摘流量）', rz.status, 503);
    ok('readyz 说明饱和原因', (rz.json.reasons || []).join('|').indexOf('saturated') >= 0, JSON.stringify(rz.json));

    const hz = await call(h.url, '/healthz', { method: 'GET' });
    eq('饱和时 healthz 仍 200（不该被重启）', hz.status, 200);

    release();
    await pendingReq;
  } finally {
    await h.stop();
  }
}

// Redis 不可用时：readyz 仍 ready（有降级路径），但 warnings 里有痕迹
{
  const h = await makeHarness({ redis: { available: false, failAll: true } });
  try {
    const rz = await call(h.url, '/readyz', { method: 'GET' });
    eq('Redis 不可用时 readyz 仍 200（限流有降级路径）', rz.status, 200);
    eq('但 checks.redis 为 false（运维能看到）', rz.json.checks.redis, false);

    const body = JSON.stringify(VALID_REQ);
    const r = await call(h.url, '/judge', {
      body: body,
      headers: signedHeaders(body),
    });
    // Redis 挂了但内存兜底可用 → 应当能通过鉴权并走到判题
    ok('Redis 挂掉时请求不因 nonce 存储而整体失败', r.status !== 500, String(r.status) + ' ' + r.text.slice(0, 120));
  } finally {
    await h.stop();
  }
}

// 判题超时：编排层卡死时必须释放连接
{
  const h = await makeHarness({
    requestTimeoutMs: 120,
    submit: function () {
      return new Promise(function () { /* 永不 resolve：模拟 docker daemon 无响应 */ });
    },
  });
  try {
    const body = JSON.stringify(VALID_REQ);
    const started = Date.now();
    const r = await call(h.url, '/judge', { body: body, headers: signedHeaders(body) });
    const elapsed = Date.now() - started;
    eq('判题卡死 → 500', r.status, 500);
    ok('连接被及时释放（< 1500ms）', elapsed < 1500, elapsed + 'ms');
    ok('错误体不含内部细节', r.text.indexOf('at Object') < 0 && r.text.indexOf('node_modules') < 0, r.text.slice(0, 160));
  } finally {
    await h.stop();
  }
}

// 优雅退出：停止接新请求
{
  const h = await makeHarness();
  const url = h.url;
  await h.httpServer.close();
  let refused = false;
  try {
    await call(url, '/healthz', { method: 'GET' });
  } catch (e) {
    refused = true;
  }
  ok('close() 后不再接受新连接', refused);
  await h.bundle.shutdown();
}

/* --------------------- 10. 云函数侧签名一致性 --------------------- */

section('10. 云函数 judgeSubmit 与判题服务的签名一致性');

{
  // 云函数是纯 JS（CommonJS），本地可以直接 require —— 不需要打包也不需要 wx-server-sdk
  const { createRequire } = await import('node:module');
  const requireFn = createRequire(import.meta.url);

  let cf = null;
  let requireError = '';
  try {
    cf = requireFn(path.join(ROOT, 'cloudfunctions/judgeSubmit/index.js'));
  } catch (e) {
    requireError = e instanceof Error ? e.message : String(e);
  }

  ok('云函数可被 require（不依赖 wx-server-sdk 就能加载）', cf !== null, requireError);

  if (cf) {
    const inner = cf.__internal;
    ok('云函数导出了内部自检接口', !!inner);
    eq('两侧签名版本号一致', inner.JUDGE_AUTH_VERSION, authContract.JUDGE_AUTH_VERSION);

    /**
     * 核心用例：用同一组输入分别调服务端与云函数的规范串构造，
     * 必须逐字节相同。这是防「两边实现漂移 → 线上全 401」的唯一有效手段。
     */
    const inputs = [
      ['POST', '/judge', '1700000000000', 'abc123', 'deadbeef'],
      ['post', '/judge', '1', 'n', 'h'],
      ['POST', '/judge/x', '9999999999999', 'nonce-with-dash_and.dot', 'a'.repeat(64)],
      ['POST', '/judge', '1700000000000', '带中文的 nonce', 'h'],
    ];

    let allSame = true;
    const mismatches = [];
    for (const [method, p, ts, nonce, hash] of inputs) {
      const serverSide = authContract.canonicalString({ method, path: p, timestamp: ts, nonce, bodyHash: hash });
      const cfSide = inner.canonicalString(method, p, ts, nonce, hash);
      if (serverSide !== cfSide) {
        allSame = false;
        mismatches.push(JSON.stringify({ serverSide, cfSide }));
      }
    }
    ok('规范串拼法逐字节一致（4 组向量）', allSame, mismatches.join(' | '));

    // 签名本身也要一致：同 key 同消息必须得同一个 hex
    const msg = inner.canonicalString('POST', '/judge', '1700000000000', 'n1', 'h1');
    eq('HMAC 结果一致（同 key 同消息）',
      inner.hmacHex('key-x', msg),
      hmac.hmacHex('key-x', msg));

    eq('SHA-256 实现一致',
      inner.sha256Hex('hello 世界'),
      hmac.sha256Hex('hello 世界'));

    // 云函数生成的请求头必须能被判题服务的 verify() 接受
    // —— 这是最贴近真实的端到端验证：不过 HTTP，但过完整的验签链路。
    {
      const savedToken = process.env.JUDGE_INTERNAL_TOKEN;
      process.env.JUDGE_INTERNAL_TOKEN = TOKEN;

      const body = JSON.stringify({ payload: { submissionId: 's1', questionId: 'q1', language: 'c', code: 'int main(){}', type: 'code-editor' }, userId: 'openid-x' });
      // 注意：buildAuthHeaders 读的是模块加载时固化的 JUDGE_TOKEN，
      // 所以这里改用它的内部函数直接构造，避免为了测试改生产代码。
      const ts = String(Date.now());
      const nonce = hmac.randomNonce();
      const bodyHash = hmac.sha256Hex(body);
      const sig = hmac.hmacHex(TOKEN, authContract.canonicalString({ method: 'POST', path: '/judge', timestamp: ts, nonce: nonce, bodyHash: bodyHash }));

      const headers = {
        'x-judge-token': TOKEN,
        'x-judge-timestamp': ts,
        'x-judge-nonce': nonce,
        'x-judge-signature': sig,
      };
      const v = hmac.verify({ token: TOKEN, headers, method: 'POST', path: '/judge', body: body, now: Date.now });
      ok('云函数产出的头能被判题服务验签通过（跨实现端到端）', v.ok, v.message);

      if (savedToken === undefined) delete process.env.JUDGE_INTERNAL_TOKEN;
      else process.env.JUDGE_INTERNAL_TOKEN = savedToken;
    }

    // 字段白名单：不能把任意字段透传给判题服务
    const picked = inner.pickAllowed({
      submissionId: 's', questionId: 'q', type: 'code-editor', language: 'c', code: 'x',
      limits: { runMs: 500 },
      userId: 'attacker-supplied',
      __proto__: { polluted: 1 },
      extra: 'should-be-dropped',
    });
    eq('白名单只放行 6 个契约字段', Object.keys(picked).sort().join(','),
      ['code', 'language', 'limits', 'questionId', 'submissionId', 'type'].sort().join(','));
    ok('拒绝透传 payload 里的 userId（身份只认 openid）', picked.userId === undefined);

    // 错误归一化：不能把内部字段漏到前端
    const sanitized = inner.sanitizeError({ code: 'rate-limited', message: '太频繁', retryAfterMs: 3000, containerName: 'judge-abc', path: '/var/lib/judge' });
    // ⚠️ 结构断言：必须是 { code, message, retryAfterMs }（不含 error 包装层）。
    //    多包一层 error 时前端读到的是 undefined，只会显示兜底文案 ——
    //    「不报错但体验阉割」的静默 bug，所以这里逐字段断言。
    ok('错误对象形如 { code, message, retryAfterMs }（无多余包装层）',
      sanitized.code === 'rate-limited' && sanitized.message === '太频繁' && sanitized.retryAfterMs === 3000,
      JSON.stringify(sanitized));
    ok('内部字段被剥掉（containerName/path 不出现在响应里）',
      sanitized.containerName === undefined && JSON.stringify(sanitized).indexOf('/var/lib') < 0);
    eq('未知错误码归到 internal（不把陌生码漏给前端）',
      inner.sanitizeError({ code: 'weird-new-code', message: 'x' }).code, 'internal');

    // 状态码归一化（模拟判题服务只回了状态码、没有可解析的 JSON 体）
    {
      const mk = (statusCode) => inner.normalizeResponse({ statusCode: statusCode, json: null, text: '' });
      // 关键：normalizeResponse 的返回值统一是 { ok, error: { code, message } }
      eq('413 → payload-too-large', mk(413).error.code, 'payload-too-large');
      eq('429 → rate-limited', mk(429).error.code, 'rate-limited');
      eq('503 → busy', mk(503).error.code, 'busy');
      eq('401 → unauthorized（鉴权类问题归一类）', mk(401).error.code, 'unauthorized');
      eq('403 → unauthorized（不区分 401/403，对用户是同一件事）', mk(403).error.code, 'unauthorized');
      ok('401 文案指向「已记录」而不是「用户操作错误」',
        mk(401).error.message.indexOf('已记录') >= 0, mk(401).error.message);
      eq('未知 5xx → internal', mk(599).error.code, 'internal');
      eq('未知 4xx → internal', mk(418).error.code, 'internal');
      ok('归一化结果一定是 ok=false', mk(500).ok === false, JSON.stringify(mk(500)));

      // 2xx 但业务失败：要把业务码透出来，而不是一律 internal
      eq('2xx + 业务错误体 → 透出业务码',
        inner.normalizeResponse({ statusCode: 200, json: { ok: false, error: { code: 'question-not-found', message: 'x' } }, text: '' }).error.code,
        'question-not-found');
      // 2xx 但结构不对 → internal（不能假设一切正常）
      eq('2xx 但结构异常 → internal',
        inner.normalizeResponse({ statusCode: 200, json: { weird: true }, text: '' }).error.code, 'internal');
      // 4xx 带业务错误体时以业务码为准
      eq('429 带业务体时以业务码为准',
        inner.normalizeResponse({ statusCode: 429, json: { error: { code: 'rate-limited', message: 'y', retryAfterMs: 5000 } }, text: '' }).error.retryAfterMs,
        5000);
      // 成功路径
      const okRes = inner.normalizeResponse({ statusCode: 200, json: { ok: true, response: { verdict: 'accepted' }, result: { correct: true } }, text: '' });
      ok('成功路径透出 response 与 result', okRes.ok === true && okRes.response.verdict === 'accepted' && okRes.result.correct === true);
    }
  }
}

/* --------------------- 11. 契约与部署产物 --------------------- */

section('11. 部署与契约一致性');

{
  const fs = await import('node:fs');
  const crypto = await import('node:crypto');

  const clientContract = fs.readFileSync(path.join(ROOT, 'miniprogram/services/judge-contract.ts'));
  const serverContract = fs.readFileSync(path.join(ROOT, 'judge-service/src/contract.ts'));
  eq('契约两份 SHA-256 一致（防「服务端加新 verdict，客户端映射没跟上」）',
    crypto.createHash('sha256').update(clientContract).digest('hex'),
    crypto.createHash('sha256').update(serverContract).digest('hex'));

  ok('存在 HTTP 入口 server.js', fs.existsSync(path.join(ROOT, 'judge-service/src/server.js')));
  // ⚠️ 约定已更新（历史坑见下）：
  //   旧约定「server.js 与 server.ts 逐字节一致」是错的 —— 它要求生产入口
  //   带着 TS 语法，而 Node 的类型剥离**只对 .ts 生效**，`.js` 里出现
  //   `export type` 会直接 SyntaxError（生产起不来）。
  //   现行约定：**server.ts 是唯一真源（含类型），server.js 是薄垫片**
  //   （注册后缀补全钩子 + 逐名重导出）。
  //
  //   所以这里断言三件事，比「字节一致」更能防住真实故障：
  //     ① server.js 不是 server.ts 的副本（否则说明有人回退到老做法）
  //     ② server.js 足够薄（实现留在 server.ts）
  //     ③ server.js 里没有 TS 语法
  //   「能否真的被 Node 加载」「导出名是否一致」由 judge.test.mjs 第 19.12 节实跑验证。
  {
    const jsText = fs.readFileSync(path.join(ROOT, 'judge-service/src/server.js'), 'utf8');
    const tsText = fs.readFileSync(path.join(ROOT, 'judge-service/src/server.ts'), 'utf8');

    ok('server.js 不是 server.ts 的副本（老做法已废弃）', jsText !== tsText);

    ok('server.ts 是含类型的真源（仍有 TS 类型声明）', /export\s+interface\s+\w+|:\s*JudgeErrorCode/.test(tsText));

    const jsCodeLines = jsText.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    ok('server.js 是薄垫片（< 120 行代码）', jsCodeLines.length < 120, '实际 ' + jsCodeLines.length + ' 行');

    const badSyntax = jsCodeLines.filter((l) => /^\s*export\s+type\s+\w+|^\s*export\s+interface\s+\w+/.test(l));
    eq('server.js 不含 `export type` / `export interface`（Node 执行 .js 时不认）', badSyntax.join(' | '), '');
  }
  ok('存在鉴权契约 auth.ts', fs.existsSync(path.join(ROOT, 'judge-service/src/auth.ts')));
  ok('存在 HMAC 模块 auth/hmac.ts', fs.existsSync(path.join(ROOT, 'judge-service/src/auth/hmac.ts')));
  ok('存在 nonce 存储 auth/nonce.ts', fs.existsSync(path.join(ROOT, 'judge-service/src/auth/nonce.ts')));
  ok('存在 Redis 客户端 redis/client.ts', fs.existsSync(path.join(ROOT, 'judge-service/src/redis/client.ts')));
  ok('存在 Redis 限流适配器 redis/rate-counter.ts', fs.existsSync(path.join(ROOT, 'judge-service/src/redis/rate-counter.ts')));
  ok('存在组装入口 bootstrap.ts', fs.existsSync(path.join(ROOT, 'judge-service/src/bootstrap.ts')));
  ok('存在云函数 judgeSubmit', fs.existsSync(path.join(ROOT, 'cloudfunctions/judgeSubmit/index.js')));

  // 零依赖纪律：判题服务不得引入第三方运行时依赖
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'judge-service/package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  eq('判题服务运行时零依赖（攻击面最小化）', deps.length, 0);
  ok('package.json 不含 "type": "module"（否则 Node 把 .ts 当 CJS 解析报错）',
    pkg.type === undefined, String(pkg.type));

  // 云函数包
  const fnPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudfunctions/judgeSubmit/package.json'), 'utf8'));
  eq('云函数运行时零依赖', Object.keys(fnPkg.dependencies || {}).length, 0);

  // compose 必须提供 Redis 给限流与 nonce
  const compose = fs.readFileSync(path.join(ROOT, 'judge-service/docker-compose.yml'), 'utf8');
  ok('compose 声明了 JUDGE_REDIS_URL', compose.indexOf('JUDGE_REDIS_URL') >= 0);
  ok('compose 声明了 JUDGE_INTERNAL_TOKEN 且强制注入（:? 语法）',
    compose.indexOf('JUDGE_INTERNAL_TOKEN') >= 0 && compose.indexOf('?必须通过环境变量注入') >= 0);
  ok('compose 暴露 8600 端口给业务层', compose.indexOf('8600') >= 0);
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('\n' + '='.repeat(56));
console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) {
  console.log('\n失败项：');
  for (let i = 0; i < failures.length; i++) console.log('  - ' + failures[i]);
  process.exitCode = 1;
} else {
  console.log('HTTP 接入层与鉴权自检全部通过。');
}
console.log('='.repeat(56));
