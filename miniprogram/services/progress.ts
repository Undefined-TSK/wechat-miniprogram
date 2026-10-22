/**
 * 学习进度 · 本地持久化
 *
 * ═══════════════════════════════════════════════════════════════════
 *  为什么先做「本地版」而不是直接接云数据库
 * ═══════════════════════════════════════════════════════════════════
 *
 * 用户现在的目标是「一个人能从头到尾玩一遍」，还没到多人/多端同步阶段。
 * 所以进度直接存本机（`wx.setStorageSync`），**零后端依赖、零成本、离线可用**。
 *
 * 但**数据结构刻意与云数据库对齐**：
 *   - 顶层按 collection 分键（progress / wrongBook / meta）
 *   - 每条记录带 `openid` 占位字段与 `updatedAt` 时间戳
 *   - 写入一律「读-改-写」幂等，不做自增依赖
 *
 * 这样将来接云开发时，**只需要换掉 load/save 两个函数**，
 * 上层页面与业务逻辑一行不用改。这是「入口留好」的具体做法。
 *
 * ⚠️ 为什么不直接写成 Promise 接口：
 *    本机读取是同步的，做成 Promise 只是徒增复杂度；
 *    真正接云数据库时再包一层 async 适配即可（见 ProgressStoreIO 注释）。
 *
 * ⚠️ 本文件不 import 任何 wx API 之外的模块，且 wx 调用全部收在 StorageIO 里 ——
 *    这样纯逻辑（星级合并、错题去重、掌握度）可以在 Node 里跑测试。
 */

import type { SessionSummary } from '../engine/session';
import type { LevelMode } from '../engine/types';

/* ------------------------------------------------------------------ */
/*  数据契约（与云端 collection 字段一一对应）                          */
/* ------------------------------------------------------------------ */

/** 关卡通关记录 */
export interface LevelProgress {
  levelId: string;
  chapterId: string;
  subject: string;
  /** 历史最高星级 0-3（只增不减：重做打得更差别把记录抹掉） */
  bestStars: number;
  /** 历史最高得分率 0-1 */
  bestScoreRate: number;
  /** 历史最短用时（毫秒，仅在同为最高星级时才有比较意义） */
  bestCostMs: number;
  /** 累计挑战次数 */
  attempts: number;
  /** 累计获得经验 */
  xp: number;
  /** 最近一次挑战时间戳 */
  lastPlayedAt: number;
  firstClearedAt: number;
}

/** 错题条目 */
export interface WrongEntry {
  questionId: string;
  chapterId: string;
  kpIds: string[];
  type: string;
  /** 答错次数 */
  wrongCount: number;
  /** 连续答对次数：达到 MASTERY_STREAK 后移出错题本 */
  correctStreak: number;
  /** 首次答错时间 */
  firstWrongAt: number;
  /** 最近答错时间 */
  lastWrongAt: number;
  /** 最近一次得分率（给用户看「进步了多少」） */
  lastScore: number;
  /** 是否正确率回升到「掌握」阈值 */
  mastered: boolean;
}

/** 知识点掌握度（极简版：只统计对错次数，完整算法留到 Phase 5 按配置表实现） */
export interface KpStat {
  kpId: string;
  answered: number;
  correct: number;
}

