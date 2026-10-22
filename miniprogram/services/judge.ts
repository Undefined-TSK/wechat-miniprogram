/**
 * 判分调度
 *
 * 分工：
 *  - L1 确定性判分 → 练习关/复习关本地判分；Boss/挑战关走**服务端判分接口**
 *  - L2 编译判分（编程题）→ 自建判题服务（Docker 沙箱 + 12 项加固）
 *  - L3 AI 判分（主观题）→ AI 网关（Phase 5）
 *
 * 关键约束：本文件是唯一调用判分器的入口。
 * 渲染器与页面都不允许自行判分，否则「服务端判分」的场次会被前端绕过。
 *
 * ── 本版新增（题库扩充）──────────────────────────────────────
 * 新增「服务端确定性判分」路径（`/judge/objective`），解决一个真实缺陷：
 *
 *   过去只有编程题（sandbox）有服务端判分入口，而 Boss 关不下发 localJudgeKey。
 *   于是 Boss 关里的选择/填空/程序输出题 **用户答对也被判 0 分**，
 *   还被提示「题目配置异常，请反馈给运营」。这是架构缺口，不是配置错误。
 *
 *   现在三类场次各有正确归属：
 *     ① 练习 / 复习关       → 本地判分（下发 localJudgeKey），即时反馈、零延迟
 *     ② Boss / 挑战关       → 服务端确定性判分（不下发任何判分依据）
 *     ③ 编程题（任何关卡）  → 服务端沙箱判分
 *
 *   ⚠️ 为什么 Boss 关不能复用练习关的本地判分：
 *      localJudgeKey 在数学上等价于答案（见 engine/types.ts 的取舍说明）。
 *      Boss 关是「限时综合考」，属于需防作弊的场次，判分依据必须在服务端。
 */

import { getJudge } from '../engine/registry';
import { registerBuiltinJudges } from '../engine/judges/index';
import type { ClientQuestion, JudgeResult } from '../engine/types';
import { toJudgeResult, type JudgeLanguage, type JudgeRequest, type ObjectiveJudgeRequest } from './judge-contract';
import { submitToJudge, submitObjectiveToJudge, canRetryError } from './judge-client';

registerBuiltinJudges();

/** 走远程判分的策略白名单 */
const REMOTE_STRATEGIES: string[] = ['sandbox', 'ai'];

/**
 * 「服务端可确定性判分」的策略。
 *
 * ⚠️ 必须与 `judge-service` 侧实现保持一致（服务端也要有一份同样的白名单）：
 *    服务端不知道题目题型，它收到的是 questionId + 作答，
 *    由服务端自己从题库取出 `answer` + `judge.strategy` 再判。
 *    这正是「答案不下发」所要求的形态 —— 判分依据全程不出服务端。
 */
const SERVER_SIDE_OBJECTIVE: string[] = ['exact', 'set', 'normalize', 'output', 'numeric'];

/** 该题型是否必须走判题服务（沙箱 / AI） */
export function requiresRemoteJudge(q: ClientQuestion): boolean {
  return REMOTE_STRATEGIES.indexOf(judgeStrategyOf(q)) >= 0;
}

/**
 * 该题在「无本地判分依据」的关卡里，是否可由服务端确定性判分。
 *
 * 这个函数的价值是**把「这是配置错误」和「这是正常服务端判分」分开**：
 *   - 返回 true  → 走 /judge/objective，用户正常作答可得正确反馈
 *   - 返回 false → 真正无法判分（题型不在服务端白名单），才报配置异常
 *
 * 早期版本没有这个区分，导致所有非练习关的客观题都被报成「题目配置异常」。
 */
export function canJudgeServerSide(q: ClientQuestion): boolean {
  return SERVER_SIDE_OBJECTIVE.indexOf(judgeStrategyOf(q)) >= 0;
}

/**
 * 从题目推断判分策略。
 *
 * ⚠️ 客户端拿不到 `judge.strategy`（已剔除），所以只能按题型映射。
 *    映射表放在这里而不是散在页面里，且**这张表必须与 bootstrap.ts 的
 *    renderer.judgeStrategies 保持一致**——wiring 自检会核对。
 */
const TYPE_STRATEGY: Record<string, string> = {
  'single-choice': 'exact',
  'multi-choice': 'set',
  'fill-blank': 'normalize',
  'program-output': 'output',
  'code-editor': 'sandbox',
  'short-answer': 'ai',
};

export function judgeStrategyOf(q: ClientQuestion): string {
  return TYPE_STRATEGY[q.type] || 'unknown';
}

/** 任务 8/9 类题型使用的语言（题目数据驱动，默认 c） */
function languageOf(q: ClientQuestion): JudgeLanguage {
  const lang = q.payload && (q.payload as Record<string, unknown>).language;
  if (lang === 'cpp' || lang === 'python' || lang === 'c') return lang;
  return 'c';
}

export async function judgeAnswer(
  q: ClientQuestion,
  userAnswer: unknown,
  ctx?: { submissionId?: string }
): Promise<JudgeResult> {
  const local = q.localJudgeKey;

  // ① 本地判分路径（练习关）
  if (local) {
    const fn = getJudge(local.strategy);
    if (!fn) {
      return localError('判分器未注册: ' + local.strategy, local.strategy);
    }
    return fn(userAnswer, local.key, local.options);
  }

  // ② 远程判分路径
  return judgeRemote(q, userAnswer, ctx);
}

