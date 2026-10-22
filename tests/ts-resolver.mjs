/**
 * Node 模块解析钩子。
 *
 * 作用：让 Node 能直接跑小程序里的 .ts 源码（源码用的是无扩展名相对导入，
 * 符合微信开发者工具的 TS 编译习惯；而 Node 的类型剥离要求显式扩展名）。
 *
 * 只在测试环境使用，不进小程序包。
 */

const EXT_CANDIDATES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');

  if (!isRelative) {
    return nextResolve(specifier, context);
  }

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
