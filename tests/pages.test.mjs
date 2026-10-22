/**
 * 页面逻辑自检（把页面「真跑一遍」）
 *
 * ═══════════════════════════════════════════════════════════════════
 *  为什么需要这一层（之前三套都覆盖不到的盲区）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 小程序 TS 由**微信开发者工具**编译，Node 侧不做类型检查，也不跑页面。
 * 于是下面这类错误在本机全部测不出来，只会在真机上暴露：
 *
 *   - 页面引用了不存在的实例字段（`this.chapterId` 打错成 `this.chapter`）
 *     → 传进去 undefined，落盘出一个 chapterId 为空的记录
 *   - setData 的 key 路径写错（`'groups[0].card[x].expanded'` 少个 s）
 *     → 模板永远拿不到值，点了没反应，且**不报任何错**
 *   - 派生数据里混进 NaN / undefined（wxml 里会渲染成空白）
 *   - 方法内部抛异常（页面直接白屏）
 *   - 跳转 url 拼错
 *
 * 做法：打桩 `wx` / `Page` / `getApp` 等运行时全局，把页面脚本 import 进来，
 * 再手动调用 onLoad / onShow / 各交互方法，用一个简易 setData 收集渲染数据。
 *
 * ⚠️ 边界（别指望它做到）：
 *    - 它**不渲染 wxml**，所以布局问题、样式问题测不出来
 *    - setData 的路径解析是简化版（够用即可），不是微信的完整实现
 *    - 它验证的是「页面的数据流是通的」，不是「长得对」
 *
 * 运行：node tests/pages.test.mjs
 */

import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);

/* ------------------------------ 断言脚手架 ------------------------------ */

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passCount++;
    console.log('  \u2713 ' + name);
  } else {
    failCount++;
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' — ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function section(t) {
  console.log('\n' + t);
}

/* ------------------------------ 小程序运行时打桩 ------------------------------ */

const storage = new Map();
const toasts = [];
const navs = [];

globalThis.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o && o.title),
  showModal: (o) => toasts.push('[modal]' + (o && o.title)),
  navigateTo: (o) => navs.push(o && o.url),
  navigateBack: () => navs.push('back'),
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light' }),
  setBackgroundColor: () => {},
  onThemeChange: () => {},
};

let capturedPage = null;
globalThis.Page = (def) => { capturedPage = def; };
globalThis.App = () => {};
globalThis.getApp = () => ({ globalData: { theme: 'light' } });

/**
 * 把 setData 的 key 路径写进对象。
 * 支持 `a.b` 与 `a[0].b`；**这是简化版**，够页面自检用，
 * 不要当成微信 setData 的完整实现（比如它不处理数组整体替换的边界）。
 */
function setPath(obj, key, val) {
  if (key.indexOf('.') < 0 && key.indexOf('[') < 0) {
    obj[key] = val;
    return;
  }
  const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null) cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = val;
}

/** 构造页面实例：复制方法定义 + 挂一个可收集数据的 setData */
function makePage(mod) {
  const inst = Object.assign({}, mod);
  inst.data = JSON.parse(JSON.stringify(mod.data));
  inst.__setKeys = new Set();
  inst.setData = function (patch) {
    const keys = Object.keys(patch);
    for (let i = 0; i < keys.length; i++) {
      inst.__setKeys.add(keys[i]);
      setPath(inst.data, keys[i], patch[keys[i]]);
    }
  };
  return inst;
}

/**
 * 加载页面模块。
 *
 * ⚠️ 必须带 `?t=时间戳` 绕开 ESM 模块缓存：
 *    Node 的模块实例是跨 import 共享的，这里 reload 是桩的重置手段；
 *    没有缓存破坏的话第二次 loadPage 会拿到第一次的对象。
 *    但**注意**：缓存只在同一次进程内生效，所以这里同时把 capturedPage 置空。
 */
