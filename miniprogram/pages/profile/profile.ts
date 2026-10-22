/**
 * 我的（个人中心 · 极简版）
 *
 * 当前定位：**只做「给自己看的成绩单」**，不做登录、不做付费、不做社交。
 * 理由：用户现在的目标是「一个人能玩得下去」，登录/付费是商业化阶段的事。
 * 但现在必须把入口留好 —— 所以底部有「账号与同步（待开放）」的占位说明，
 * 让用户知道这些东西将来会有，而不是「这产品怎么什么都没有」。
 *
 * 数据纪律：所有数字从 progressStore 派生，一次算好；wxml 不做逻辑。
 */

import { progressStore } from '../../services/progress';
import { SUBJECTS, CHAPTERS, LEVELS } from '../../mock/bank';
import { store } from '../../store/index';
import { formatDurationCn } from '../../utils/format';

/** 科目维度的统计卡 */
interface SubjectStat {
  id: string;
  name: string;
  ready: boolean;
  clearedText: string;
  starText: string;
  percent: number;
  xp: number;
}

Page({
  data: {
    theme: 'light',
    /* 总览 */
    totalXp: 0,
    clearedLevels: 0,
    totalLevels: 0,
    totalStars: 0,
    maxStars: 0,
    wrongCount: 0,
    playTimeText: '0 分钟',
    /* 分科统计 */
    subjectStats: [] as SubjectStat[],
    /* 主题切换 */
    isDark: false,
  },

  onLoad() {
    this.setData({ theme: store.state.theme, isDark: store.state.theme === 'dark' });
  },

  onShow() {
    this.setData({ theme: store.state.theme, isDark: store.state.theme === 'dark' });
    this.rebuild();
  },

  rebuild() {
    const snap = progressStore.load();

    // ── 总览 ──
    let cleared = 0;
    let stars = 0;
    let playMs = 0;
    const levelKeys = Object.keys(snap.levels);
    for (let i = 0; i < levelKeys.length; i++) {
      const p = snap.levels[levelKeys[i]];
      if (p.bestStars > 0) cleared++;
      stars += p.bestStars;
      // 累计用时：**用每次尝试的估算**。bestCostMs 只是单次最好成绩，
      // 拿它当总时长会严重低估（练了 10 次只算 1 次），所以按 attempts × bestCostMs 估。
      playMs += p.bestCostMs * Math.max(p.attempts, 1);
    }

    const totalLevels = LEVELS.length;
    const wrongCount = progressStore.getWrongEntries().length;

    // ── 分科 ──
    const subjStats: SubjectStat[] = [];
    for (let i = 0; i < SUBJECTS.length; i++) {
      const s = SUBJECTS[i];
      const chapterIds: string[] = [];
      for (let c = 0; c < CHAPTERS.length; c++) {
        if (CHAPTERS[c].subjectId === s.id) chapterIds.push(CHAPTERS[c].id);
      }
      const lvIds: string[] = [];
      for (let l = 0; l < LEVELS.length; l++) {
        if (chapterIds.indexOf(LEVELS[l].chapterId) >= 0) lvIds.push(LEVELS[l].id);
      }

      let sCleared = 0;
      let sStars = 0;
      let sXp = 0;
      for (let k = 0; k < lvIds.length; k++) {
        const p = snap.levels[lvIds[k]];
        if (!p) continue;
        if (p.bestStars > 0) sCleared++;
        sStars += p.bestStars;
        sXp += p.xp;
      }
      const maxS = lvIds.length * 3;

      subjStats.push({
        id: s.id,
        name: s.name,
        ready: lvIds.length > 0,
        clearedText: lvIds.length > 0 ? sCleared + '/' + lvIds.length + ' 关' : '待扩科',
        starText: lvIds.length > 0 ? sStars + '/' + maxS + ' 星' : '',
        percent: maxS > 0 ? Math.round((sStars / maxS) * 100) : 0,
        xp: sXp,
      });
    }

    this.setData({
      totalXp: snap.totalXp,
      clearedLevels: cleared,
      totalLevels: totalLevels,
      totalStars: stars,
      maxStars: totalLevels * 3,
      wrongCount: wrongCount,
      playTimeText: playMs > 0 ? formatDurationCn(playMs) : '0 分钟',
      subjectStats: subjStats,
    });
  },

  /* ----------------------------- 交互 ----------------------------- */

  onToggleTheme() {
    const next = store.state.theme === 'dark' ? 'light' : 'dark';
    store.setTheme(next);
    this.setData({ theme: next, isDark: next === 'dark' });
  },

  onOpenWrongBook() {
    wx.navigateTo({ url: '/pages/wrong/wrong' });
  },

  /** 重置进度：**破坏性操作，必须二次确认**，且文案要说清后果 */
  onResetProgress() {
    const self = this;
    wx.showModal({
      title: '重置全部进度？',
      content: '所有关卡星级、经验、错题本都会被清空，且无法恢复。',
      confirmText: '确定重置',
      confirmColor: '#ef4444',
      cancelText: '再想想',
      success: function (res) {
        if (!res.confirm) return;
        try {
          progressStore.reset();
          self.rebuild();
          wx.showToast({ title: '已重置', icon: 'success' });
        } catch (e) {
          console.error('[profile] 重置失败', e);
          wx.showToast({ title: '重置失败', icon: 'none' });
        }
      },
    });
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },
});
