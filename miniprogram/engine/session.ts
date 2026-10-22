/**
 * 题型引擎 · 关卡会话
 *
 * 职责：持有「非渲染数据」——题目列表、游标、Combo、计时、作答记录。
 * 页面只通过 view() 取到「最小 setData 载荷」，绝不整包 setData。
 *
 * 纪律：本类不持有任何答案（ClientQuestion 里没有 answer 字段），
 *       判分由 services/judge 完成后把 JudgeResult 交进来。
 */

import type { ClientQuestion, JudgeResult, LevelDef, LevelMode } from './types';
import { AnswerMachine } from './machine';

/** Combo 倍率阶梯：达到 min 连对即启用对应倍率 */
export const COMBO_LADDER: Array<{ min: number; multiplier: number }> = [
  { min: 0, multiplier: 1 },
  { min: 2, multiplier: 1.2 },
  { min: 4, multiplier: 1.5 },
  { min: 6, multiplier: 2 },
];

export function comboMultiplier(combo: number): number {
  let m = 1;
  for (let i = 0; i < COMBO_LADDER.length; i++) {
    if (combo >= COMBO_LADDER[i].min) m = COMBO_LADDER[i].multiplier;
  }
  return m;
}

export interface AnswerRecord {
  questionId: string;
  type: string;
  answer: unknown;
  result: JudgeResult;
  costMs: number;
  comboAfter: number;
}

/** 最小 setData 载荷：只有原始类型与小数组 */
export interface SessionView {
  index: number;
  humanIndex: number;
  total: number;
  progressPercent: number;
  combo: number;
  comboMultiplier: number;
  elapsedMs: number;
  answeredCount: number;
  correctCount: number;
  isLast: boolean;
}

export interface SessionSummary {
  levelId: string;
  mode: LevelMode;
  total: number;
  answeredCount: number;
  correctCount: number;
  partialCount: number;
  /** 正确率：完全正确的题数 / 总题数 */
  correctRate: number;
  /** 得分率：Σscore / 总题数（用于星级） */
  scoreRate: number;
  costMs: number;
  avgCostMs: number;
  maxCombo: number;
  stars: number;
  xp: number;
  wrongQuestionIds: string[];
  records: AnswerRecord[];
}

const DEFAULT_STAR_THRESHOLDS: [number, number, number] = [0.6, 0.8, 1.0];

export class LevelSession {
  levelId: string;
  mode: LevelMode;
  starThresholds: [number, number, number];
  machine: AnswerMachine = new AnswerMachine();

  questions: ClientQuestion[] = [];
  records: AnswerRecord[] = [];
  cursor = 0;
  combo = 0;
  maxCombo = 0;
  startedAt = 0;
  endedAt = 0;

  constructor(level: LevelDef, questions: ClientQuestion[]) {
    this.levelId = level.id;
    this.mode = level.mode;
    this.starThresholds = level.starThresholds || DEFAULT_STAR_THRESHOLDS;
    this.questions = questions.slice();
  }

  get total(): number {
    return this.questions.length;
  }

  get index(): number {
    return this.cursor;
  }

  get current(): ClientQuestion | null {
    return this.cursor < this.questions.length ? this.questions[this.cursor] : null;
  }

  /** idle → loading */
  beginLoad(): void {
    if (this.machine.is('idle')) this.machine.to('loading');
  }

  /** loading → answering（题目就绪） */
  ready(now?: number): void {
    if (this.machine.is('loading')) this.machine.to('answering');
    this.startedAt = typeof now === 'number' ? now : Date.now();
  }

  view(now?: number): SessionView {
    const t = typeof now === 'number' ? now : Date.now();
    const answered = this.records.length;
    let correct = 0;
    for (let i = 0; i < this.records.length; i++) {
      if (this.records[i].result.correct) correct++;
    }
    return {
      index: this.cursor,
      humanIndex: Math.min(this.cursor + 1, Math.max(this.total, 1)),
      total: this.total,
      progressPercent: this.total === 0 ? 0 : Math.round((this.cursor / this.total) * 100),
      combo: this.combo,
      comboMultiplier: comboMultiplier(this.combo),
      elapsedMs: this.startedAt === 0 ? 0 : t - this.startedAt,
      answeredCount: answered,
      correctCount: correct,
      isLast: this.cursor >= this.total - 1,
    };
  }

  /**
   * 记录一次作答。
   * answering → submitting → feedback
   */
  submit(userAnswer: unknown, result: JudgeResult, costMs: number): AnswerRecord {
    const q = this.current;
    if (!q) throw new Error('[engine] 已无当前题目，不能提交');
    if (!this.machine.is('answering')) {
      throw new Error('[engine] 当前状态 ' + this.machine.phase + ' 不允许提交');
    }

    this.machine.to('submitting');

    if (result.correct) {
      this.combo += 1;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    } else {
      this.combo = 0;
    }

    const record: AnswerRecord = {
      questionId: q.id,
      type: q.type,
      answer: userAnswer,
      result: result,
      costMs: costMs,
      comboAfter: this.combo,
    };
    this.records.push(record);
    this.machine.to('feedback');
    return record;
  }

  /** feedback → answering（还有题）/ finished */
  next(): boolean {
    if (!this.machine.is('feedback')) {
      throw new Error('[engine] 当前状态 ' + this.machine.phase + ' 不允许进入下一题');
    }
    if (this.cursor >= this.questions.length - 1) {
      this.machine.to('finished');
      this.endedAt = Date.now();
      return false;
    }
    this.cursor += 1;
    this.machine.to('answering');
    return true;
  }

  summary(): SessionSummary {
    const total = this.questions.length;
    const answered = this.records.length;
    let correctCount = 0;
    let partialCount = 0;
    let scoreSum = 0;
    let costSum = 0;
    const wrongIds: string[] = [];

    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (r.result.correct) correctCount++;
      else {
        wrongIds.push(r.questionId);
        if (r.result.partial) partialCount++;
      }
      scoreSum += r.result.score;
      costSum += r.costMs;
    }

    const scoreRate = total === 0 ? 0 : scoreSum / total;
    const wholeScore = Math.pow(10, 6);
    const rate = Math.round(scoreRate * wholeScore) / wholeScore;
    const stars = this.calcStars(rate);
    const xp = correctCount * 10 + stars * 20 + this.maxCombo * 2;

    return {
      levelId: this.levelId,
      mode: this.mode,
      total: total,
      answeredCount: answered,
      correctCount: correctCount,
      partialCount: partialCount,
      correctRate: total === 0 ? 0 : Math.round((correctCount / total) * 1000) / 1000,
      scoreRate: rate,
      costMs: this.endedAt > 0 && this.startedAt > 0 ? this.endedAt - this.startedAt : costSum,
      avgCostMs: answered === 0 ? 0 : Math.round(costSum / answered),
      maxCombo: this.maxCombo,
      stars: stars,
      xp: xp,
      wrongQuestionIds: wrongIds,
      records: this.records,
    };
  }

  calcStars(scoreRate: number): number {
    const t = this.starThresholds;
    if (scoreRate >= t[2] - 1e-9) return 3;
    if (scoreRate >= t[1] - 1e-9) return 2;
    if (scoreRate >= t[0] - 1e-9) return 1;
    return 0;
  }
}