let loadSeq = 0;
async function loadPage(rel) {
  capturedPage = null;
  await import(new URL(rel, import.meta.url).href + '?t=' + Date.now() + '_' + (loadSeq++));
  if (!capturedPage) throw new Error('模块没有调用 Page()：' + rel);
  return capturedPage;
}

/** 等待异步的取题完成（取题服务里有模拟网络延迟） */
function tick(ms) {
  return new Promise((r) => setTimeout(r, ms || 250));
}

const prog = await import('../miniprogram/services/progress.ts');
/**
 * 题库也 import 进来，是为了让下面这些断言**从数据派生**而不是写死数字。
 *
 * 教训：这里曾经写死 `3 关 / 9 星`。题库一扩（8 个知识点 → 11 个关卡）就整片红，
 * 而红的原因和被测的页面逻辑毫无关系 —— 纯粹是测试文件自己记了一笔过时的账。
 * 「关卡数」这种东西的真相在题库里，测试应该去问题库，不该自己背。
 */
const bank = await import('../miniprogram/mock/bank.ts');
/** 第一章的关卡数（页面「关卡列表」显示的就是这些） */
const CHAPTER_LEVEL_COUNT = bank.LEVELS.filter((l) => l.chapterId === 'c_ch01').length;
const { progressStore } = prog;

/** 清空本机存储与进度单例缓存，保证各节之间互不干扰 */
function resetAll() {
  storage.clear();
  toasts.length = 0;
  navs.length = 0;
  const fresh = prog.emptySnapshot('c_lang');
  progressStore.save(fresh);
}

/* ====================================================================== */
/*  1. 章节地图页                                                          */
/* ====================================================================== */

section('1. 章节地图页（进度 / 解锁 / 推荐下一关）');

resetAll();
{
  const page = await loadPage('../miniprogram/pages/index/index.ts');
  const inst = makePage(page);

  inst.onLoad();
  ok('onLoad 后有科目列表', Array.isArray(inst.data.subjects) && inst.data.subjects.length === 5);
  eq('只有 C 语言标为可玩', inst.data.subjects.filter((s) => s.ready).length, 1);

  inst.onShow();
  eq('关卡数量正确', inst.data.levelCards.length, CHAPTER_LEVEL_COUNT);
  ok('第一关默认解锁', inst.data.levelCards[0].unlocked === true);
  eq('第二关默认锁住', inst.data.levelCards[1].unlocked, false);
  ok('星级字段都是数字（没有 NaN）', inst.data.levelCards.every((c) => Number.isFinite(c.stars)));
  ok('进度百分比是数字', Number.isFinite(inst.data.progressPercent));
  eq('推荐下一关是第一关', inst.data.levelCards[0].isNext, true);
  eq('科目名正确', inst.data.subjectName, 'C 语言');
  ok('章节副标题由知识点拼出', inst.data.chapterDesc.length > 0);

  // 未解锁的关卡点了必须给提示，且**不能跳转**
  inst.onTapLevel({ currentTarget: { dataset: { id: 'c_ch01_boss', unlocked: false } } });
  ok('点未解锁关卡：给提示', toasts.length > 0);
  eq('点未解锁关卡：不跳转', navs.length, 0);

  inst.onTapLevel({ currentTarget: { dataset: { id: 'c_ch01_lv01', unlocked: true } } });
  eq('点已解锁关卡：跳答题页', navs[navs.length - 1], '/pages/level/level?levelId=c_ch01_lv01');
}

/* ====================================================================== */
/*  2. 错题本页                                                            */
/* ====================================================================== */

section('2. 错题本页（聚合 / 展开 / 重做）');

