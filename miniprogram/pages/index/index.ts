/**
 * 章节地图页（首页）
 *
 * 设计目标（多邻国式）：
 *   - 单屏只做一个决策：**我现在该打哪一关**
 *   - 关卡按顺序排成一条路径，已通关的显示星级，锁着的显示条件
 *   - 顶部只放最必要的信息（章节名、完成度、经验），不放仪表盘
 *
 * 数据纪律：
 *   - 进度来自 progressStore（带内存缓存），不每次重新反序列化
 *   - setData 只传变化部分；关卡列表是「派生数据」，在建列表时一次算好
 */

import { SUBJECTS, CHAPTERS, LEVELS, KNOWLEDGE_POINTS } from '../../mock/bank';
import { progressStore } from '../../services/progress';
import { store } from '../../store/index';
import type { LevelMode } from '../../engine/types';

/** 关卡卡片的展示模型 */
interface LevelCardVM {
  id: string;
  name: string;
  index: number;
  mode: LevelMode;
  modeLabel: string;
  modeCls: string;
  questionCount: number;
  stars: number;
  starList: boolean[];
  unlocked: boolean;
  lockedHint: string;
  /** 主按钮文案 */
  actionText: string;
  /** 已通关（星级 > 0） */
  cleared: boolean;
  /** 推荐下一关（未通关且已解锁的第一个） */
  isNext: boolean;
  bestScoreText: string;
}

/** 关卡形态 → 徽标与说明。集中定义，避免文案与数据脱节 */
const MODE_META: Record<string, { label: string; cls: string }> = {
  practice: { label: '练习', cls: 'pill-success' },
  review: { label: '复习', cls: 'pill-success' },
  boss: { label: 'Boss', cls: 'pill-danger' },
  challenge: { label: '编程', cls: 'pill-primary' },
};

function starsToBool(n: number): boolean[] {
  return [n >= 1, n >= 2, n >= 3];
}

