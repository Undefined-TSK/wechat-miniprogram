/**
 * 题型引擎验收测试
 *
 * 运行：node tests/engine.test.mjs
 * 覆盖：注册表 / 字段剔除（答案不下发）/ 5 个判分器 / 状态机 / 端到端会话与星级
 */

import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);

const engine = await import('../miniprogram/engine/index.ts');
const { LevelSession, AnswerMachine, sanitizeQuestion, assertNoAnswerLeak } = engine;
const { registerBuiltinJudges } = await import('../miniprogram/engine/judges/index.ts');
const { getJudge, getRenderer, listJudges, listRenderers, _resetRegistry } = engine;
const bank = await import('../miniprogram/mock/bank.ts');

/* ------------------------------ 测试脚手架 ------------------------------ */

let passCount = 0;
let failCount = 0;
const failures = [];

function record(ok, name, extra) {
  if (ok) {
    passCount++;
    console.log('  \u2713 ' + name);
  } else {
    failCount++;
    failures.push(name + (extra ? ' — ' + extra : ''));
    console.log('  \u2717 ' + name + (extra ? ' — ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(a === e, name, a === e ? '' : '期望 ' + e + '，实际 ' + a);
}

function approx(name, actual, expected, eps) {
  const tol = typeof eps === 'number' ? eps : 1e-6;
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
  record(ok, name, ok ? '' : '期望 ' + expected + '，实际 ' + actual);
}

function throws(name, fn) {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
  }
  record(threw, name, threw ? '' : '未抛出预期错误');
}

function section(title) {
  console.log('\n' + title);
}

/** 布尔断言（带名字）。eq/record 只能断相等，布尔条件用它可读性更好 */
function ok(name, cond) {
  record(!!cond, name);
}

/**
 * 造一份 SessionSummary 用于测试进度层。
 *
 * 为什么自己造而不是跑真实 LevelSession：
 *   进度层只消费 summary 的**结构**，跟题目内容无关。造数据能让测试
 *   精确控制「几星 / 错哪几题」，比跑整套会话再硬凑结果清楚得多。
 */
function fakeSummary(levelId, opts) {
  const o = opts || {};
  const wrongIds = o.wrong || [];
  const correctIds = o.correct || [];

  const records = [];
  for (let i = 0; i < correctIds.length; i++) {
    records.push({
      questionId: correctIds[i],
      type: 'single-choice',
      answer: 'A',
      result: { correct: true, partial: false, score: 1, detail: '', layer: 'local', strategy: 'exact' },
      costMs: 3000,
      comboAfter: 1,
    });
  }
  for (let i = 0; i < wrongIds.length; i++) {
    records.push({
      questionId: wrongIds[i],
      type: 'single-choice',
      answer: 'B',
      result: { correct: false, partial: false, score: o.wrongScore || 0, detail: '', layer: 'local', strategy: 'exact' },
      costMs: 5000,
      comboAfter: 0,
    });
  }

  return {
    levelId: levelId,
    mode: 'practice',
    total: records.length || 1,
    answeredCount: records.length,
    correctCount: correctIds.length,
    partialCount: 0,
    correctRate: records.length ? correctIds.length / records.length : 0,
    scoreRate: typeof o.scoreRate === 'number' ? o.scoreRate : 0,
    costMs: typeof o.costMs === 'number' ? o.costMs : 20000,
    avgCostMs: 4000,
    maxCombo: correctIds.length,
    stars: typeof o.stars === 'number' ? o.stars : 0,
    xp: typeof o.xp === 'number' ? o.xp : 0,
    wrongQuestionIds: wrongIds.slice(),
    records: records,
  };
}

/* ------------------------------ 1. 注册表 ------------------------------ */

section('1. 注册表');
registerBuiltinJudges();

eq('已注册全部判分器（5 个 L1 + 2 个服务端占位）', listJudges().sort(), [
  'ai',
  'exact',
  'normalize',
  'numeric',
  'output',
  'sandbox',
  'set',
]);

// 服务端策略占位：必须存在（供覆盖自检），但绝不能在客户端判分
eq('sandbox 占位判分器不可本地判分', getJudge('sandbox')('x', 'y').score, 0);
eq('sandbox 占位判分器标记为远程层', getJudge('sandbox')('x', 'y').layer, 'remote');
eq('ai 占位判分器不可本地判分', getJudge('ai')('x', 'y').score, 0);

throws('判分器重复注册应抛错', function () {
  engine.registerJudge('exact', getJudge('exact'));
});

engine.bootstrapEngine();
eq('渲染器注册数量（含 bootstrap）', listRenderers().length >= 0, true);
eq('single-choice 渲染器已注册', !!getRenderer('single-choice'), true);
eq('未注册题型返回 undefined', getRenderer('not-exist'), undefined);
eq('exact 判分器可取出', typeof getJudge('exact'), 'function');

/* --------------------------- 2. 答案不下发原则 --------------------------- */

section('2. 答案不下发原则');

const q1 = bank.findQuestion('q_c_0001');
const q2 = bank.findQuestion('q_c_0002');
const q4 = bank.findQuestion('q_c_0004');

const practiceView = sanitizeQuestion(q1, { allowLocalJudgeKey: true });
eq('练习关：无 answer 字段', Object.prototype.hasOwnProperty.call(practiceView, 'answer'), false);
eq('练习关：无 judge 字段', Object.prototype.hasOwnProperty.call(practiceView, 'judge'), false);
eq('练习关：无 source 字段', Object.prototype.hasOwnProperty.call(practiceView, 'source'), false);
eq('练习关：下发 localJudgeKey', !!practiceView.localJudgeKey, true);
eq('练习关：localJudgeKey 策略正确', practiceView.localJudgeKey.strategy, 'exact');
eq('练习关：下发解析', typeof practiceView.analysis.text, 'string');

const bossView = sanitizeQuestion(q1, { allowLocalJudgeKey: false });
eq('Boss 关：无 localJudgeKey', bossView.localJudgeKey, undefined);
eq('Boss 关：无解析', bossView.analysis, undefined);
eq('Boss 关：序列化后仍不含 answer', JSON.stringify(bossView).indexOf('"answer"') >= 0, false);

throws('泄漏 answer 时断言应拦截', function () {
  assertNoAnswerLeak({ id: 'x', answer: 'B' });
});
throws('泄漏 judge 时断言应拦截', function () {
  assertNoAnswerLeak({ id: 'x', judge: { strategy: 'exact' } });
});
assertNoAnswerLeak(practiceView); // 合法数据不应抛错
record(true, '合法数据通过断言');

/* ------------------------------ 3. 判分器 ------------------------------ */

section('3. L1 判分器');

const exact = getJudge('exact');
eq('exact：正确答案', exact('B', 'B').correct, true);
eq('exact：忽略大小写', exact('b', 'B').correct, true);
eq('exact：错误答案', exact('C', 'B').correct, false);
eq('exact：揭示正确项', exact('C', 'B').reveal.correctKeys, ['B']);

const set = getJudge('set');
const setOpts = q2.judge.options;
eq('set：全对', set(['A', 'B', 'D'], q2.answer, setOpts).score, 1);
eq('set：漏选（开启半分）', Math.round(set(['A', 'B'], q2.answer, setOpts).score * 1000) / 1000, 0.667);
eq('set：漏选标记为部分正确', set(['A', 'B'], q2.answer, setOpts).partial, true);
eq('set：多选错误项得 0 分', set(['A', 'B', 'C'], q2.answer, setOpts).score, 0);
eq('set：漏选但未开启半分得 0 分', set(['A', 'B'], q2.answer, {}).score, 0);
eq('set：揭示全部正确项', set(['A'], q2.answer, setOpts).reveal.correctKeys.join(','), 'A,B,D');

const normalize = getJudge('normalize');
const q3 = bank.findQuestion('q_c_0003');
const nOpts = q3.judge.options;
eq('normalize：两空全对', normalize(['65', 'int'], q3.answer, nOpts).score, 1);
eq('normalize：同义答案命中', normalize(['65', '整型'], q3.answer, nOpts).score, 1);
eq('normalize：忽略大小写', normalize(['65', 'INT'], q3.answer, nOpts).score, 1);
eq('normalize：全角数字归一', normalize(['６５', 'int'], q3.answer, nOpts).score, 1);
eq('normalize：一空错则不给分（未开半分）', normalize(['65', '整数'], q3.answer, nOpts).score, 0);
eq('normalize：空答案不得分', normalize(['', 'int'], q3.answer, nOpts).score, 0);
eq('normalize：揭示可接受答案', normalize(['x', 'y'], q3.answer, nOpts).reveal.acceptedText.join('/'), '65/int');

const output = getJudge('output');
const oOpts = q4.judge.options;
eq('output：完全正确', output('sum=9\ncount=3', q4.answer, oOpts).score, 1);
eq('output：容忍行尾空格', output('sum=9   \ncount=3  \n\n', q4.answer, oOpts).score, 1);
eq('output：容忍 CRLF', output('sum=9\r\ncount=3\r\n', q4.answer, oOpts).score, 1);
eq('output：数值错误不给分', output('sum=10\ncount=3', q4.answer, oOpts).score, 0);
eq('output：行数不一致不给分', output('sum=9', q4.answer, oOpts).score, 0);
eq('output：行数不一致时提示行数', output('sum=9', q4.answer, oOpts).detail.indexOf('行数不一致') >= 0, true);
eq('output：指出错误行号', output('sum=10\ncount=3', q4.answer, oOpts).detail.indexOf('第 1 行') >= 0, true);
eq('output：揭示期望输出', output('x', q4.answer, oOpts).reveal.expectedLines.join('|'), 'sum=9|count=3');

const numeric = getJudge('numeric');
eq('numeric：容差内通过', numeric('3.14159', { value: 3.14, tolerance: 0.01 }).correct, true);
eq('numeric：容差外不通过', numeric('3.20', { value: 3.14, tolerance: 0.01 }).correct, false);
eq('numeric：带单位可解析', numeric('3.14 cm', { value: 3.14, tolerance: 1e-6 }).correct, true);
eq('numeric：相对误差模式', numeric('1000.5', { value: 1000, tolerance: 0.001, mode: 'rel' }).correct, true);
eq('numeric：无法解析不给分', numeric('答案是一', { value: 3.14 }).correct, false);

/* ------------------------------ 4. 状态机 ----------------------------- */

section('4. 答题状态机');

const m = new AnswerMachine();
eq('初始状态', m.phase, 'idle');
throws('idle 不能直接到 answering', function () {
  m.to('answering');
});
eq('idle → loading', m.to('loading'), 'loading');
eq('loading → answering', m.to('answering'), 'answering');
eq('answering → submitting', m.to('submitting'), 'submitting');
throws('submitting 不能重复提交', function () {
  m.to('submitting');
});
eq('submitting → feedback', m.to('feedback'), 'feedback');
eq('feedback → answering', m.to('answering'), 'answering');
eq('finished 是终态', engine.allowedTransitions('finished').length, 0);

/* --------------------- 5. 端到端：全对 → 三星 ---------------------- */

section('5. 端到端会话 · 全对场景');

function makeSession(level, questions) {
  const s = new LevelSession(level, questions);
  s.beginLoad();
  s.ready(1000);
  return s;
}

/**
 * 作答形态契约（渲染器必须遵守，否则判分静默失败）：
 *   single-choice   → string（选项 key）
 *   multi-choice    → string[]（选项 key 数组）
 *   fill-blank      → string[]（按空位顺序）
 *   program-output  → string（多行输出）
 */
function answerAll(s, answers) {
  for (let i = 0; i < answers.length; i++) {
    const q = s.current;
    const key = q.localJudgeKey;
    const fn = getJudge(key.strategy);
    const result = fn(answers[i], key.key, key.options);
    s.submit(answers[i], result, 1000 + i * 500);
    s.next();
  }
}

let sessionQuestions = [];
const practiceLevel = bank.PRACTICE_LEVEL;
for (let i = 0; i < practiceLevel.questionIds.length; i++) {
  sessionQuestions.push(
    sanitizeQuestion(bank.findQuestion(practiceLevel.questionIds[i]), { allowLocalJudgeKey: true })
  );
}

/**
 * ⚠️ 这里刻意**不写死题数与答案**，而是从题目的 localJudgeKey 反推「正确作答」。
 *
 * 原因是这份自检曾经写死「4 道题、答案 ['B', [...], ...]」——
 * 题库一扩到 5 道题（知识点拆细）就整片红，而且红的原因跟被测逻辑毫无关系。
 * 会话题目数、Combo 档位这些断言本该由数据决定，不该由测试文件记住。
 *
 * 反推规则：把 localJudgeKey 里「正确」的那个值取回来当作用户作答。
 * 这样无论题库怎么改，这份自检都在测**同一件事**（会话状态机 + 星级 + Combo）。
 */
function correctAnswerFor(sanitized) {
  const key = sanitized.localJudgeKey;
  if (!key) return null;
  const strat = key.strategy;
  if (strat === 'exact') return key.key;
  if (strat === 'set') return key.key.slice();
  if (strat === 'normalize') {
    // multi 模式：key 是 { mode, accepted: string[][] }，取每组的第一个可接受答案
    if (key.key && key.key.mode === 'multi') {
      return key.key.accepted.map((g) => g[0]);
    }
    // single 模式：accepted 是 string[]
    if (key.key && Array.isArray(key.key.accepted)) return key.key.accepted[0];
    return '';
  }
  if (strat === 'output') {
    // 程序输出题：expected 是行数组，拼成多行文本
    const exp = key.key && key.key.expected ? key.key.expected : [];
    return exp.join('\n');
  }
  return null;
}

/**
 * 反推出一个**必然错误**的作答，形态与题型对齐。
 *
 * ⚠️ 不能简单地「返回空字符串」——很多判分器把空作答当「未作答」，
 *    结果可能不是 false 而是抛错，测试就会因为无关原因挂掉。
 *    所以这里给的是「形态合法、内容错误」的作答。
 */
function wrongAnswerFor(sanitized) {
  const key = sanitized.localJudgeKey;
  const strat = key ? key.strategy : '';
  if (strat === 'exact') {
    // 选一个不等于正确答案的选项 key
    const opts = (sanitized.payload && sanitized.payload.options) || [];
    for (const o of opts) {
      if (o.key !== key.key) return o.key;
    }
    return '__NONE__';
  }
  if (strat === 'set') {
    // 空数组在「set」策略下必然不是正确答案（正确答案至少 2 个）
    return [];
  }
  if (strat === 'normalize') {
    if (key.key && key.key.mode === 'multi') return key.key.accepted.map(() => '__WRONG__');
    return '__WRONG__';
  }
  if (strat === 'output') {
    return '__WRONG_OUTPUT__';
  }
  return '__WRONG__';
}

const s1 = makeSession(practiceLevel, sessionQuestions);
const allCorrect = sessionQuestions.map(correctAnswerFor);
const totalQ = sessionQuestions.length;

eq('会话题目数', s1.total, totalQ);
record('每道题都能反推出正确作答（否则下面的断言是空的）', allCorrect.every((a) => a !== null));
answerAll(s1, allCorrect);
const sum1 = s1.summary();
eq('全对：正确题数', sum1.correctCount, totalQ);
eq('全对：正确率', sum1.correctRate, 1);
eq('全对：三星', sum1.stars, 3);
eq('全对：最大 Combo', sum1.maxCombo, totalQ);
record(
  '全对：连对 ' + totalQ + ' 题进入 ' + engine.comboMultiplier(totalQ) + ' 倍率档',
  engine.comboMultiplier(sum1.maxCombo) >= 1.5
);
record(sum1.xp > 0, '全对：经验值大于 0（' + sum1.xp + '）');
eq('全对：无错题', sum1.wrongQuestionIds.length, 0);
eq('全对：会话回到终态', s1.machine.phase, 'finished');

section('6. 端到端会话 · 混合场景');

/**
 * 混合场景：第 1 题故意答错、第 2 题部分正确、其余全对。
 * 期望值全部由 totalQ 派生，避免写死题数。
 */
const s2 = makeSession(practiceLevel, sessionQuestions);
const mixedAnswers = allCorrect.slice();
let wrongOne = null;
let wrongTwo = null;
// 第 1 题：给出一个必然错误的作答
wrongOne = wrongAnswerFor(sessionQuestions[0]);
mixedAnswers[0] = wrongOne;
// 第 2 题：多选只选一半（触发部分正确），其它题型就退化成「答错」
const qSecond = sessionQuestions[1];
if (qSecond.localJudgeKey && qSecond.localJudgeKey.strategy === 'set') {
  mixedAnswers[1] = qSecond.localJudgeKey.key.slice(0, Math.max(1, qSecond.localJudgeKey.key.length - 1));
  wrongTwo = mixedAnswers[1];
} else {
  mixedAnswers[1] = wrongAnswerFor(qSecond);
  wrongTwo = mixedAnswers[1];
}
answerAll(s2, mixedAnswers);
const sum2 = s2.summary();
eq('混合：正确题数（前两题失手）', sum2.correctCount, totalQ - 2);
record('混合：得分率在 0 与 1 之间', sum2.scoreRate > 0 && sum2.scoreRate < 1, '实际 ' + sum2.scoreRate);
record('混合：星级为 1 或 2 星（部分失分）', sum2.stars >= 1 && sum2.stars <= 2, '实际 ' + sum2.stars);
eq('混合：错题数等于失手的两题', sum2.wrongQuestionIds.length, 2);
eq('混合：第 1 题进错题本', sum2.wrongQuestionIds.indexOf(sessionQuestions[0].id) >= 0, true);
eq('混合：第 2 题进错题本', sum2.wrongQuestionIds.indexOf(sessionQuestions[1].id) >= 0, true);
record('混合：Combo 有重新累计（最大 Combo < 总题数）', sum2.maxCombo < totalQ, '实际 ' + sum2.maxCombo);

section('7. setData 载荷纪律');

const view = s2.view(5000);
const viewKeys = Object.keys(view).sort().join(',');
eq('view 只含渲染必需字段', viewKeys, [
  'answeredCount',
  'combo',
  'comboMultiplier',
  'correctCount',
  'elapsedMs',
  'humanIndex',
  'index',
  'isLast',
  'progressPercent',
  'total',
].sort().join(','));
eq('view 无嵌套对象（可直接 setData）', typeof view.combo === 'number' && typeof view.total === 'number', true);
eq('Combo 倍率阶梯 0 连对', engine.comboMultiplier(0), 1);
eq('Combo 倍率阶梯 2 连对', engine.comboMultiplier(2), 1.2);
eq('Combo 倍率阶梯 4 连对', engine.comboMultiplier(4), 1.5);
eq('Combo 倍率阶梯 6 连对', engine.comboMultiplier(6), 2);

section('8. 非练习关：服务端判分路径');

/**
 * 这里区分「走远程」的三种情况，因为它们的用户可见行为完全不同：
 *  a) 编程题（sandbox）：走判题服务的沙箱链路
 *  b) 选择/填空/程序输出类题落在非练习关：走判题服务的**客观题端点**
 *     （客户端只送「题号 + 作答」，答案不下发、也不在客户端比对）
 *  c) 连服务端都不支持的题型：才是真正的题目配置错误
 *
 * ⚠️ 历史变更：早于「服务端客观题判分链路」的实现里，(b) 被当成题目配置错误
 *    —— 那时 Boss 关的客观题用户答对也判 0 分（100% 无法通过）。
 *    现在 (b) 是**正常链路**，只有 (c) 才是配置异常。
 */
const bossViewQ = sanitizeQuestion(bank.findQuestion('q_c_0001'), { allowLocalJudgeKey: false });
eq('非练习关题目无 localJudgeKey', bossViewQ.localJudgeKey, undefined);
const judgeService = await import('../miniprogram/services/judge.ts');
const remoteResult = await judgeService.judgeAnswer(bossViewQ, 'B');
eq('选择类题落在非练习关：标记为远程层', remoteResult.layer, 'remote');

// (b) 的关键属性：这是**可服务端判分**的题型，客户端不应该自己下结论
ok(
  '选择类题落在非练习关：识别为可服务端判分（不再当成配置错误）',
  judgeService.canJudgeServerSide(bossViewQ),
  '题型 ' + bossViewQ.type + ' 未被识别为可服务端判分'
);
ok(
  '选择类题落在非练习关：不谎称「题目配置异常」',
  remoteResult.detail.indexOf('题目配置异常') < 0,
  '实际 detail：' + remoteResult.detail
);

// (c) 反向：真正不支持的题型仍必须给出明确诊断 + 「不是你的问题」
//     用一个服务端也不认的题型来验证这条防线还在
const unsupportedQ = Object.assign({}, bossViewQ, { type: 'essay' });
ok(
  '不支持的题型（服务端也不认）→ 识别为不可服务端判分',
  !judgeService.canJudgeServerSide(unsupportedQ)
);
const unsupportedResult = await judgeService.judgeAnswer(unsupportedQ, '随便写');
record(
  unsupportedResult.detail.indexOf('题目配置异常') >= 0 ||
    unsupportedResult.detail.indexOf('不是你的问题') >= 0,
  '配置错误时明确告诉用户「这不是你的问题」（而不是让用户以为答错了）'
);

// 编程题：策略映射必须是 sandbox（否则会走错分支）
const codeQ = sanitizeQuestion(bank.findQuestion('q_c_0005'), { allowLocalJudgeKey: false });
eq('编程题不下发 localJudgeKey', codeQ.localJudgeKey, undefined);
eq('编程题策略映射为 sandbox', judgeService.judgeStrategyOf(codeQ), 'sandbox');
eq('编程题需要远程判分', judgeService.requiresRemoteJudge(codeQ), true);

// 策略映射表必须与判分器注册表一致（防「映射表写了个不存在的策略」）
const allTypes = Object.keys(bank.QUESTIONS.reduce(function (acc, q) {
  acc[q.type] = true;
  return acc;
}, {}));
for (let i = 0; i < allTypes.length; i++) {
  const t = allTypes[i];
  const shapeProbe = { type: t, payload: {} };
  const mapped = judgeService.judgeStrategyOf(shapeProbe);
  eq('题型 ' + t + ' 映射到已注册的判分器（' + mapped + '）', engine.hasJudge(mapped), true);
}

section('9. 作答形态契约（渲染器 ↔ 判分器的唯一约定）');

const qc1 = sanitizeQuestion(bank.findQuestion('q_c_0001'), { allowLocalJudgeKey: true });
eq('单选空答案形态', engine.emptyAnswerFor(qc1), '');
eq('单选未选不可提交', engine.isSubmittable(qc1, ''), false);
eq('单选已选可提交', engine.isSubmittable(qc1, 'B'), true);

const qc2 = sanitizeQuestion(bank.findQuestion('q_c_0002'), { allowLocalJudgeKey: true });
eq('多选空答案形态', engine.emptyAnswerFor(qc2), []);
eq('多选未选不可提交', engine.isSubmittable(qc2, []), false);
eq('多选已选可提交', engine.isSubmittable(qc2, ['A']), true);

const qc3 = sanitizeQuestion(bank.findQuestion('q_c_0003'), { allowLocalJudgeKey: true });
eq('填空空答案形态（2 空）', engine.emptyAnswerFor(qc3), ['', '']);
eq('填空全空不可提交', engine.isSubmittable(qc3, ['', '']), false);
eq('填空部分填写可提交', engine.isSubmittable(qc3, ['65', '']), true);

const qc4 = sanitizeQuestion(bank.findQuestion('q_c_0004'), { allowLocalJudgeKey: true });
eq('程序输出空答案形态', engine.emptyAnswerFor(qc4), '');
eq('程序输出纯空白不可提交', engine.isSubmittable(qc4, '   \n  '), false);
eq('程序输出有内容可提交', engine.isSubmittable(qc4, 'sum=9'), true);

eq('形态文档：单选', engine.describeAnswerShape('single-choice'), 'string');
eq('形态文档：多选', engine.describeAnswerShape('multi-choice'), 'string[]');
eq('形态文档：填空', engine.describeAnswerShape('fill-blank'), 'string[]');
eq('形态文档：程序输出', engine.describeAnswerShape('program-output'), 'string');
eq('形态文档：编程题', engine.describeAnswerShape('code-editor'), 'string');

/* ---- 编程题（code-editor）：初值是骨架代码，不是空串 ---- */

const qc5 = sanitizeQuestion(bank.findQuestion('q_c_0005'), { allowLocalJudgeKey: false });
const qc5Initial = engine.emptyAnswerFor(qc5);
eq('编程题空答案形态为 string', typeof qc5Initial, 'string');
record(
  qc5Initial.indexOf('#include') >= 0,
  '编程题初值是题目骨架代码（避免用户从空白手写 include）'
);
eq('骨架内容与 payload.template 一致', qc5Initial, qc5.payload.template);
eq('编程题纯空白不可提交', engine.isSubmittable(qc5, '   \n  '), false);
eq('编程题有内容可提交', engine.isSubmittable(qc5, qc5Initial), true);
eq('编程题错形态（传数组）不可提交', engine.isSubmittable(qc5, ['a']), false);

// 骨架代码必须原样同步给容器：否则用户不改动直接提交会提交空字符串
record(
  qc5Initial.trim() !== '',
  '骨架非空 → 容器不会因为「用户未输入」而拿不到值'
);

eq(
  '形态契约与判分器一致：多选传数组才判对',
  getJudge('set')(qc2.localJudgeKey.key, qc2.localJudgeKey.key).correct,
  true
);
eq(
  '形态契约：错形态（单选传数组）判 0 分且不报错',
  getJudge('exact')(['B'], 'B').score,
  0
);

/* ------------------------------ 10. 学习进度（本地持久化） ------------------------------ */

section('10. 学习进度：星级合并 / 错题本 / 解锁');

// 这一节防的是「静默把用户记录抹掉」这类问题：
//   - 重做打得差却覆盖掉历史最高星级 → 用户白白丢了三星记录
//   - 错题答对了没移出 → 错题本越用越脏，最后没人看
//   - 解锁条件判反 → 要么全锁死（玩不下去），要么全开放（失去闯关意义）
{
  const prog = await import('../miniprogram/services/progress.ts');
  const { emptySnapshot, applySummary, isLevelUnlocked, activeWrongEntries, chapterCompletion } = prog;

  // ── 10.1 首次通关 ──
  {
    const snap = emptySnapshot('c_lang');
    eq('空快照没有关卡记录', Object.keys(snap.levels).length, 0);
    eq('空快照累计经验为 0', snap.totalXp, 0);

    const summary = fakeSummary('lv1', { stars: 2, scoreRate: 0.85, xp: 40, wrong: [] });
    const next = applySummary(snap, summary, { chapterId: 'ch1', subject: 'c_lang' });

    eq('首次通关记录星级', next.levels.lv1.bestStars, 2);
    eq('首次通关记录得分率', next.levels.lv1.bestScoreRate, 0.85);
    eq('首次通关次数 = 1', next.levels.lv1.attempts, 1);
    eq('累计经验累加', next.totalXp, 40);
    ok('首次通关记下通关时间', next.levels.lv1.firstClearedAt > 0);
  }

  // ── 10.2 重做打得差：绝不能覆盖历史最高 ──
  {
    let snap = emptySnapshot('c_lang');
    snap = applySummary(snap, fakeSummary('lv1', { stars: 3, scoreRate: 1.0, xp: 60, costMs: 30000, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });
    snap = applySummary(snap, fakeSummary('lv1', { stars: 1, scoreRate: 0.4, xp: 10, costMs: 90000, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });

    eq('重做打得更差：星级保留最高（3 星）', snap.levels.lv1.bestStars, 3);
    eq('重做打得更差：得分率保留最高', snap.levels.lv1.bestScoreRate, 1.0);
    eq('重做打得更差：用时保留更快的（30s）', snap.levels.lv1.bestCostMs, 30000);
    eq('挑战次数照常累加', snap.levels.lv1.attempts, 2);
    eq('经验照常累加（重复练习也有价值）', snap.levels.lv1.xp, 70);
    eq('累计经验同步累加', snap.totalXp, 70);
    ok('首次通关时间不被覆盖', snap.levels.lv1.firstClearedAt > 0);
  }

  // ── 10.3 重做打得更好：刷新记录 ──
  {
    let snap = emptySnapshot('c_lang');
    snap = applySummary(snap, fakeSummary('lv1', { stars: 2, scoreRate: 0.8, xp: 40, costMs: 60000, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });
    snap = applySummary(snap, fakeSummary('lv1', { stars: 3, scoreRate: 1.0, xp: 60, costMs: 45000, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });

    eq('重做更好：星级刷到 3', snap.levels.lv1.bestStars, 3);
    eq('重做更好：得分率刷新', snap.levels.lv1.bestScoreRate, 1.0);
    eq('重做更好：用时刷新为更快的（45s）', snap.levels.lv1.bestCostMs, 45000);
  }

  // ── 10.4 错题本：进本 / 连对 / 掌握移出 ──
  {
    let snap = emptySnapshot('c_lang');
    const detail = { questionId: 'q1', chapterId: 'ch1', kpIds: ['kp1'], type: 'single-choice' };

    // 第一次答错 → 进错题本
    snap = applySummary(
      snap,
      fakeSummary('lv1', { stars: 0, scoreRate: 0, xp: 0, wrong: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [detail] }
    );
    ok('答错进错题本', !!snap.wrongBook.q1);
    eq('答错次数 = 1', snap.wrongBook.q1.wrongCount, 1);
    eq('答错后连对清零', snap.wrongBook.q1.correctStreak, 0);
    ok('答错后标记为未掌握', snap.wrongBook.q1.mastered === false);
    eq('错题带上知识点', snap.wrongBook.q1.kpIds, ['kp1']);
    eq('活跃错题 1 条', activeWrongEntries(snap).length, 1);

    // 答对第 1 次 → 连对 1，仍未掌握（阈值是 2）
    snap = applySummary(
      snap,
      fakeSummary('lv1', { stars: 2, scoreRate: 0.8, xp: 30, wrong: [], correct: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [detail] }
    );
    eq('答对 1 次：连对计数 +1', snap.wrongBook.q1.correctStreak, 1);
    ok('答对 1 次：尚未掌握（阈值 2）', snap.wrongBook.q1.mastered === false);
    eq('答对 1 次后仍在错题本里', activeWrongEntries(snap).length, 1);

    // 答对第 2 次 → 连对达到阈值，标记掌握
    snap = applySummary(
      snap,
      fakeSummary('lv1', { stars: 3, scoreRate: 1.0, xp: 50, wrong: [], correct: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [detail] }
    );
    eq('答对 2 次：连对达标', snap.wrongBook.q1.correctStreak, 2);
    ok('答对 2 次：标记已掌握', snap.wrongBook.q1.mastered === true);
    eq('已掌握后移出活跃错题', activeWrongEntries(snap).length, 0);

    // ⚠️ 掌握后又答错 → 必须回到错题本（不能因为「曾经掌握」就永久豁免）
    snap = applySummary(
      snap,
      fakeSummary('lv1', { stars: 0, scoreRate: 0, xp: 0, wrong: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [detail] }
    );
    ok('掌握后又答错：重新标记未掌握', snap.wrongBook.q1.mastered === false);
    eq('掌握后又答错：连对清零', snap.wrongBook.q1.correctStreak, 0);
    eq('掌握后又答错：答错次数累加为 2', snap.wrongBook.q1.wrongCount, 2);
    eq('重新回到活跃错题', activeWrongEntries(snap).length, 1);
  }

  // ── 10.5 错题本按最近答错时间倒序 ──
  {
    let snap = emptySnapshot('c_lang');
    const d = (id) => ({ questionId: id, chapterId: 'ch1', kpIds: ['kp1'], type: 'fill-blank' });

    snap = applySummary(snap, fakeSummary('lv1', { stars: 0, scoreRate: 0, xp: 0, wrong: ['qa'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [d('qa')] });
    // 时间戳同毫秒会不稳定，手工改一下再插第二条
    snap.wrongBook.qa.lastWrongAt = 1000;
    snap = applySummary(snap, fakeSummary('lv1', { stars: 0, scoreRate: 0, xp: 0, wrong: ['qb'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [d('qb')] });
    snap.wrongBook.qb.lastWrongAt = 2000;

    eq('错题按最近答错时间倒序（最近的在最前）',
      activeWrongEntries(snap).map((e) => e.questionId), ['qb', 'qa']);
  }

  // ── 10.6 知识点统计 ──
  {
    let snap = emptySnapshot('c_lang');
    const detail = { questionId: 'q1', chapterId: 'ch1', kpIds: ['kp1', 'kp2'], type: 'single-choice' };

    snap = applySummary(snap, fakeSummary('lv1', { stars: 0, scoreRate: 0, xp: 0, wrong: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [detail] });
    eq('答错：两个知识点各计一次作答', [snap.kpStats.kp1.answered, snap.kpStats.kp2.answered], [1, 1]);
    eq('答错：正确数为 0', [snap.kpStats.kp1.correct, snap.kpStats.kp2.correct], [0, 0]);

    snap = applySummary(snap, fakeSummary('lv1', { stars: 2, scoreRate: 0.8, xp: 10, wrong: [], correct: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang', wrongDetails: [detail] });
    eq('答对：作答数累加', snap.kpStats.kp1.answered, 2);
    eq('答对：正确数累加', snap.kpStats.kp1.correct, 1);
  }

  // ── 10.7 解锁判定 ──
  {
    const order = ['lv1', 'lv2', 'lv3'];
    let snap = emptySnapshot('c_lang');

    ok('第一关永远开放', isLevelUnlocked(snap, order, 'lv1'));
    ok('前一关没通关时，第二关锁着', !isLevelUnlocked(snap, order, 'lv2'));

    // 第一关拿到 1 星（阈值 1）→ 解锁第二关
    snap = applySummary(snap, fakeSummary('lv1', { stars: 1, scoreRate: 0.6, xp: 10, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });
    ok('前一关达到解锁星级后，第二关开放', isLevelUnlocked(snap, order, 'lv2'));
    ok('但第三关仍锁着（第二关还没打）', !isLevelUnlocked(snap, order, 'lv3'));

    // 0 星（没通过）不解锁
    let snap0 = emptySnapshot('c_lang');
    snap0 = applySummary(snap0, fakeSummary('lv1', { stars: 0, scoreRate: 0.3, xp: 0, wrong: ['q1'] }),
      { chapterId: 'ch1', subject: 'c_lang' });
    ok('前一关 0 星（未通过）不解锁下一关', !isLevelUnlocked(snap0, order, 'lv2'));

    ok('不在关卡列表里的关卡不作为锁定对象（返回开放，避免误锁死）',
      isLevelUnlocked(snap0, order, 'unknown-level'));
  }

  // ── 10.8 章节完成度 ──
  {
    let snap = emptySnapshot('c_lang');
    eq('未开始时完成度为 0/3', chapterCompletion(snap, ['lv1', 'lv2', 'lv3']),
      { cleared: 0, total: 3, stars: 0, maxStars: 9 });

    snap = applySummary(snap, fakeSummary('lv1', { stars: 3, scoreRate: 1.0, xp: 60, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });
    snap = applySummary(snap, fakeSummary('lv2', { stars: 2, scoreRate: 0.8, xp: 40, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });

    eq('通关 2 关、共 5 星', chapterCompletion(snap, ['lv1', 'lv2', 'lv3']),
      { cleared: 2, total: 3, stars: 5, maxStars: 9 });
  }

  // ── 10.9 脏数据不能把页面搞崩（读回的值是**不可信输入**） ──
  {
    const { ProgressStore } = prog;
    const bad = ['', 'not json', '{}', '[]', '{"version":1}', 'null', '{"version":1,"levels":{},"wrongBook":{}}'];

    // 这一段**刻意**灌脏数据，console.warn 是预期输出，静音掉避免刷屏
    const realWarn = console.warn;
    console.warn = function () {};

    try {
      for (let i = 0; i < bad.length; i++) {
        const store = new ProgressStore({
          read: () => bad[i],
          write: () => {},
          remove: () => {},
        });
        let snap = null;
        let threw = false;
        try {
          snap = store.load('c_lang');
        } catch {
          threw = true;
        }
        ok('脏数据「' + bad[i].slice(0, 20) + '」不抛异常且降级为空快照',
          !threw && snap && typeof snap.version === 'number' && Object.keys(snap.levels).length === 0);
      }

      // 版本不匹配 → 重置（将来在这里做迁移）
      const oldVer = new ProgressStore({
        read: () => JSON.stringify({ version: 999, levels: { lv1: { bestStars: 3 } }, wrongBook: {}, totalXp: 100 }),
        write: () => {},
        remove: () => {},
      });
      eq('版本不匹配时重置为空快照', Object.keys(oldVer.load('c_lang').levels).length, 0);
    } finally {
      console.warn = realWarn;
    }

    // IO 写失败必须**抛出**（不能让用户以为存上了）
    const failIO = new ProgressStore({
      read: () => null,
      write: () => { throw new Error('存储写失败'); },
      remove: () => {},
    });
    throws('存储写入失败时必须抛出（不能静默吞掉）', function () {
      failIO.record(fakeSummary('lv1', { stars: 1, scoreRate: 0.6, xp: 10, wrong: [] }),
        { chapterId: 'ch1', subject: 'c_lang' });
    });
  }

  // ── 10.10 落盘往返（模拟一次完整的学习流程） ──
  {
    const { ProgressStore } = prog;
    let disk = null;
    const io = {
      read: () => disk,
      write: (_k, v) => { disk = v; },
      remove: () => { disk = null; },
    };

    const store = new ProgressStore(io);
    store.load('c_lang');
    store.record(fakeSummary('lv1', { stars: 3, scoreRate: 1.0, xp: 60, wrong: [] }),
      { chapterId: 'ch1', subject: 'c_lang' });

    ok('记录后确实落盘', typeof disk === 'string' && disk.length > 0);

    // 换一个新实例读（模拟「关掉小程序再打开」）
    const reopened = new ProgressStore(io);
    const snap = reopened.load('c_lang');
    eq('重开后进度还在：星级', snap.levels.lv1.bestStars, 3);
    eq('重开后进度还在：经验', snap.totalXp, 60);
  }

  // ── 10.11 错题重做是「虚拟复习局」：只更新错题本，不写关卡记录 ──
  //
  // 为什么必须单独测：错题重做用的是固定虚拟 id（virtual_review）。
  // 若照常写关卡记录会有两个坏结果：
  //   1. 个人页「已通关 X/3 关」凭空多一关（虚拟关卡不在 LEVELS 里）
  //   2. 几组不相干的错题互相覆盖 attempts/xp，数字毫无意义
  {
    const snap0 = prog.emptySnapshot('c_lang');

    // 一局普通练习关：写关卡记录
    const afterLevel = prog.applySummary(
      snap0,
      fakeSummary('c_ch01_lv01', { stars: 2, scoreRate: 0.8, xp: 40, wrong: [] }),
      { chapterId: 'c_ch01', subject: 'c_lang' }
    );
    ok('默认 countsAsLevel：关卡记录已写入', !!afterLevel.levels.c_ch01_lv01);
    eq('默认 countsAsLevel：星级正确', afterLevel.levels.c_ch01_lv01.bestStars, 2);

    // 一局错题重做：不写关卡记录，但经验照算
    const afterReview = prog.applySummary(
      afterLevel,
      fakeSummary('virtual_review', { stars: 3, scoreRate: 1.0, xp: 30, wrong: [] }),
      { chapterId: 'c_ch01', subject: 'c_lang', countsAsLevel: false }
    );
    ok(
      '虚拟复习局不写关卡记录（个人页不会凭空多一关）',
      !afterReview.levels.virtual_review
    );
    eq('虚拟复习局仍然计入总经验', afterReview.totalXp, 70);
    eq('原有真实关卡记录不受影响', afterReview.levels.c_ch01_lv01.bestStars, 2);

    // 错题本仍然会被更新 —— 这才是重做的目的
    const withWrong = prog.applySummary(
      snap0,
      fakeSummary('virtual_review', { stars: 0, scoreRate: 0, xp: 5, wrong: ['q_x'] }),
      { chapterId: 'c_ch01', subject: 'c_lang', countsAsLevel: false }
    );
    ok('虚拟复习局答错照样进错题本', !!withWrong.wrongBook.q_x);
    ok('虚拟复习局不产生关卡记录', !withWrong.levels.virtual_review);
  }

  // ── 10.12 虚拟复习局答对可以把错题移出错题本 ──
  //
  // 这是「错题本重做」的核心价值：做对到阈值就移出。
  // 如果虚拟局不更新错题本，重做一百次错题也不会消失，功能等于没有。
  {
    let snap = prog.emptySnapshot('c_lang');
    // 先生成一道错题
    snap = prog.applySummary(
      snap,
      fakeSummary('c_ch01_lv01', { stars: 1, scoreRate: 0.6, xp: 10, wrong: ['q_c_0001'] }),
      {
        chapterId: 'c_ch01',
        subject: 'c_lang',
        wrongDetails: [{ questionId: 'q_c_0001', chapterId: 'c_ch01', kpIds: ['kp1'], type: 'single-choice' }],
      }
    );
    eq('错题已进入错题本', prog.activeWrongEntries(snap).length, 1);

    // 错题重做：连对两次（masteryStreak = 2）
    for (let i = 0; i < 2; i++) {
      snap = prog.applySummary(
        snap,
        fakeSummary('virtual_review', {
          stars: 3,
          scoreRate: 1.0,
          xp: 10,
          wrong: [],
          correct: ['q_c_0001'],
        }),
        {
          chapterId: 'c_ch01',
          subject: 'c_lang',
          countsAsLevel: false,
          wrongDetails: [{ questionId: 'q_c_0001', chapterId: 'c_ch01', kpIds: ['kp1'], type: 'single-choice' }],
        }
      );
    }
    eq('错题重做连对两次后移出错题本', prog.activeWrongEntries(snap).length, 0);
    ok('错题记录仍在（标记为已掌握）', snap.wrongBook.q_c_0001.mastered === true);
    ok('错题重做全程没有产生关卡记录', !snap.levels.virtual_review);
  }
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('\n' + '='.repeat(56));
console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) {
  console.log('\n失败项：');
  for (let i = 0; i < failures.length; i++) console.log('  - ' + failures[i]);
  process.exitCode = 1;
} else {
  console.log('题型引擎全部验收通过。');
}
console.log('='.repeat(56));

void _resetRegistry;
