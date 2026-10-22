/**
 * 题型引擎 · 统一出口
 *
 * 新增题型只需两步：
 *   1. engine/judges/ 下新增判分器并在 judges/index.ts 注册
 *   2. components/question/renderers/ 下新增渲染器组件并在 bootstrap.ts 注册
 * 页面代码一行都不用改。
 */

export * from './types';
export * from './registry';
export * from './sanitize';
export * from './machine';
export * from './session';
export * from './answer';
export * from './bootstrap';
export { registerBuiltinJudges } from './judges/index';