resetAll();
{
  const page = await loadPage('../miniprogram/pages/wrong/wrong.ts');
  const inst = makePage(page);
  inst.onLoad();
  inst.onShow();

  eq('空错题本：empty 标记', inst.data.empty, true);
  eq('空错题本：没有分组', inst.data.groups.length, 0);

  // 造一份「答错一道题」的进度，走真实的 applySummary 合并路径
  const summary = {
    levelId: 'c_ch01_lv01',
    mode: 'practice',
    total: 1,
    answeredCount: 1,
    correctCount: 0,
    partialCount: 0,
    correctRate: 0,
    scoreRate: 0,
    costMs: 10000,
    avgCostMs: 10000,
    maxCombo: 0,
    stars: 0,
    xp: 5,
    records: [
      {
        questionId: 'q_c_0001',
        type: 'single-choice',
        answer: 'B',
        result: { correct: false, partial: false, score: 0, detail: '', layer: 'local', strategy: 'exact' },
        costMs: 10000,
        comboAfter: 0,
      },
    ],
    wrongQuestionIds: ['q_c_0001'],
  };
  progressStore.save(
    prog.applySummary(prog.emptySnapshot('c_lang'), summary, {
      chapterId: 'c_ch01',
      subject: 'c_lang',
      wrongDetails: [
        { questionId: 'q_c_0001', chapterId: 'c_ch01', kpIds: ['kp_c_operator_int_div'], type: 'single-choice' },
      ],
    })
  );

  inst.onShow();
  eq('有错题后 empty=false', inst.data.empty, false);
  eq('按知识点聚合成 1 组', inst.data.groups.length, 1);
  eq('分组名是知识点名称', inst.data.groups[0].kpName, '整数除法与取模');
  ok('卡片有题面预览', inst.data.groups[0].cards[0].stemPreview.length > 0);
  eq('练习关的题带解析', inst.data.groups[0].cards[0].hasAnalysis, true);
  eq('连对进度文案来自配置', inst.data.groups[0].cards[0].streakText, '0/2');
  eq('掌握阈值来自配置', inst.data.masteryStreak, 2);
  eq('全部重做的 id 列表', inst.data.allIds.length, 1);

  inst.onToggleCard({ currentTarget: { dataset: { g: 0, c: 0 } } });
  eq('展开卡片后 expanded=true', inst.data.groups[0].cards[0].expanded, true);
  inst.onToggleCard({ currentTarget: { dataset: { g: 0, c: 0 } } });
  eq('再点一次收起', inst.data.groups[0].cards[0].expanded, false);

  inst.onRedoGroup({ currentTarget: { dataset: { g: 0 } } });
  ok(
    '重做本组：跳答题页并带上题目 id',
    String(navs[navs.length - 1]).indexOf('/pages/level/level?ids=q_c_0001') === 0,
    navs[navs.length - 1]
  );

  // 组索引越界不能崩（dataset 是字符串，容易出岔子）
  const before = navs.length;
  inst.onRedoGroup({ currentTarget: { dataset: { g: 99 } } });
  eq('组索引越界：安全返回不跳转', navs.length, before);

  inst.onToggleCard({ currentTarget: { dataset: { g: 99, c: 99 } } });
  ok('卡片索引越界：不抛异常', true);
}

/* ====================================================================== */
/*  3. 我的页                                                              */
/* ====================================================================== */

section('3. 我的页（统计 / 主题 / 重置）');

