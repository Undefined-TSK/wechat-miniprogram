/**
 * 端到端冒烟：真实启动生产入口 server.js，走完整 HTTP 链路判 Boss 关客观题。
 *
 * 这是本轮修复的最终验证 —— Boss 关客观题曾 100% 判 0 分（用户答对也不通过）。
 * 不依赖任何测试框架，直接 spawn Dockerfile 里那同一条启动命令。
 */

import { spawn } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 无论从哪个目录调用，都相对「项目根」解析（本脚本在 scripts/ 下）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 冒烟脚本自己要 import 判题服务的 .ts 来造签名，同样需要后缀补全钩子。
// （生产入口 server.js 自带钩子，这里只影响本脚本自身）
register(
  'data:text/javascript;base64,' +
    Buffer.from(
      "const E=['.ts','.tsx','/index.ts','/index.tsx'];" +
        'export async function resolve(s,c,n){' +
        "if(!s.startsWith('./')&&!s.startsWith('../'))return n(s,c);" +
        'try{return await n(s,c)}catch(e){' +
        'for(const x of E){try{return await n(s+x,c)}catch(i){}}throw e}}',
      'utf8'
    ).toString('base64'),
  pathToFileURL(import.meta.url)
);

const PORT = 28765;
const TOKEN = 'smoke-token-' + 'a'.repeat(24);

const env = Object.assign({}, process.env, {
  NODE_ENV: 'development',
  JUDGE_INTERNAL_TOKEN: TOKEN,
  JUDGE_PORT: String(PORT),
  JUDGE_HOST: '127.0.0.1',
});

const child = spawn(process.execPath, [path.join(ROOT, 'judge-service/src/server.js')], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => {
  out += d;
});
child.stderr.on('data', (d) => {
  out += d;
});

const hmac = await import(pathToFileURL(path.join(ROOT, 'judge-service/src/auth/hmac.ts')).href);

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/healthz');
      if (r.ok) return true;
    } catch (e) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const ready = await waitReady(20000);
console.log('服务启动：' + (ready ? '成功' : '失败'));
if (!ready) {
  console.log('--- 子进程输出 ---\n' + out);
  child.kill();
  process.exit(1);
}

async function post(pathname, body) {
  const raw = JSON.stringify(body);
  const s = hmac.sign({
    token: TOKEN,
    method: 'POST',
    path: pathname,
    bodyHash: hmac.sha256Hex(raw),
  });
  const res = await fetch('http://127.0.0.1:' + PORT + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-judge-token': TOKEN,
      'x-judge-timestamp': s.material.timestamp,
      'x-judge-nonce': s.material.nonce,
      'x-judge-signature': s.signature,
    },
    body: raw,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* 忽略 */
  }
  return { status: res.status, body: json };
}

const cases = [
  { label: 'Boss 关单选 答对', q: 'q_c_0054', type: 'single-choice', ans: 'B', want: true },
  { label: 'Boss 关单选 答错', q: 'q_c_0054', type: 'single-choice', ans: 'A', want: false },
  { label: 'Boss 关程序输出 答对', q: 'q_c_0050', type: 'program-output', ans: '15\n2\n-2', want: true },
  { label: 'Boss 关程序输出 答对（q_c_0053）', q: 'q_c_0053', type: 'program-output', ans: '3\n4\n7\n6', want: true },
  { label: 'Boss 关程序输出 答错（q_c_0053）', q: 'q_c_0053', type: 'program-output', ans: '3\n4\n7\n7', want: false },
];

let allOk = true;
for (const c of cases) {
  const r = await post('/judge/objective', {
    submissionId: 'smoke-' + Math.random().toString(36).slice(2),
    questionId: c.q,
    type: c.type,
    answer: c.ans,
  });
  const got = r.body && r.body.result && r.body.result.correct;
  const ok = r.status === 200 && got === c.want;
  if (!ok) allOk = false;
  const jsonText = JSON.stringify(r.body);
  const leaked = jsonText.indexOf('正确答案') >= 0;
  console.log(
    '  ' + (ok ? '✓' : '✗') + ' ' + c.label + ' → HTTP ' + r.status + ', correct=' + got +
      (leaked ? '   ⚠️ 疑似泄漏答案' : '')
  );
}

{
  const r = await post('/judge', {
    payload: {
      submissionId: 'smoke-c1',
      questionId: 'q_c_0005',
      type: 'code-editor',
      language: 'c',
      code: 'int main(){return 0;}',
    },
  });
  const ok = r.status !== 500 && r.status !== 404;
  console.log('  ' + (ok ? '✓' : '✗') + ' 编程题端点可用 → HTTP ' + r.status);
}

{
  const r = await fetch('http://127.0.0.1:' + PORT + '/readyz');
  console.log('  ' + (r.ok ? '✓' : '✗') + ' /readyz → HTTP ' + r.status);
}

child.kill();
console.log(allOk ? '\n端到端冒烟全部通过。' : '\n端到端冒烟有失败项。');
process.exit(allOk ? 0 : 1);
