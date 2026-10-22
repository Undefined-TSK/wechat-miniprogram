/**
 * 错题本
 *
 * 设计意图：
 *   1. **按知识点聚合**，不按时间流水列。用户需要知道的是「我哪一块弱」，
 *      而不是「我周三错了三道题」——前者能指导行动，后者只是流水账。
 *   2. 每组可展开看题目原文与解析，**不用跳页**。错题本是「翻一翻」的场景，
 *      跳来跳去会让人放弃。
 *   3. 一键「重做本组」：把这一组错题合成一个复习关去答题页，
 *      答对到「掌握」阈值后自动移出错题本（progress.ts 里的 masteryStreak）。
 *
 * 数据纪律：
 *   - 题面文本在这里从题库取（客户端 sanitize 后，无答案）
 *   - 聚合结果是派生数据，rebuild 时一次算好，wxml 不做逻辑
 */

import { progressStore, PROGRESS_CONFIG, type WrongEntry } from '../../services/progress';
import { findQuestion, KNOWLEDGE_POINTS } from '../../mock/bank';
import { store } from '../../store/index';

/** 错题卡片（聚合后） */
interface WrongCard {
  questionId: string;
  type: string;
  /** 题面纯文本预览（截断到 ~60 字） */
  stemPreview: string;
  /** 完整题面（展开时用） */
  stem: string;
  /** 解析（可能为空：Boss 关不下发） */
  analysis: string;
  hasAnalysis: boolean;
  /** 答错次数 */
  wrongCount: number;
  /** 最近一次得分率百分比 */
  lastScorePercent: number;
  /** 连续答对进度，如 "1/2" */
  streakText: string;
  /** 最近答错时间，显示成「3 天前」 */
  lastWrongText: string;
  /** 是否展开 */
  expanded: boolean;
}

/** 按知识点分组的区块 */
interface WrongGroup {
  kpId: string;
  kpName: string;
  count: number;
  cards: WrongCard[];
}

Page({
  data: {
    theme: 'light',
    groups: [] as WrongGroup[],
    totalCount: 0,
    /** 全部错题的 id（供「全部重做」用） */
    allIds: [] as string[],
    empty: true,
    totalText: '',
    /** 掌握阈值（连续答对几次移出错题本），从配置取，不硬编码 */
    masteryStreak: PROGRESS_CONFIG.masteryStreak,
  },

  onLoad() {
    this.setData({ theme: store.state.theme });
  },

  onShow() {
    // onShow：从答题页返回时错题可能已被移出/新增
    this.setData({ theme: store.state.theme });
    this.rebuild();
  },

  rebuild() {
    const entries = progressStore.getWrongEntries();

    // 1) 逐条转成卡片
    const cards: WrongCard[] = [];
    const ids: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const card = this.toCard(e);
      if (!card) continue; // 题目已下架，跳过
      cards.push(card);
      ids.push(e.questionId);
    }

    // 2) 按知识点聚合
    //    一道题可能挂多个知识点，为避免同一题在多组里重复出现（用户会觉得乱），
    //    只归到**第一个知识点**下。第一个知识点是题库里的主知识点。
    const groupMap: Record<string, WrongGroup> = {};
    const order: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const e = entries[i];
      const kpId = e.kpIds && e.kpIds.length > 0 ? e.kpIds[0] : '__none__';
      if (!groupMap[kpId]) {
        groupMap[kpId] = { kpId: kpId, kpName: kpName(kpId), count: 0, cards: [] };
        order.push(kpId);
      }
      groupMap[kpId].cards.push(cards[i]);
      groupMap[kpId].count++;
    }

    const groups: WrongGroup[] = [];
    for (let i = 0; i < order.length; i++) groups.push(groupMap[order[i]]);

    this.setData({
      groups: groups,
      totalCount: cards.length,
      allIds: ids,
      empty: cards.length === 0,
      totalText: cards.length > 0 ? '共 ' + cards.length + ' 道待攻克' : '',
    });
  },

  /** 错题条目 → 展示卡片。题目已下架返回 null */
  toCard(e: WrongEntry): WrongCard | null {
    const q = findQuestion(e.questionId);
    if (!q || !q.payload) return null;

    const stem = q.payload.stem || '';
    return {
      questionId: e.questionId,
      type: e.type,
      stemPreview: clip(stem, 56),
      stem: stem,
      analysis: q.analysis && q.analysis.text ? q.analysis.text : '',
      hasAnalysis: !!(q.analysis && q.analysis.text),
      wrongCount: e.wrongCount,
      lastScorePercent: Math.round((e.lastScore || 0) * 100),
      streakText: e.correctStreak + '/' + PROGRESS_CONFIG.masteryStreak,
      lastWrongText: relativeTime(e.lastWrongAt),
      expanded: false,
    };
  },

  /* ----------------------------- 交互 ----------------------------- */

  onToggleCard(e: any) {
    const ds = e.currentTarget.dataset;
    const key = 'groups[' + ds.g + '].cards[' + ds.c + '].expanded';
    const group = this.data.groups[ds.g];
    if (!group) return;
    const card = group.cards[ds.c];
    if (!card) return;
    this.setData({ [key]: !card.expanded });
  },

  /** 重做某一组（某个知识点的全部错题） */
  onRedoGroup(e: any) {
    const g = Number(e.currentTarget.dataset.g);
    const group = this.data.groups[g];
    if (!group || group.cards.length === 0) return;

    const ids: string[] = [];
    for (let i = 0; i < group.cards.length; i++) ids.push(group.cards[i].questionId);
    this.openRedo(ids, group.kpName);
  },

  /** 重做全部错题 */
  onRedoAll() {
    if (this.data.allIds.length === 0) return;
    this.openRedo(this.data.allIds.slice(), '错题总复习');
  },

  openRedo(ids: string[], name: string) {
    // 微信 url 长度有限，且题目 id 都很短（q_c_0001），直接用逗号拼接即可。
    // 超过 30 道就分批——一次做 30 道错题已经足够长了，再长用户会疲劳。
    const batch = ids.slice(0, 30);
    const url = '/pages/level/level?ids=' + batch.join(',') +
      '&name=' + encodeURIComponent(name);
    wx.navigateTo({ url: url });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },
});

/* ----------------------------- 辅助函数 ----------------------------- */

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n) + '…';
}

function kpName(kpId: string): string {
  if (kpId === '__none__') return '未归类';
  // 从题库里找知识点名称；找不到就显示 id，不瞎猜
  for (let i = 0; i < KNOWLEDGE_POINTS.length; i++) {
    if (KNOWLEDGE_POINTS[i].id === kpId) return KNOWLEDGE_POINTS[i].name;
  }
  return kpId;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
  return Math.floor(day / 30) + ' 个月前';
}
