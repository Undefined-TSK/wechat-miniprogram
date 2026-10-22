/**
 * 题型引擎 · 取题字段剔除（答案不下发原则的唯一执行点）
 *
 * 三条铁律：
 *  1. `answer` 与 `judge` 字段永远不出现在下发给客户端的数据里。
 *  2. `localJudgeKey` 只在「普通练习关」+「L1 确定性策略」时下发。
 *  3. 每次剔除后调用 assertNoAnswerLeak 兜底断言——宁可报错，不可漏答案。
 *
 * 生产环境该逻辑必须跑在云函数侧（cloudfunctions/getLevelQuestions）。
 * 客户端这份实现是同一套规则，用于本地开发与兜底自检。
 */

import type {
  ClientQuestion,
  FullQuestion,
  LocalJudgeKey,
  LocalJudgeStrategy,
} from './types';
import { isLocalJudgeStrategy } from './types';

export interface SanitizeOptions {
  /** 仅普通练习关为 true。Boss 关/挑战关/PK/模拟考必须为 false */
  allowLocalJudgeKey: boolean;
}

/** 禁止出现在下发数据中的字段名 */
const FORBIDDEN_FIELDS: string[] = ['answer', 'judge', 'source', 'status'];

export function sanitizeQuestion(q: FullQuestion, opts: SanitizeOptions): ClientQuestion {
  const client: ClientQuestion = {
    id: q.id,
    subject: q.subject,
    chapterId: q.chapterId,
    kpIds: q.kpIds.slice(),
    type: q.type,
    difficulty: q.difficulty,
    payload: q.payload,
  };

  const localizable = opts.allowLocalJudgeKey && isLocalJudgeStrategy(q.judge.strategy);

  if (localizable) {
    // 练习关：下发解析（本地判分后需要即时展示），并下发最小判分依据
    client.analysis = q.analysis;
    client.localJudgeKey = buildLocalJudgeKey(q, q.judge.strategy as LocalJudgeStrategy);
  }

  assertNoAnswerLeak(client);
  return client;
}

export function buildLocalJudgeKey(q: FullQuestion, strategy: LocalJudgeStrategy): LocalJudgeKey {
  return {
    strategy: strategy,
    key: q.answer,
    options: q.judge.options,
  };
}

/**
 * 兜底断言：任何答案类字段泄漏都直接抛错。
 * 云函数、客户端、测试三处都应调用它。
 */
export function assertNoAnswerLeak(question: Record<string, unknown>): void {
  for (let i = 0; i < FORBIDDEN_FIELDS.length; i++) {
    const field = FORBIDDEN_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(question, field)) {
      throw new Error(
        '[engine] 答案泄漏拦截：下发数据中不允许出现字段 `' + field + '`（题目 ' + String(question.id) + '）'
      );
    }
  }
  const json = JSON.stringify(question);
  if (json.indexOf('"answer"') >= 0) {
    throw new Error('[engine] 答案泄漏拦截：序列化结果中出现 "answer" 字段');
  }
}
