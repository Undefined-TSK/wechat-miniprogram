/**
 * 取题服务
 *
 * 生产实现：
 *   const res = await wx.cloud.callFunction({ name: 'getLevelQuestions', data: { levelId } })
 *   云函数内完成 sanitizeQuestion + assertNoAnswerLeak 后再返回。
 *
 * 本文件是同一套规则在客户端的一份实现，用于本地开发联调；
 * 无论走哪条路径，assertNoAnswerLeak 都是最后一道闸——宁可报错，不可漏答案。
 */

import type { ClientQuestion, LevelDef } from '../engine/types';
import { sanitizeQuestion } from '../engine/sanitize';
import { findLevel, findQuestion } from '../mock/bank';

export interface LevelBundle {
  level: LevelDef;
  questions: ClientQuestion[];
}

function delay(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * 是否允许下发本地判分依据。
 * 只有普通练习关允许——练习关不计入排行榜、不参与 PK、不作为段位依据。
 */
export function allowLocalJudge(level: LevelDef): boolean {
  return level.mode === 'practice' || level.mode === 'review';
}

export async function fetchLevelQuestions(levelId: string): Promise<LevelBundle> {
  const level = findLevel(levelId);
  if (!level) throw new Error('关卡不存在: ' + levelId);

  // 模拟网络往返
  await delay(120);

  const allowLocal = allowLocalJudge(level);
  const questions: ClientQuestion[] = [];

  for (let i = 0; i < level.questionIds.length; i++) {
    const full = findQuestion(level.questionIds[i]);
    if (!full) throw new Error('题目不存在: ' + level.questionIds[i]);
    questions.push(sanitizeQuestion(full, { allowLocalJudgeKey: allowLocal }));
  }

  return { level: level, questions: questions };
}

/**
 * 按题目 id 列表取题（错题本重做用）。
 *
 * ⚠️ 为什么合成一个「虚拟关卡」而不是直接返回题目数组：
 *    答题页的一切都建立在 LevelSession 之上，而 LevelSession 需要一个 LevelDef。
 *    与其在页面里到处判空「这是不是错题本模式」，不如在这里统一成一个关卡对象，
 *    答题页零改动就能跑错题重做。
 *
 * 三个刻意的设定：
 *   1. `mode: 'review'` —— 复习关，**允许本地判分**（不计榜、不作段位依据）。
 *   2. 星级阈值放宽到 `[0.5, 0.8, 1.0]` —— 重做题都是曾经错过的，
 *      门槛与首次学习一致会让人反复卡在同一关，反而打击信心。
 *   3. **静默跳过找不到的题**（题库改版题被下架），不让一道陈年错题把整个错题本卡死。
 */
export async function fetchQuestionsByIds(
  ids: string[],
  virtualLevelId: string,
  name: string
): Promise<LevelBundle> {
  await delay(80);

  const questions: ClientQuestion[] = [];
  for (let i = 0; i < ids.length; i++) {
    const full = findQuestion(ids[i]);
    if (!full) continue; // 题目已下架：跳过，不抛错
    questions.push(sanitizeQuestion(full, { allowLocalJudgeKey: true }));
  }

  const level: LevelDef = {
    id: virtualLevelId,
    chapterId: questions.length > 0 ? questions[0].chapterId : '',
    name: name,
    mode: 'review',
    questionIds: questions.map(function (q) { return q.id; }),
    starThresholds: [0.5, 0.8, 1.0],
  };

  return { level: level, questions: questions };
}