async function judgeRemote(
  q: ClientQuestion,
  userAnswer: unknown,
  ctx?: { submissionId?: string }
): Promise<JudgeResult> {
  const strategy = judgeStrategyOf(q);

  // 编程题：真正调判题服务
  if (strategy === 'sandbox') {
    if (typeof userAnswer !== 'string' || userAnswer.trim() === '') {
      return remoteError('提交的代码为空', strategy);
    }

    const req: JudgeRequest = {
      submissionId: ctx && ctx.submissionId ? ctx.submissionId : buildSubmissionId(q.id),
      questionId: q.id,
      type: q.type,
      language: languageOf(q),
      code: userAnswer,
    };

    const res = await submitToJudge(req);

    if (!res.ok || !res.response) {
      const code = (res.error && res.error.code) || 'internal';
      const message = (res.error && res.error.message) || '判题失败';
      const retry = canRetryError(code);
      return {
        correct: false,
        partial: false,
        score: 0,
        // 明确告知「这不是你做错了」——否则用户会误以为答案错
        detail: (retry ? '判题服务繁忙：' : '判题失败：') + message,
        layer: 'remote',
        strategy: strategy,
      };
    }

    return toJudgeResult(res.response, {
      runMs: undefined,
      memoryMB: undefined,
    });
  }

  // AI 主观题：Phase 5 接入
  if (strategy === 'ai') {
    return remoteError('主观题 AI 批改尚未接入（Phase 5）', strategy, '本次不计分');
  }

  /* ② 客观题落在非练习关（Boss / 挑战关）→ 服务端确定性判分
   *
   * 这里曾经直接报「题目配置异常」。那个判断是错的：
   * Boss 关的选择/填空/程序输出题不是配置错误，而是**本来就应该服务端判分**——
   * 只是早期服务端还没有这条入口。
   *
   * 现在把「作答」送到服务端，由服务端用自己的题库数据判分。
   * 客户端全程拿不到判分依据（连 strategy 都拿不到，是靠题型映射推出来的）。
   */
  if (canJudgeServerSide(q)) {
    return submitObjective(q, userAnswer, strategy, ctx);
  }

  // ③ 真正无法判分：题型不在服务端客观题白名单里（例如新题型忘了接判分器）
  return {
    correct: false,
    partial: false,
    score: 0,
    detail:
      '题目配置异常：该题型（' + q.type + '）没有可用的判分入口（本地与服务端都没有）。' +
      '请反馈给运营——这不是你的问题，本次不计分。',
    layer: 'remote',
    strategy: strategy,
  };
}

/**
 * 客观题的服务端判分。
 *
 * 与编程题的区别：
 *   编程题送的是**代码**，服务端跑沙箱；
 *   客观题送的是**作答**，服务端拿题库里的答案直接比对（不需要沙箱）。
 *
 * 两者共用同一条 HTTP 通道与鉴权，但走不同的端点，
 * 因为它们的资源约束完全不同：沙箱要排队、要限流，而客观题比对是纯 CPU 的微秒级操作。
 * 混在一个端点里会让沙箱的并发闸门把客观题也一起挡住。
 */
async function submitObjective(
  q: ClientQuestion,
  userAnswer: unknown,
  strategy: string,
  ctx?: { submissionId?: string }
): Promise<JudgeResult> {
  const req: ObjectiveJudgeRequest = {
    submissionId: ctx && ctx.submissionId ? ctx.submissionId : buildSubmissionId(q.id),
    questionId: q.id,
    type: q.type,
    answer: userAnswer,
  };

  let res: { ok: boolean; result?: JudgeResult; error?: { code: string; message: string } };
  try {
    res = await submitObjectiveToJudge(req);
  } catch (e) {
    // 网络层异常也不能让用户看到「你答错了」
    return {
      correct: false,
      partial: false,
      score: 0,
      detail: '判题服务不可用：' + (e instanceof Error ? e.message : String(e)),
      layer: 'remote',
      strategy: strategy,
    };
  }

  if (!res.ok || !res.result) {
    const code = (res.error && res.error.code) || 'internal';
    const message = (res.error && res.error.message) || '判分失败';
    const retry = canRetryError(code);
    return {
      correct: false,
      partial: false,
      score: 0,
      detail: (retry ? '判题服务繁忙：' : '判分失败：') + message,
      layer: 'remote',
      strategy: strategy,
    };
  }

  return res.result;
}

function buildSubmissionId(questionId: string): string {
  // 幂等键：同一题同一秒内重复提交视为同一次（防双击重复判题）
  return questionId + '-' + Date.now().toString(36);
}

function localError(detail: string, strategy: string): JudgeResult {
  return { correct: false, partial: false, score: 0, detail: detail, layer: 'local', strategy: strategy };
}

function remoteError(detail: string, strategy: string, prefix?: string): JudgeResult {
  return {
    correct: false,
    partial: false,
    score: 0,
    detail: prefix ? prefix + '：' + detail : detail,
    layer: 'remote',
    strategy: strategy,
  };
}
