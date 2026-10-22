/**
 * 关卡答题页
 *
 * 数据纪律：
 *  - LevelSession 挂在页面实例上（非渲染数据区），不进 data
 *  - setData 只传变化字段；计时器只更新 view.elapsedMs 一个路径
 *  - 判分一律走 services/judge，页面不碰判分器
 */

import { fetchLevelQuestions, fetchQuestionsByIds, type LevelBundle } from '../../services/question';
import { judgeAnswer } from '../../services/judge';
import { progressStore, type WrongQuestionMeta } from '../../services/progress';
import { LevelSession } from '../../engine/session';
import type { ClientQuestion, JudgeResult, SessionSummary, SessionView } from '../../engine/types';
import { formatMs, formatPercent, formatDurationCn, STAR_TEXT } from '../../utils/format';
import { store } from '../../store/index';

interface WrongItem {
  id: string;
  type: string;
  percent: number;
  /** 该题的解析（练习关才有；Boss 关不下发） */
  analysis: string;
  /** 是否可展开看解析 */
  hasAnalysis: boolean;
  /** 结果页上的展开态 */
  expanded: boolean;
}

let timer: number | null = null;

Page({
  data: {
    theme: 'light',
    loading: true,
    error: '',
    levelName: '',
    levelMode: '',
    view: null as SessionView | null,
    question: null as ClientQuestion | null,
    feedback: null as JudgeResult | null,
    locked: false,
    clock: '0:00',
    finished: false,
    summary: null as SessionSummary | null,
    starList: [false, false, false],
    starText: '',
    rateText: '',
    timeText: '',
    wrongItems: [] as WrongItem[],
    /** 进度落盘失败（存储满等）——必须让用户看见，不能静默丢进度 */
    saveFailed: false,
    /** 本次是「首次通关」——结果页给一条额外鼓励语 */
    newlyCleared: false,
  },

  // 非渲染数据区
  session: null as LevelSession | null,
  shownAt: 0,
  busy: false,
  /** 当前关卡所属章节 / 科目：落盘进度要用，从 LevelDef 与题目上取 */
  chapterId: '',
  subjectId: 'c_lang',
  /** 进入本关前是否已经通关过（用于「首次通关」提示） */
  isFirstClear: false,
  /** 错题重做模式：记下题目 id 与名称，供「再练一次」复用 */
  virtualIds: null as string[] | null,
  virtualName: '',

  onLoad(options: any) {
    this.setData({ theme: store.state.theme });

    // 两种进入方式：
    //   ?levelId=xxx            正常关卡
    //   ?ids=a,b,c&name=错题重做   错题本重做（合成一个虚拟复习关）
    if (options && options.ids) {
      const ids = String(options.ids).split(',').filter(function (s) { return s.length > 0; });
      this.loadVirtual(ids, decodeURIComponent(options.name || '错题重做'));
      return;
    }

    const levelId = (options && options.levelId) || 'c_ch01_lv01';
    this.loadLevel(levelId);
  },

  /** 错题本重做：把错题 id 列表合成一个虚拟复习关 */
  async loadVirtual(ids: string[], name: string) {
    this.stopTimer();
    this.virtualIds = ids.slice();
    this.virtualName = name;
    try {
      this.setData({ loading: true, error: '', finished: false });
      const bundle = await fetchQuestionsByIds(ids, 'virtual_review', name);
      if (bundle.questions.length === 0) {
        this.setData({ loading: false, error: '这些题已从题库下架，没有可重做的内容' });
        return;
      }
      this.mountSession(bundle);
    } catch (err: any) {
      this.setData({ loading: false, error: (err && err.message) || '加载失败' });
    }
  },

  onUnload() {
    this.stopTimer();
  },

  async loadLevel(levelId: string) {
    this.stopTimer();
    this.virtualIds = null;
    this.virtualName = '';
    try {
      this.setData({ loading: true, error: '', finished: false });
      const bundle = await fetchLevelQuestions(levelId);
      this.mountSession(bundle);
    } catch (err: any) {
      this.setData({ loading: false, error: (err && err.message) || '关卡加载失败' });
    }
  },

  /** 把取到的题组装成会话并开始答题（正常关卡与错题重做共用） */
  mountSession(bundle: LevelBundle) {
    const session = new LevelSession(bundle.level, bundle.questions);
    session.beginLoad();
    session.ready();
    this.session = session;
    this.shownAt = Date.now();

    // ── 落盘上下文 ──
    // chapterId 来自关卡本身；subject 从题目上取（LevelDef 不带 subject）。
    // 万一题目为空（不该发生），退回默认科目而不是写空串——空串会让
    // 快照的 subject 变成 ''，切科目时进度看起来「消失了」。
    this.chapterId = bundle.level.chapterId || '';
    this.subjectId = bundle.questions.length > 0
      ? bundle.questions[0].subject || 'c_lang'
      : 'c_lang';

    // 进关前先记下是否已通关：finishLevel 里会写进度，
    // 写完再读就永远看不到「首次」了，所以必须在这里判定。
    const prev = progressStore.getLevel(bundle.level.id);
    this.isFirstClear = !prev || prev.bestStars <= 0;

    this.setData({
      loading: false,
      levelName: bundle.level.name,
      levelMode: bundle.level.mode,
      question: session.current,
      feedback: null,
      locked: false,
      summary: null,
      view: session.view(),
      clock: '0:00',
      finished: false,
      saveFailed: false,
      newlyCleared: false,
      wrongItems: [],
    });

    this.startTimer();
  },

  /* ----------------------------- 计时 ----------------------------- */

  startTimer() {
    this.stopTimer();
    const self = this;
    timer = setInterval(function () {
      const session = self.session;
      if (!session) return;
      const elapsed = session.view().elapsedMs;
      // 只更新变化字段，不整包 setData
      self.setData({ 'view.elapsedMs': elapsed, clock: formatMs(elapsed) });
    }, 1000);
  },

  stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  },

  /* ----------------------------- 答题流程 ----------------------------- */

  async onQuestionSubmit(e: any) {
    const session = this.session;
    if (!session || this.busy) return;

    const question = session.current;
    if (!question) return;

    this.busy = true;
    const answer = e.detail.answer;
    const costMs = this.shownAt > 0 ? Date.now() - this.shownAt : 0;

    try {
      const result = await judgeAnswer(question, answer);
      session.submit(answer, result, costMs);
      this.setData({ feedback: result, locked: true, view: session.view() });
    } catch (err) {
      console.error('[level] 判分失败', err);
      wx.showToast({ title: '判分失败，请重试', icon: 'none' });
    } finally {
      this.busy = false;
    }
  },

  onQuestionNext() {
    const session = this.session;
    if (!session) return;

    const hasMore = session.next();
    if (!hasMore) {
      this.finishLevel();
      return;
    }

    this.shownAt = Date.now();
    this.setData({
      question: session.current,
      feedback: null,
      locked: false,
      view: session.view(),
    });
  },

  finishLevel() {
    const session = this.session;
    if (!session) return;

    this.stopTimer();
    const summary = session.summary();

    // ═══════════════════════════════════════════════════════════════
    // 落盘进度 —— 必须在渲染结果页**之前**做，且失败不能阻断流程
    // ═══════════════════════════════════════════════════════════════
    //
    // 两个取舍：
    //  1. **先存再渲染**：让用户看到结果页时，首页的星级已经是新的。
    //     若顺序反过来，快速返回首页可能看到旧星级（要再进来一次才对）。
    //  2. **存储失败不阻断答题**：用户刚做完一关，不能因为写盘失败就
    //     整个页面报错。代价是提示一下，但**必须明确告诉他**没存上——
    //     静默丢失进度是最让人恼火的问题。
    let saveFailed = false;
    try {
      progressStore.record(summary, {
        chapterId: this.chapterId,
        subject: this.subjectId,
        wrongDetails: this.collectWrongMeta(session),
        // 错题重做是合成出来的复习局，不是题库里的真实关卡：
        // 不写关卡记录（否则个人页「已通关 X/3 关」会凭空多一关），
        // 但错题本与知识点统计照常更新 —— 那才是重做的目的。
        countsAsLevel: !this.virtualIds,
      });
    } catch (e) {
      console.error('[level] 进度保存失败', e);
      saveFailed = true;
    }

    const wrongItems: WrongItem[] = [];
    for (let i = 0; i < summary.records.length; i++) {
      const r = summary.records[i];
      if (r.result.correct) continue;

      // 解析只在练习关下发（Boss 关 sanitize 时已剔除）
      const q = this.questionById(r.questionId);
      const analysis = q && q.analysis ? q.analysis.text : '';

      wrongItems.push({
        id: r.questionId,
        type: r.type,
        percent: Math.round(r.result.score * 100),
        analysis: analysis,
        hasAnalysis: analysis.length > 0,
        expanded: false,
      });
    }

    this.setData({
      finished: true,
      locked: true,
      summary: summary,
      starList: [summary.stars >= 1, summary.stars >= 2, summary.stars >= 3],
      starText: STAR_TEXT[summary.stars] || '未通过',
      rateText: formatPercent(summary.scoreRate),
      timeText: formatDurationCn(summary.costMs),
      wrongItems: wrongItems,
      saveFailed: saveFailed,
      newlyCleared: summary.stars > 0 && this.isFirstClear,
    });
  },

  /** 取本题的客户端可见数据（用于拿解析）。找不到就返回 null，不抛错 */
  questionById(id: string): ClientQuestion | null {
    const session = this.session;
    if (!session) return null;
    for (let i = 0; i < session.questions.length; i++) {
      if (session.questions[i].id === id) return session.questions[i];
    }
    return null;
  },

  /**
   * 组织错题详情交给进度层。
   *
   * ⚠️ 为什么由页面来做这件事而不是进度层自己去查题库：
   *    progress.ts 是**纯逻辑**（不 import 题库），这样它能在 Node 里跑测试。
   *    让它去查题库就会把纯函数变成「依赖数据源的函数」，测试没法造数据。
   *    所以由页面（已经持有题目列表）把详情传下去。
   */
  collectWrongMeta(session: LevelSession): WrongQuestionMeta[] {
    const out: WrongQuestionMeta[] = [];
    for (let i = 0; i < session.questions.length; i++) {
      const q = session.questions[i];
      out.push({
        questionId: q.id,
        chapterId: q.chapterId,
        kpIds: q.kpIds || [],
        type: q.type,
      });
    }
    return out;
  },

  /** 展开/收起某道错题的解析 */
  onToggleAnalysis(e: any) {
    const idx = e.currentTarget.dataset.index;
    const key = 'wrongItems[' + idx + '].expanded';
    const cur = this.data.wrongItems[idx];
    if (!cur) return;
    this.setData({ [key]: !cur.expanded });
  },

  onRestart() {
    // 错题重做：用同一批题重新开一局，而不是去 loadLevel('virtual_review')
    // —— 那个关卡 id 在题库里不存在，会报「关卡不存在」。
    if (this.virtualIds && this.virtualIds.length > 0) {
      this.loadVirtual(this.virtualIds, this.virtualName);
      return;
    }
    const session = this.session;
    if (!session) return;
    this.loadLevel(session.levelId);
  },

  onBack() {
    wx.navigateBack({ delta: 1 });
  },
});
