/**
 * 题型引擎 · 注册表
 *
 * 两个注册表：
 *  - 判分器注册表：strategy → 判分函数（引擎调用的唯一入口）
 *  - 渲染器注册表：type → 组件元信息（用于校验、体积统计、分包映射）
 *
 * 新增题型时不需要改本文件，只需在各自的模块里调用 registerJudge / registerRenderer。
 * 本文件刻意不 import 任何判分器，避免循环依赖。
 */

import type { JudgeResult, JudgeStrategy } from './types';

export type JudgeFn = (
  userAnswer: unknown,
  judgeKey: unknown,
  options?: Record<string, unknown>
) => JudgeResult;

export interface RendererMeta {
  /** 必须与组件 tag 同名，例如 'single-choice' */
  type: string;
  label: string;
  /** 组件路径（相对 miniprogram 根） */
  componentPath: string;
  /** 该题型可能使用的判分策略 */
  judgeStrategies: JudgeStrategy[];
  /** 超过 300KB 时必须指定分包，走分包异步化按需加载 */
  subpackage?: string;
  /** 组件估算体积（字节），用于主包体积看板 */
  approxBytes?: number;
}

const judgeRegistry = new Map<string, JudgeFn>();
const rendererRegistry = new Map<string, RendererMeta>();

export function registerJudge(strategy: string, fn: JudgeFn): void {
  if (judgeRegistry.has(strategy)) {
    throw new Error('[engine] 判分器重复注册: ' + strategy);
  }
  judgeRegistry.set(strategy, fn);
}

export function getJudge(strategy: string): JudgeFn | undefined {
  return judgeRegistry.get(strategy);
}

export function hasJudge(strategy: string): boolean {
  return judgeRegistry.has(strategy);
}

export function listJudges(): string[] {
  return Array.from(judgeRegistry.keys());
}

export function registerRenderer(meta: RendererMeta): void {
  rendererRegistry.set(meta.type, meta);
}

export function getRenderer(type: string): RendererMeta | undefined {
  return rendererRegistry.get(type);
}

export function listRenderers(): RendererMeta[] {
  return Array.from(rendererRegistry.values());
}

/** 取不到渲染器直接抛错，避免题目静默白屏 */
export function assertRendererRegistered(type: string): RendererMeta {
  const meta = rendererRegistry.get(type);
  if (!meta) throw new Error('[engine] 未注册的题型渲染器: ' + type);
  return meta;
}

/** 清空注册表，仅供测试使用 */
export function _resetRegistry(): void {
  judgeRegistry.clear();
  rendererRegistry.clear();
}