Page({
  data: {
    theme: 'light',
    /* 顶部概览 */
    activeSubject: 'c_lang',
    subjectName: 'C 语言',
    chapterName: '',
    chapterDesc: '',
    totalXp: 0,
    clearedText: '',
    starText: '',
    progressPercent: 0,
    /* 列表 */
    levelCards: [] as LevelCardVM[],
    /* 科目条：当前只有 C 语言真正可玩，其余点了给「待扩科」提示 */
    subjects: [] as { id: string; name: string; ready: boolean }[],
    /* 空状态 */
    hasLevels: true,
  },

  onLoad() {
    // 科目条从题库里取，但只把「已有关卡数据的」标为 ready
    const subs: { id: string; name: string; ready: boolean }[] = [];
    for (let i = 0; i < SUBJECTS.length; i++) {
      const s = SUBJECTS[i];
      const hasChapter = CHAPTERS.some(function (c) { return c.subjectId === s.id; });
      subs.push({ id: s.id, name: s.name, ready: hasChapter });
    }
    this.setData({ theme: store.state.theme, subjects: subs });
  },

  onShow() {
    // onShow 而非 onLoad：从答题页返回时必须刷新进度和星级
    this.setData({ theme: store.state.theme });
    this.rebuild();
  },

  /** 根据当前进度重算整张地图（派生数据一次算好，避免 wxml 里做逻辑） */
  rebuild() {
    const subjectId = this.data.activeSubject;
    const snap = progressStore.load(subjectId);

    const chapter = CHAPTERS.find(function (c) { return c.subjectId === subjectId; });
    const chapterId = chapter ? chapter.id : '';

    // 本章节的关卡，按题库里的顺序（顺序即解锁顺序）
    const levelIds: string[] = [];
    const chapterLevels = LEVELS.filter(function (l) { return l.chapterId === chapterId; });
    for (let i = 0; i < chapterLevels.length; i++) levelIds.push(chapterLevels[i].id);

    // 找到「推荐下一关」：第一个未通关且已解锁的
    let nextId = '';
    for (let i = 0; i < levelIds.length; i++) {
      const p = snap.levels[levelIds[i]];
      const cleared = !!p && p.bestStars > 0;
      if (!cleared) {
        nextId = levelIds[i];
        break;
      }
    }

    const cards: LevelCardVM[] = [];
    for (let i = 0; i < chapterLevels.length; i++) {
      const lv = chapterLevels[i];
      const p = snap.levels[lv.id];
      const stars = p ? p.bestStars : 0;
      const cleared = stars > 0;

      // 解锁：第一关永远开；其余要求前一关至少 1 星
      let unlocked = i === 0;
      if (i > 0) {
        const prev = snap.levels[levelIds[i - 1]];
        unlocked = !!prev && prev.bestStars >= 1;
      }

      const meta = MODE_META[lv.mode] || { label: lv.mode, cls: 'pill' };

      cards.push({
        id: lv.id,
        name: lv.name,
        index: i + 1,
        mode: lv.mode,
        modeLabel: meta.label,
        modeCls: meta.cls,
        questionCount: lv.questionIds.length,
        stars: stars,
        starList: starsToBool(stars),
        unlocked: unlocked,
        lockedHint: unlocked ? '' : '通关上一关后解锁',
        actionText: !unlocked ? '未解锁' : cleared ? '再练一次' : '开始',
        cleared: cleared,
        isNext: lv.id === nextId,
        bestScoreText: p && p.bestScoreRate > 0
          ? '最佳 ' + Math.round(p.bestScoreRate * 100) + '%'
          : '',
      });
    }

    // 章节完成度
    let clearedCount = 0;
    let starSum = 0;
    for (let i = 0; i < levelIds.length; i++) {
      const p = snap.levels[levelIds[i]];
      if (p && p.bestStars > 0) clearedCount++;
      starSum += p ? p.bestStars : 0;
    }
    const maxStars = levelIds.length * 3;

    this.setData({
      subjectName: subjectDisplayName(subjectId),
      chapterName: chapter ? chapter.name : '暂无章节',
      chapterDesc: chapter ? buildChapterDesc(chapter.id) : '',
      totalXp: snap.totalXp,
      clearedText: clearedCount + ' / ' + levelIds.length + ' 关',
      starText: starSum + ' / ' + maxStars + ' 星',
      progressPercent: maxStars === 0 ? 0 : Math.round((starSum / maxStars) * 100),
      levelCards: cards,
      hasLevels: chapterLevels.length > 0,
    });
  },

  /* ----------------------------- 交互 ----------------------------- */

  onTapLevel(e: any) {
    const ds = e.currentTarget.dataset;
    const id = ds.id;
    const unlocked = ds.unlocked;

    if (!unlocked) {
      wx.showToast({ title: '先通关上一关', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/level/level?levelId=' + id });
  },

  onTapSubject(e: any) {
    const id = e.currentTarget.dataset.id;
    const sub = this.data.subjects.find(function (s) { return s.id === id; });
    if (!sub || !sub.ready) {
      wx.showToast({ title: '该科目题库正在补充中', icon: 'none' });
      return;
    }
    this.setData({ activeSubject: id });
    this.rebuild();
  },

  onTapWrongBook() {
    wx.navigateTo({ url: '/pages/wrong/wrong' });
  },

  onTapProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },
});

function subjectDisplayName(id: string): string {
  const s = SUBJECTS.find(function (x) { return x.id === id; });
  return s ? s.name : id;
}

/** 章节副标题：用知识点名称说明「这一章会学到什么」，比干巴巴的「第 1 章」有用 */
function buildChapterDesc(chapterId: string): string {
  const kps = KNOWLEDGE_POINTS.filter(function (k) { return k.chapterId === chapterId; });
  if (kps.length === 0) return '';
  const names: string[] = [];
  for (let i = 0; i < kps.length; i++) names.push(kps[i].name);
  return names.join(' · ');
}