resetAll();
{
  const page = await loadPage('../miniprogram/pages/profile/profile.ts');
  const inst = makePage(page);
  inst.onLoad();

  // 空进度下所有数字都必须是 0 / 合法值，不能是 NaN
  inst.onShow();
  eq('空进度：总经验 0', inst.data.totalXp, 0);
  eq('空进度：已通关 0', inst.data.clearedLevels, 0);
  eq('总关卡数取题库', inst.data.totalLevels, bank.LEVELS.length);
  eq('空进度：错题 0', inst.data.wrongCount, 0);
  ok('空进度：累计用时是字符串', typeof inst.data.playTimeText === 'string' && inst.data.playTimeText.length > 0);
  eq('分科统计覆盖全部科目', inst.data.subjectStats.length, 5);
  ok('分科百分比没有 NaN', inst.data.subjectStats.every((s) => Number.isFinite(s.percent)));
  eq('未开科的科目说明文案', inst.data.subjectStats[1].clearedText, '待扩科');

  // 写一关进度后再看
  const summary = {
    levelId: 'c_ch01_lv01',
    mode: 'practice',
    total: 2,
    answeredCount: 2,
    correctCount: 2,
    partialCount: 0,
    correctRate: 1,
    scoreRate: 1,
    costMs: 20000,
    avgCostMs: 10000,
    maxCombo: 2,
    stars: 3,
    xp: 66,
    records: [],
    wrongQuestionIds: [],
  };
  progressStore.save(
    prog.applySummary(prog.emptySnapshot('c_lang'), summary, {
      chapterId: 'c_ch01',
      subject: 'c_lang',
      wrongDetails: [],
    })
  );
  inst.onShow();
  eq('通关后：总经验', inst.data.totalXp, 66);
  eq('通关后：已通关 1 关', inst.data.clearedLevels, 1);
  eq('通关后：总星级', inst.data.totalStars, 3);
  const cLangLevels = bank.LEVELS.filter((l) => l.chapterId === 'c_ch01').length;
  eq('通关后：C 语言的星级文案', inst.data.subjectStats[0].starText, '3/' + cLangLevels * 3 + ' 星');
  ok('通关后：累计用时不为 0', inst.data.playTimeText !== '0 分钟');

  // 主题切换必须落盘（否则重进小程序又变回浅色）
  inst.onToggleTheme();
  eq('切主题后 data.theme', inst.data.theme, 'dark');
  eq('主题已写入本机存储', storage.get('xxgk:theme:v1'), 'dark');
  inst.onToggleTheme();
  eq('再切回浅色', inst.data.theme, 'light');

  inst.onOpenWrongBook();
  eq('跳转错题本', navs[navs.length - 1], '/pages/wrong/wrong');

  // 重置进度必须二次确认：确认后才清
  inst.onResetProgress();
  ok('重置：弹出二次确认', toasts.some((t) => String(t).indexOf('[modal]') === 0));
  eq('重置：未确认时进度还在', progressStore.load().totalXp, 66);
}

/* ====================================================================== */
/*  4. 答题页入口（正常关卡 / 错题重做）                                    */
/* ====================================================================== */

section('4. 答题页入口（正常关卡 / 错题重做）');

resetAll();
{
  // 正常关卡
  const page = await loadPage('../miniprogram/pages/level/level.ts');
  const inst = makePage(page);
  inst.onLoad({ levelId: 'c_ch01_lv01' });
  await tick();

  eq('正常关卡：加载无错', inst.data.error, '');
  ok('正常关卡：有当前题目', !!inst.data.question);
  eq('正常关卡：章节上下文', inst.chapterId, 'c_ch01');
  eq('正常关卡：科目上下文', inst.subjectId, 'c_lang');
  eq('正常关卡：首次通关标记', inst.isFirstClear, true);
  ok('正常关卡：未标记为虚拟复习', !inst.virtualIds);

  // 关卡不存在要给友好错误，不能白屏
  const page2 = await loadPage('../miniprogram/pages/level/level.ts');
  const inst2 = makePage(page2);
  inst2.onLoad({ levelId: 'not_a_real_level' });
  await tick();
  ok('关卡不存在：给出错误文案而非白屏', inst2.data.error.length > 0, inst2.data.error);
  eq('关卡不存在：loading 已结束', inst2.data.loading, false);
}

{
  // 错题重做
  const page = await loadPage('../miniprogram/pages/level/level.ts');
  const inst = makePage(page);
  inst.onLoad({ ids: 'q_c_0001', name: encodeURIComponent('错题重做') });
  await tick();

  eq('错题重做：加载无错', inst.data.error, '');
  eq('错题重做：关卡名', inst.data.levelName, '错题重做');
  ok('错题重做：有题目', !!inst.data.question);
  eq('错题重做：章节上下文已补上', inst.chapterId, 'c_ch01');
  ok('错题重做：记下 virtualIds 供再练一次', Array.isArray(inst.virtualIds) && inst.virtualIds.length === 1);

  // 空 id 列表要给提示而不是空白页
  const page2 = await loadPage('../miniprogram/pages/level/level.ts');
  const inst2 = makePage(page2);
  inst2.onLoad({ ids: 'q_not_exist', name: 'x' });
  await tick();
  ok('错题全部下架：给出说明而非空白页', inst2.data.error.length > 0, inst2.data.error);
}

