/**
 * 判题服务 · 生产运行时入口（薄垫片）。
 *
 * 这个文件为什么存在、且为什么**只有几十行**：
 *
 *   - 真正的实现全在 `server.ts`（含完整 TS 类型）。Node 22 的类型剥离
 *     能让 `.ts` 被直接执行，所以不需要任何构建步骤 —— 与项目
 *     「零依赖、无构建」的纪律一致。
 *   - 但 Dockerfile / package.json 的入口必须是一个**确定存在、内容稳定**
 *     的文件名。留一个薄垫片当「恒定入口」，改动点就收在一处。
 *   - 垫片还负责两件事：(1) 注册**后缀补全解析器**；
 *     (2) **透传 server.ts 的全部导出**，让 `import('server.js')` 与
 *     `import('server.ts')` 拿到完全一样的模块形状。
 *
 * 历史坑（务必不要回退）：
 *   早期 `server.js` 是 `server.ts` 的逐字节副本，里面带着 `export type`、
 *   `: JudgeErrorCode` 这类 TS 语法。Node 的类型剥离**只对 .ts/.mts/.tsx 生效**，
 *   对 `.js` 完全不生效 —— 于是 `node src/server.js` 直接 `SyntaxError`，
 *   生产根本起不来。更糟的是自检全都 `import('server.ts')`，从没验证过
 *   `.js` 本身能不能跑，1199 项全绿却盖不住这个洞。
 *   现在的约定：**`server.ts` 是唯一真源，`server.js` 是薄垫片**，
 *   并由自检实跑 `node src/server.js` 来保证入口真的能起。
 *
 * 为什么用动态 import + 逐名重导出，而不是静态 `export * from './server.ts'`：
 *   静态导出会在**模块加载期**就解析 `./server.ts` 的依赖树，而此时
 *   `register()` 注册的解析钩子还没有机会介入 —— 表现为
 *   「Directory import './auth' is not supported」。
 *   动态 import 发生在钩子注册之后，才能正常工作。
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

/** 与 tests/ts-resolver.mjs 保持同源：候选后缀按顺序尝试 */
const RESOLVER_SOURCE = `
const EXT_CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (!isRelative) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    for (const ext of EXT_CANDIDATES) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch (inner) {
        // 继续尝试下一个候选
      }
    }
    throw err;
  }
}
`;

register(
  'data:text/javascript;base64,' + Buffer.from(RESOLVER_SOURCE, 'utf8').toString('base64'),
  pathToFileURL(import.meta.url)
);

const target = await import('./server.ts');

// ⚠️ 逐名重导出。`export * from` 在这里用不了（见文件头说明），
//    所以由自检断言「server.js 与 server.ts 的导出名集合完全相同」，
//    避免以后 server.ts 新增导出却忘了在这里透传。
export const ERROR_STATUS = target.ERROR_STATUS;
export const TRANSPORT_STATUS = target.TRANSPORT_STATUS;
export const ROUTES = target.ROUTES;
export const precheckStatus = target.precheckStatus;
export const createHttpServer = target.createHttpServer;
export const BodyTooLargeError = target.BodyTooLargeError;
export const readBody = target.readBody;
export const userIdOf = target.userIdOf;
export const main = target.main;
export const timingSafeEqualHex = target.timingSafeEqualHex;
export const MAX_CODE_BYTES = target.MAX_CODE_BYTES;