export interface ProgressSnapshot {
  version: number;
  subject: string;
  levels: Record<string, LevelProgress>;
  wrongBook: Record<string, WrongEntry>;
  kpStats: Record<string, KpStat>;
  totalXp: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/*  可调参数（云端可配的雏形，不硬编码在业务里）                        */
/* ------------------------------------------------------------------ */

export const PROGRESS_CONFIG = {
  /** 错题连续答对几次判定为「已掌握」并移出错题本 */
  masteryStreak: 2,
  /** 关卡解锁：上一关至少几星才能解锁下一关（0 = 通关即可解锁） */
  unlockStarsRequired: 1,
  /** 存储键前缀（将来切云端时用于命名空间隔离） */
  storageKey: 'xxgk:progress:v1',
  /** 数据结构版本，用于将来迁移 */
  schemaVersion: 1,
} as const;

/* ------------------------------------------------------------------ */
/*  纯逻辑（可在 Node 中直接测试，不依赖 wx）                           */
/* ------------------------------------------------------------------ */

/** 空快照 */
export function emptySnapshot(subject: string): ProgressSnapshot {
  return {
    version: PROGRESS_CONFIG.schemaVersion,
    subject: subject,
    levels: {},
    wrongBook: {},
    kpStats: {},
    totalXp: 0,
    updatedAt: 0,
  };
}

/**
 * 合并一次挑战结果到快照。
 *
 * 三条纪律：
 *  1. **只增不减**：重做打得差不能把历史最高星级/得分率覆盖掉（用户会气得骂人）
 *  2. **XP 记账**：每次挑战都加，不取最大值（重复练习本身就是有价值的行为，应鼓励）
 *  3. **幂等**：同一份 summary 合并两次结果一致（除 attempts/xp 累加外），
 *     避免将来云端重试造成脏数据
 */
export function applySummary(
  snapshot: ProgressSnapshot,
  summary: SessionSummary,
  meta: {
    chapterId: string;
    subject: string;
    wrongDetails?: WrongQuestionMeta[];
    /**
     * 这次挑战是否算作「一个关卡」。
     *
     * 错题本是**动态合成的复习局**，不是题库里真实存在的关卡：
     *   - 若照常写关卡记录，个人页的「已通关 X/3 关」会变成 4/3（凭空多一关）
     *   - 而且所有错题重做都共用一个虚拟 id，几组不相干的错题会互相覆盖
     *     attempts / xp，数字毫无意义
     *
     * 所以虚拟复习局：**只更新错题本与知识点统计，不写关卡记录**。
     * 默认 true（正常关卡），只有错题重做传 false。
     */
    countsAsLevel?: boolean;
  }
): ProgressSnapshot {
  const next: ProgressSnapshot = {
    version: snapshot.version,
    subject: snapshot.subject,
    levels: Object.assign({}, snapshot.levels),
    wrongBook: Object.assign({}, snapshot.wrongBook),
    kpStats: Object.assign({}, snapshot.kpStats),
    totalXp: snapshot.totalXp,
    updatedAt: snapshot.updatedAt,
  };

  const now = Date.now();
  const countsAsLevel = meta.countsAsLevel !== false;

  // ── 关卡进度 ──
  if (countsAsLevel) {
    const prev = next.levels[summary.levelId];

    const better = !prev || summary.stars > prev.bestStars ||
      (summary.stars === prev.bestStars && summary.scoreRate > prev.bestScoreRate);

    next.levels[summary.levelId] = {
      levelId: summary.levelId,
      chapterId: meta.chapterId,
      subject: meta.subject,
      // 星级与得分率只增不减
      bestStars: prev ? Math.max(prev.bestStars, summary.stars) : summary.stars,
      bestScoreRate: prev ? Math.max(prev.bestScoreRate, summary.scoreRate) : summary.scoreRate,
      // 用时取「在同一星级下更快的那次」；打得差的那次不参与比较
      bestCostMs: pickBestCost(prev, summary, better),
      attempts: (prev ? prev.attempts : 0) + 1,
      xp: (prev ? prev.xp : 0) + summary.xp,
      lastPlayedAt: now,
      firstClearedAt: prev && prev.firstClearedAt > 0
        ? prev.firstClearedAt
        : summary.stars > 0 ? now : 0,
    };
  }
  next.totalXp += summary.xp;

  // ── 错题本 ──
  //
  // ⚠️ 这里需要题目详情（kpIds / type / chapterId），但 SessionSummary 只有 id。
  //    所以由调用方通过 wrongDetails 传进来。**不在这里去查题库** ——
  //    那会让这个纯函数依赖数据源，Node 里就测不了了。
  const details = meta.wrongDetails || [];
  const detailOf: Record<string, WrongQuestionMeta> = {};
  for (let i = 0; i < details.length; i++) detailOf[details[i].questionId] = details[i];

  // 本次答错的题 → 进错题本或累加次数
  for (let i = 0; i < summary.wrongQuestionIds.length; i++) {
    const qid = summary.wrongQuestionIds[i];
    const d = detailOf[qid];
    const prevW = next.wrongBook[qid];
    next.wrongBook[qid] = {
      questionId: qid,
      chapterId: d ? d.chapterId : (prevW ? prevW.chapterId : meta.chapterId),
      kpIds: d ? d.kpIds : (prevW ? prevW.kpIds : []),
      type: d ? d.type : (prevW ? prevW.type : 'unknown'),
      wrongCount: (prevW ? prevW.wrongCount : 0) + 1,
      // 又答错了 → 连对清零
      correctStreak: 0,
      firstWrongAt: prevW ? prevW.firstWrongAt : now,
      lastWrongAt: now,
      lastScore: lastScoreOf(summary, qid),
      // 答错了当然没掌握
      mastered: false,
    };
  }

  // 本次答对的题 → 若在错题本里，连对 +1；够了就标记掌握
  for (let i = 0; i < summary.records.length; i++) {
    const r = summary.records[i];
    if (!r.result.correct) continue;
    const prevW = next.wrongBook[r.questionId];
    if (!prevW || prevW.mastered) continue;

    const streak = prevW.correctStreak + 1;
    const mastered = streak >= PROGRESS_CONFIG.masteryStreak;
    next.wrongBook[r.questionId] = {
      questionId: prevW.questionId,
      chapterId: prevW.chapterId,
      kpIds: prevW.kpIds,
      type: prevW.type,
      wrongCount: prevW.wrongCount,
      correctStreak: streak,
      firstWrongAt: prevW.firstWrongAt,
      lastWrongAt: prevW.lastWrongAt,
      lastScore: r.result.score,
      mastered: mastered,
    };
  }

  // ── 知识点统计 ──
  for (let i = 0; i < summary.records.length; i++) {
    const r = summary.records[i];
    const d = detailOf[r.questionId];
    if (!d) continue;
    for (let k = 0; k < d.kpIds.length; k++) {
      const kpId = d.kpIds[k];
      const prevK = next.kpStats[kpId] || { kpId: kpId, answered: 0, correct: 0 };
      next.kpStats[kpId] = {
        kpId: kpId,
        answered: prevK.answered + 1,
        correct: prevK.correct + (r.result.correct ? 1 : 0),
      };
    }
  }

  next.updatedAt = now;
  return next;
}

/** 本次某题的得分率（找不到就按 0，宁可少报不虚报） */
function lastScoreOf(summary: SessionSummary, questionId: string): number {
  for (let i = 0; i < summary.records.length; i++) {
    if (summary.records[i].questionId === questionId) return summary.records[i].result.score;
  }
  return 0;
}

/**
 * 用时取舍规则（容易写错，单独拎出来）：
 *   - 首次通关：直接采用
 *   - 本次星级/得分率**更好**：采用本次用时
 *   - 本次打得**一样好或更差**：保留历史最短（不打更差的那次计时）
 *   - 历史无用时：采用本次
 */
function pickBestCost(
  prev: LevelProgress | undefined,
  summary: SessionSummary,
  isBetter: boolean
): number {
  if (!prev || prev.bestCostMs <= 0) return summary.costMs;
  if (isBetter) return summary.costMs;
  return Math.min(prev.bestCostMs, summary.costMs) === prev.bestCostMs
    ? prev.bestCostMs
    : summary.costMs;
}

export interface WrongQuestionMeta {
  questionId: string;
  chapterId: string;
  kpIds: string[];
  type: string;
}

/**
 * 关卡解锁判定（纯函数）。
 *
 * 规则：**第一关永远开放**；其余关卡要求「前一关至少 N 星」。
 * ⚠️ 用「前一个」而不是「任意更早的关卡」——后者会让玩家跳过没学会的内容，
 *    违反「闯关」的设计意图（每个章节的知识点是递进的）。
 */
export function isLevelUnlocked(
  snapshot: ProgressSnapshot,
  orderedLevelIds: string[],
  levelId: string
): boolean {
  const idx = orderedLevelIds.indexOf(levelId);
  if (idx <= 0) return true; // 第一关（或找不到）默认开放
  const prevId = orderedLevelIds[idx - 1];
  const prev = snapshot.levels[prevId];
  if (!prev) return false;
  return prev.bestStars >= PROGRESS_CONFIG.unlockStarsRequired;
}

/** 未掌握的错题（按最近答错时间倒序，最近错的排前面） */
export function activeWrongEntries(snapshot: ProgressSnapshot): WrongEntry[] {
  const out: WrongEntry[] = [];
  const keys = Object.keys(snapshot.wrongBook);
  for (let i = 0; i < keys.length; i++) {
    const e = snapshot.wrongBook[keys[i]];
    if (!e.mastered) out.push(e);
  }
  out.sort(function (a, b) { return b.lastWrongAt - a.lastWrongAt; });
  return out;
}

/** 某章节的完成度（按关卡数量统计，返回 0-1） */
export function chapterCompletion(
  snapshot: ProgressSnapshot,
  levelIds: string[]
): { cleared: number; total: number; stars: number; maxStars: number } {
  let cleared = 0;
  let stars = 0;
  for (let i = 0; i < levelIds.length; i++) {
    const p = snapshot.levels[levelIds[i]];
    if (p && p.bestStars > 0) cleared++;
    stars += p ? p.bestStars : 0;
  }
  return { cleared: cleared, total: levelIds.length, stars: stars, maxStars: levelIds.length * 3 };
}

/* ------------------------------------------------------------------ */
/*  存储 IO —— 唯一接触 wx API 的地方                                   */
/* ------------------------------------------------------------------ */

/**
 * 存储抽象。**将来接云开发时只换这一层的实现**：
 *
 *   class CloudProgressIO implements ProgressIO {
 *     async load() { const r = await wx.cloud.database().collection('progress')...; }
 *     async save(s) { ... }
 *   }
 *
 * 上层 ProgressStore 的调用方式不变。
 */
export interface ProgressIO {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** 本机存储实现（同步，零依赖） */
export const localIO: ProgressIO = {
  read: function (key: string): string | null {
    try {
      const v = wx.getStorageSync(key);
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch (e) {
      console.warn('[progress] 读取本机存储失败', e);
      return null;
    }
  },
  write: function (key: string, value: string): void {
    try {
      wx.setStorageSync(key, value);
    } catch (e) {
      // 存储写失败必须让用户知道——否则他会做完一关发现进度全没了
      console.error('[progress] 写入本机存储失败', e);
      throw new Error('进度保存失败，请检查手机存储空间');
    }
  },
  remove: function (key: string): void {
    try {
      wx.removeStorageSync(key);
    } catch (e) {
      console.warn('[progress] 清除本机存储失败', e);
    }
  },
};

/* ------------------------------------------------------------------ */
/*  对外门面                                                            */
/* ------------------------------------------------------------------ */

export class ProgressStore {
  private io: ProgressIO;
  private cache: ProgressSnapshot | null = null;

  constructor(io?: ProgressIO) {
    this.io = io || localIO;
  }

  /** 读取快照（带内存缓存：页面频繁读进度，不能每次都反序列化） */
  load(subject?: string): ProgressSnapshot {
    if (this.cache) return this.cache;

    const raw = this.io.read(PROGRESS_CONFIG.storageKey);
    if (!raw) {
      this.cache = emptySnapshot(subject || 'c_lang');
      return this.cache;
    }

    try {
      const parsed = JSON.parse(raw);
      // ⚠️ 存进去的东西是**不可信输入**：可能来自旧版本代码、被手工改过、
      //    或写到一半被强杀导致截断。宁可重置也不能把脏数据喂给页面。
      if (!isValidSnapshot(parsed)) {
        console.warn('[progress] 本机进度数据格式不认识，已重置');
        this.cache = emptySnapshot(subject || 'c_lang');
        return this.cache;
      }
      if (parsed.version !== PROGRESS_CONFIG.schemaVersion) {
        // 将来在这里做版本迁移。当前只有 v1，直接重置并说明。
        console.warn('[progress] 进度数据版本不匹配（' + parsed.version + '），已重置');
        this.cache = emptySnapshot(subject || 'c_lang');
        return this.cache;
      }
      this.cache = parsed;
      return this.cache;
    } catch (e) {
      console.warn('[progress] 进度数据解析失败，已重置', e);
      this.cache = emptySnapshot(subject || 'c_lang');
      return this.cache;
    }
  }

  save(snapshot: ProgressSnapshot): void {
    this.cache = snapshot;
    this.io.write(PROGRESS_CONFIG.storageKey, JSON.stringify(snapshot));
  }

  /** 合并一次关卡结果并落盘，返回新快照 */
  record(
    summary: SessionSummary,
    meta: {
      chapterId: string;
      subject: string;
      wrongDetails?: WrongQuestionMeta[];
      countsAsLevel?: boolean;
    }
  ): ProgressSnapshot {
    const next = applySummary(this.load(meta.subject), summary, meta);
    this.save(next);
    return next;
  }

  getLevel(levelId: string): LevelProgress | undefined {
    return this.load().levels[levelId];
  }

  getWrongEntries(): WrongEntry[] {
    return activeWrongEntries(this.load());
  }

  /** 清空（设置页的「重置进度」用；调用前必须二次确认） */
  reset(subject?: string): ProgressSnapshot {
    const fresh = emptySnapshot(subject || 'c_lang');
    this.save(fresh);
    return fresh;
  }
}

/** 结构校验：把「不认识的数据」挡在外面，不让它把页面搞崩 */
function isValidSnapshot(v: unknown): v is ProgressSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.version !== 'number') return false;
  if (typeof o.totalXp !== 'number') return false;
  if (!o.levels || typeof o.levels !== 'object') return false;
  if (!o.wrongBook || typeof o.wrongBook !== 'object') return false;
  return true;
}

/** 全局单例：页面之间共享同一份缓存，避免各自读到不同版本 */
export const progressStore = new ProgressStore();