/** 进入关卡 → 停表 → 逐题作答 → 交卷结算。
 *
 * 为什么真的一题一题答：xp、星级、错题本都依赖真实的作答记录。
 * 图省事直接清空 records 的话，summary.xp 会算成 0，
 * 「落盘后经验确实增加了」这条断言就变成了永远通过的空断言。
 */
async function playThrough(inst, correct) {
  inst.stopTimer();
  const qs = inst.session.questions;
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const answer = correct ? makeCorrectAnswer(q) : makeWrongAnswer(q);
    // 拿不到正确答案（如编程题：必须服务端判，不下发判分依据）就跳过这题。
    // 直接提交 null 会被判错，从而污染「答对后错题应移出」这类断言。
    if (answer === null) continue;

    inst.shownAt = Date.now() - 3000;
    await inst.onQuestionSubmit({ detail: { answer: answer } });
    inst.onQuestionNext();
  }
  inst.stopTimer();
}

/** 按题型造一份「一定不对」的答案 */
function makeWrongAnswer(q) {
  if (q.type === 'multi-choice') return [];
  if (q.type === 'fill-blank') return ['\u0000__wrong__'];
  return '__wrong__';
}

/** 按题型与判分策略造一份「正确答案」。
 *
 * ⚠️ 不要直接用 localJudgeKey.key —— 它只在 exact / set 两种策略下
 *    与作答形态同构；normalize（填空）和 output（程序输出）的 key 是
 *    **结构化对象**（{ mode, accepted } / { expected }），直接当答案交给判分器
 *    会被判错。这里按策略逐类展开，才是真实的作答形态。
 *
 * 拿不到 localJudgeKey（编程题 / 非练习关）就返回 null，调用方跳过该题。
 */
function makeCorrectAnswer(q) {
  const k = q.localJudgeKey;
  if (!k) return null;

  if (k.strategy === 'exact') return k.key;

  if (k.strategy === 'set') return Array.isArray(k.key) ? k.key.slice() : [k.key];

  if (k.strategy === 'numeric') {
    // numeric 的 key 就是目标值（可能是数字或可解析字符串）
    return String(k.key);
  }

  if (k.strategy === 'normalize') {
    // 填空：按 mode 决定返回 string 还是 string[]
    const spec = k.key && typeof k.key === 'object' ? k.key : { mode: 'single', accepted: [[String(k.key)]] };
    const groups = spec.accepted || [];
    const picks = groups.map((g) => (Array.isArray(g) ? String(g[0]) : String(g)));
    if (spec.mode === 'single') return picks[0] != null ? picks[0] : '';
    return picks;
  }

  if (k.strategy === 'output') {
    // 程序输出：期望输出逐行拼接（与引擎的 output 判分器约定一致）
    const spec = k.key && typeof k.key === 'object' ? k.key : {};
    const lines = spec.expected || [];
    return lines.join('\n');
  }

  return null;
}

/* ====================================================================== */
/*  5. 答题 → 结果页 → 落盘（完整闭环）                                    */
/* ====================================================================== */

section('5. 答题闭环（答完一关后进度确实落地）');

