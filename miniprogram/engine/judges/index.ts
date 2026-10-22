/**
 * 判分器汇总注册
 *
 * 新增一个判分器只需在这里加一行 registerJudge。
 *
 * ⚠️ 两类判分器不要混：
 *  - **本地可执行**（exact / set / normalize / numeric / output）：练习关用，判分依据随题下发
 *  - **服务端策略**（sandbox / ai）：注册的只是占位实现，真正判分在服务端。
 *    它们之所以也要注册，是为了让「渲染器声明的 judgeStrategy 必须存在」这条
 *    自检规则保持简单（详见 sandbox.ts 顶部说明）。
 */

import { hasJudge, registerJudge } from '../registry';
import { judgeExact } from './exact';
import { judgeSet } from './set';
import { judgeNormalize } from './normalize';
import { judgeNumeric } from './numeric';
import { judgeOutput } from './output';
import { judgeSandbox } from './sandbox';
import { judgeAi } from './ai';

let done = false;

export function registerBuiltinJudges(): void {
  if (done) return;
  done = true;

  const builtins: Array<[string, typeof judgeExact]> = [
    ['exact', judgeExact],
    ['set', judgeSet],
    ['normalize', judgeNormalize],
    ['numeric', judgeNumeric],
    ['output', judgeOutput],
    // 服务端策略占位（永不本地判分）
    ['sandbox', judgeSandbox],
    ['ai', judgeAi],
  ];

  for (let i = 0; i < builtins.length; i++) {
    const name = builtins[i][0];
    const fn = builtins[i][1];
    if (!hasJudge(name)) registerJudge(name, fn);
  }
}

export { judgeExact, judgeSet, judgeNormalize, judgeNumeric, judgeOutput, judgeSandbox, judgeAi };
