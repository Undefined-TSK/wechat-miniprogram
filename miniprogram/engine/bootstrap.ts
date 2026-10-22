/**
 * 题型引擎 · 启动引导
 * app.onLaunch 调用一次，完成判分器与渲染器注册。
 */

import { registerBuiltinJudges } from './judges/index';
import { listRenderers, registerRenderer, type RendererMeta } from './registry';

/**
 * 渲染器注册表。
 *
 * ⚠️ `type` 必须与组件 tag 同名，因为小程序不支持动态组件标签，
 *    引擎容器用 wx:if 链按 type 分发（见 components/question/index.wxml）。
 *    改 tag 名时必须同步改这里的 type，否则题目会静默不渲染。
 *
 * ⚠️ approxBytes 超过 300KB 时必须填入 subpackage 并走分包异步化，
 *    不允许把大渲染器塞进主包（主包内控 1.5MB）。
 */
const RENDERERS: RendererMeta[] = [
  {
    type: 'single-choice',
    label: '单项选择',
    componentPath: '/components/question/renderers/single-choice/index',
    judgeStrategies: ['exact'],
    approxBytes: 6000,
  },
  {
    type: 'multi-choice',
    label: '多项选择',
    componentPath: '/components/question/renderers/multi-choice/index',
    judgeStrategies: ['set'],
    approxBytes: 6500,
  },
  {
    type: 'fill-blank',
    label: '填空',
    componentPath: '/components/question/renderers/fill-blank/index',
    judgeStrategies: ['normalize', 'numeric', 'exact'],
    approxBytes: 7000,
  },
  {
    type: 'program-output',
    label: '程序阅读与输出',
    componentPath: '/components/question/renderers/program-output/index',
    judgeStrategies: ['output'],
    approxBytes: 7000,
  },
  {
    // 编程题：走判题服务（Docker 沙箱 + 12 项加固），不下发任何判分依据
    type: 'code-editor',
    label: '基础编程',
    componentPath: '/components/question/renderers/code-editor/index',
    judgeStrategies: ['sandbox'],
    // 估算体积。⚠️ 将来换成 WebView + CodeMirror 会显著变大，
    //    届时必须填 subpackage 走分包异步化（主包内控 1.5MB）。
    approxBytes: 9000,
  },
];

let booted = false;

export function bootstrapEngine(): void {
  if (booted) return;
  booted = true;
  registerBuiltinJudges();
  for (let i = 0; i < RENDERERS.length; i++) {
    registerRenderer(RENDERERS[i]);
  }
}

/** 主包体积看板：给出渲染器总体积与超限提醒 */
export function rendererSizeReport(): { totalBytes: number; oversize: RendererMeta[] } {
  const all = listRenderers();
  let totalBytes = 0;
  const oversize: RendererMeta[] = [];
  for (let i = 0; i < all.length; i++) {
    const bytes = all[i].approxBytes || 0;
    totalBytes += bytes;
    if (bytes > 300 * 1024 && !all[i].subpackage) oversize.push(all[i]);
  }
  return { totalBytes: totalBytes, oversize: oversize };
}