resetAll();
{
  const page = await loadPage('../miniprogram/pages/level/level.ts');
  const inst = makePage(page);
  inst.onLoad({ levelId: 'c_ch01_lv01' });
  await tick();
  ok('开局：有题目', !!inst.data.question);

  await playThrough(inst, true);

  eq('结果页：finished=true', inst.data.finished, true);
  ok('结果页：有成绩对象', !!inst.data.summary);
  ok('结果页：星级数组三项', Array.isArray(inst.data.starList) && inst.data.starList.length === 3);
  ok('结果页：得分率文案非空', inst.data.rateText.length > 0);
  ok('结果页：用时文案非空', inst.data.timeText.length > 0);
  eq('结果页：未保存失败', inst.data.saveFailed, false);
  ok('结果页：本次获得经验 > 0', inst.data.summary.xp > 0, 'xp=' + inst.data.summary.xp);

  // 关键：进度**确实**落地了（这是「先落盘再渲染」的意义）
  const snap = progressStore.load('c_lang');
  ok('落盘：关卡记录已生成', !!snap.levels.c_ch01_lv01);
  ok('落盘：总经验已累加', snap.totalXp > 0, 'xp=' + snap.totalXp);
  ok('落盘：chapterId 不是空的', snap.levels.c_ch01_lv01.chapterId === 'c_ch01');

  // 结果页的星级必须与落盘的一致 —— 否则用户返回首页会看到不同的数字
  eq(
    '落盘星级与结果页一致',
    snap.levels.c_ch01_lv01.bestStars,
    inst.data.summary.stars
  );
}

/* ====================================================================== */
/*  6. 错题重做不污染关卡进度                                              */
/* ====================================================================== */

section('6. 错题重做不污染关卡进度（虚拟复习局）');

resetAll();
{
  // 先答错一关，制造错题
  {
    const page = await loadPage('../miniprogram/pages/level/level.ts');
    const inst = makePage(page);
    inst.onLoad({ levelId: 'c_ch01_lv01' });
    await tick();
    await playThrough(inst, false);
    ok('先答错一关：产生了错题', Object.keys(progressStore.load().wrongBook).length > 0);
  }

  // 再走错题重做。**做两遍**——因为掌握阈值是连续答对 2 次，
  // 只做一遍连对 streak 才 1，错题仍应留在本子里（这是设计，不是 bug）。
  const wrongIds = Object.keys(progressStore.load().wrongBook);
  ok('待攻克错题数 > 0', wrongIds.length > 0);

  // 第一遍：连对 1 次 → 仍留在错题本
  {
    const page = await loadPage('../miniprogram/pages/level/level.ts');
    const inst = makePage(page);
    inst.onLoad({ ids: wrongIds.join(','), name: '错题重做' });
    await tick();
    await playThrough(inst, true);
  }
  ok(
    '只连对 1 次：错题仍在（阈值是 2）',
    prog.activeWrongEntries(progressStore.load()).length > 0
  );

  // 第二遍：连对 2 次 → 移出错题本
  {
    const page = await loadPage('../miniprogram/pages/level/level.ts');
    const inst = makePage(page);
    inst.onLoad({ ids: wrongIds.join(','), name: '错题重做' });
    await tick();
    await playThrough(inst, true);
  }

  const snap = progressStore.load('c_lang');
  ok('错题重做：未产生 virtual_review 关卡记录', !snap.levels.virtual_review);
  eq('错题重做：已通关关卡数未增加（仍只有真实那一关）', Object.keys(snap.levels).length, 1);
  ok('错题重做：经验仍然计入', snap.totalXp > 0, 'xp=' + snap.totalXp);
  eq('连对 2 次后错题被移出错题本', prog.activeWrongEntries(snap).length, 0);
  ok(
    '移出是标记为已掌握而非删除记录',
    wrongIds.every((id) => snap.wrongBook[id] && snap.wrongBook[id].mastered === true)
  );
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('\n' + '='.repeat(56));
console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) {
  console.log('\n失败项：');
  for (let i = 0; i < failures.length; i++) console.log('  - ' + failures[i]);
} else {
  console.log('页面逻辑自检全部通过。');
}
console.log('='.repeat(56));

// ⚠️ 必须显式退出。
//    答题页用 setInterval 走计时（小程序里这是对的），
//    但它在 Node 里是一个**不会自己结束的活跃句柄** → 进程跑完不退出，
//    npm test 会一直挂着，看起来像「卡死」。
//    这里直接 process.exit，不要试图去 clearInterval —— 那是页面内部状态，
//    而且每个 loadPage 都会新建一个模块实例、各自持有独立的 timer。
process.exit(failCount > 0 ? 1 : 0);
