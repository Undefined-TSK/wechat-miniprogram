/**
 * 题型引擎 · 答题状态机
 *
 *   IDLE → LOADING → ANSWERING → SUBMITTING → FEEDBACK → ANSWERING/…
 *                                        ↘ FINISHED
 *   任意环节出错 → ERROR（可回到 LOADING 或 ANSWERING）
 *
 * 用显式转移表而不是散落的 if，保证不会出现「已提交还能再提交」这类并发脏状态。
 */

export type Phase =
  | 'idle'
  | 'loading'
  | 'answering'
  | 'submitting'
  | 'feedback'
  | 'finished'
  | 'error';

const TRANSITIONS: Record<Phase, Phase[]> = {
  idle: ['loading'],
  loading: ['answering', 'error'],
  answering: ['submitting', 'finished'],
  submitting: ['feedback', 'error'],
  feedback: ['answering', 'finished'],
  finished: [],
  error: ['loading', 'answering'],
};

export class AnswerMachine {
  phase: Phase = 'idle';

  can(next: Phase): boolean {
    return TRANSITIONS[this.phase].indexOf(next) >= 0;
  }

  /** 非法转移直接抛错，避免脏状态静默蔓延 */
  to(next: Phase): Phase {
    if (!this.can(next)) {
      throw new Error('[engine] 非法状态转移: ' + this.phase + ' -> ' + next);
    }
    this.phase = next;
    return this.phase;
  }

  is(p: Phase): boolean {
    return this.phase === p;
  }

  reset(): void {
    this.phase = 'idle';
  }
}

export function allowedTransitions(phase: Phase): Phase[] {
  return TRANSITIONS[phase].slice();
}
