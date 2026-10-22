/**
 * 接线自检
 *
 * 为什么需要它：小程序里「注册表里有题型、但组件文件没建」「wx:if 分发链漏了一个分支」
 * 这类错误不会编译报错，只会静默白屏或渲染出「未注册的题型」。
 * 用脚本把这类问题挡在提交之前。
 *
 * 运行：node tests/wiring.test.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MP = path.join(ROOT, 'miniprogram');

const engine = await import('../miniprogram/engine/index.ts');
const { registerBuiltinJudges } = await import('../miniprogram/engine/judges/index.ts');
const bank = await import('../miniprogram/mock/bank.ts');

registerBuiltinJudges();
engine.bootstrapEngine();

let passCount = 0;
let failCount = 0;
const failures = [];

function ok(name) {
  passCount++;
  console.log('  \u2713 ' + name);
}

function bad(name, why) {
  failCount++;
  failures.push(name + (why ? ' — ' + why : ''));
  console.log('  \u2717 ' + name + (why ? ' — ' + why : ''));
}

function check(name, cond, why) {
  if (cond) ok(name);
  else bad(name, why);
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function section(t) {
  console.log('\n' + t);
}

/* --------------------- 1. 渲染器注册表 vs 组件文件 --------------------- */

section('1. 渲染器注册表 ↔ 组件文件');

const renderers = engine.listRenderers();
check('渲染器数量 > 0', renderers.length > 0, '注册表为空');

const containerJson = readJson('miniprogram/components/question/index.json');
const containerWxml = read('miniprogram/components/question/index.wxml');
const usingComponents = containerJson.usingComponents || {};

for (const meta of renderers) {
  const dir = 'miniprogram/components/question/renderers/' + meta.type;
  for (const ext of ['.ts', '.wxml', '.wxss', '.json']) {
    check(
      '文件存在 ' + meta.type + ext,
      existsSync(path.join(ROOT, dir + '/index' + ext)),
      '缺少 ' + dir + '/index' + ext
    );
  }

  check(
    '容器已声明子组件 ' + meta.type,
    Object.prototype.hasOwnProperty.call(usingComponents, meta.type),
    'components/question/index.json 的 usingComponents 里没有 ' + meta.type
  );

  check(
    '分发链包含 ' + meta.type,
    containerWxml.indexOf("renderer === '" + meta.type + "'") >= 0,
    'index.wxml 的 wx:if 链缺少 ' + meta.type
  );

  check(
    '组件 json 声明为 component ' + meta.type,
    readJson(dir + '/index.json').component === true
  );
}

/* --------------------- 2. 题型的判分器覆盖 --------------------- */

section('2. 题型 ↔ 判分器覆盖');

for (const meta of renderers) {
  for (const strategy of meta.judgeStrategies) {
    check(
      meta.type + ' 的判分器 ' + strategy + ' 已注册',
      engine.hasJudge(strategy),
      '判分器 ' + strategy + ' 未注册'
    );
  }
}

for (const q of bank.QUESTIONS) {
  check(
    '题目 ' + q.id + ' 的题型已注册',
    !!engine.getRenderer(q.type),
    '题型 ' + q.type + ' 无渲染器'
  );
  check(
    '题目 ' + q.id + ' 的判分策略已注册',
    engine.hasJudge(q.judge.strategy),
    '策略 ' + q.judge.strategy + ' 无判分器'
  );
  check(
    '题目 ' + q.id + ' 带版权台账',
    !!(q.source && q.source.type),
    '缺少 source 字段（版权合规要求）'
  );
  check(
    '题目 ' + q.id + ' 为已发布状态',
    q.status === 'published',
    'status = ' + String(q.status)
  );
}

/* --------------------- 3. 页面与组件路径可解析 --------------------- */

section('3. 页面与组件路径');

const appJson = readJson('miniprogram/app.json');
for (const page of appJson.pages) {
  for (const ext of ['.ts', '.wxml', '.wxss', '.json']) {
    check('页面文件存在 ' + page + ext, existsSync(path.join(MP, page + ext)));
  }
}

for (const page of appJson.pages) {
  const json = readJson('miniprogram/' + page + '.json');
  const comps = json.usingComponents || {};
  for (const tag of Object.keys(comps)) {
    const p = comps[tag];
    const rel = p.startsWith('/') ? p.slice(1) : path.posix.join(path.posix.dirname(page), p);
    check('组件路径可解析 ' + tag + ' → ' + p, existsSync(path.join(MP, rel + '.wxml')), '找不到 ' + rel);
  }
}

for (const key of Object.keys(usingComponents)) {
  const rel = usingComponents[key].replace('./', 'components/question/');
  check('子组件路径可解析 ' + key, existsSync(path.join(MP, rel + '.wxml')), '找不到 ' + rel);
}

/* --------------------- 4. 取题剔除链路 --------------------- */

section('4. 答案不下发链路');

for (const level of bank.LEVELS) {
  const allowLocal = level.mode === 'practice' || level.mode === 'review';
  for (const qid of level.questionIds) {
    const full = bank.findQuestion(qid);
    const client = engine.sanitizeQuestion(full, { allowLocalJudgeKey: allowLocal });
    const json = JSON.stringify(client);

    check(
      '[' + level.id + '] ' + qid + ' 无 answer',
      json.indexOf('"answer"') < 0
    );
    check(
      '[' + level.id + '] ' + qid + ' 无 judge 策略',
      json.indexOf('"judge"') < 0
    );
    check(
      '[' + level.id + '] ' + qid + (allowLocal ? ' 下发判分依据' : ' 不下发判分依据'),
      allowLocal ? !!client.localJudgeKey : !client.localJudgeKey
    );
  }
}

/* --------------------- 5. 编程题链路专项 --------------------- */

section('5. 编程题（code-editor）链路');

// 编程题必须走服务端判分：不能出现在任何允许本地判分的关卡里
for (const level of bank.LEVELS) {
  const allowLocal = level.mode === 'practice' || level.mode === 'review';
  for (const qid of level.questionIds) {
    const q = bank.findQuestion(qid);
    if (!q || q.type !== 'code-editor') continue;
    check(
      '[' + level.id + '] 编程题 ' + qid + ' 不在允许本地判分的关卡',
      !allowLocal,
      '编程题出现在 ' + level.mode + ' 关，会下发测试点'
    );
    check(
      '[' + level.id + '] 编程题 ' + qid + ' 判分策略为 sandbox',
      q.judge.strategy === 'sandbox',
      '实际 ' + q.judge.strategy
    );
    check(
      '编程题 ' + qid + ' 带代码骨架（避免从空白手写 include）',
      !!(q.payload && typeof q.payload.template === 'string' && q.payload.template.length > 0)
    );
    check(
      '编程题 ' + qid + ' 声明语言',
      !!(q.payload && typeof q.payload.language === 'string')
    );
  }
}

// 服务端策略占位判分器必须存在（供覆盖自检），但必须标为 remote
check('sandbox 占位判分器已注册', engine.hasJudge('sandbox'));
check('ai 占位判分器已注册', engine.hasJudge('ai'));

const engineJudge = await import('../miniprogram/services/judge.ts');

// 策略映射表必须与渲染器注册表一致
for (const meta of renderers) {
  const mapped = engineJudge.judgeStrategyOf({ type: meta.type, payload: {} });
  check(
    '题型 ' + meta.type + ' 的策略映射与渲染器声明一致',
    meta.judgeStrategies.indexOf(mapped) >= 0,
    '映射得 ' + mapped + '，渲染器声明 [' + meta.judgeStrategies.join(',') + ']'
  );
}

// 编程题必须有对应的服务端判题计划（否则提交必然失败）
const mockPlans = await import('../judge-service/src/questions/mock-plans.ts');
const planIndex = mockPlans.indexPlans();
for (const q of bank.QUESTIONS) {
  if (q.type !== 'code-editor') continue;
  const lang = q.payload && q.payload.language ? q.payload.language : 'c';
  check(
    '编程题 ' + q.id + ' 有对应的服务端判题计划',
    !!planIndex[q.id + '::' + lang],
    '缺少 judge_plans 记录，提交会返回 question-not-found'
  );
}

// 判题计划必须至少有一个隐藏测试点（防硬编码通过）
for (const key of Object.keys(planIndex)) {
  const plan = planIndex[key];
  const hidden = plan.cases.filter((c) => c.hidden).length;
  check(
    '判题计划 ' + key + ' 含隐藏测试点',
    hidden > 0,
    '全部测试点公开，用户可硬编码答案通过'
  );
  check(
    '判题计划 ' + key + ' 测试点序号连续',
    plan.cases.every((c, i) => c.index === i + 1),
    '序号不连续会导致错误提示行号错乱'
  );
}

/* --------------------- 6. 题库内容合规（录题闸门） --------------------- */

section('6. 题库内容合规（录题闸门）');

/**
 * 为什么把它放进 CI 而不只是 scripts：
 *
 *   `scripts/check-bank.mjs` 是**录题时**跑的工具（输出详细、逐条列表）；
 *   这里放进 CI 是**提交时**的闸门（只要有一条不合规就红）。
 *
 * 两者共用同一份校验逻辑（miniprogram/mock/bank-validator.ts），
 * 所以规则不会出现「工具说没问题、CI 说有问题」的漂移。
 *
 * 覆盖的错误类型（每一条都对应一类真实翻车）：
 *   - 选择题答案不在选项里 → 用户怎么选都判错
 *   - 填空空位数与答案组数不一致 → 某几空永远是错的
 *   - 关卡引用不存在的题目 → 进关白屏
 *   - 缺版权台账 → 提审逐题被驳回
 *   - 解析为空 → 错题本点开是空白
 */
const { validateBank, summarizeIssues } = await import('../miniprogram/mock/bank-validator.ts');

const bankIssues = validateBank({
  subjects: bank.SUBJECTS,
  chapters: bank.CHAPTERS,
  knowledgePoints: bank.KNOWLEDGE_POINTS,
  levels: bank.LEVELS,
  questions: bank.QUESTIONS,
});

check(
  '题库校验通过（' + bank.QUESTIONS.length + ' 题 / ' + bank.LEVELS.length + ' 关）',
  bankIssues.length === 0,
  '发现 ' + bankIssues.length + ' 个问题：' + summarizeIssues(bankIssues) +
    '\n      ' + bankIssues.slice(0, 8).map((i) => '[' + i.kind + '] ' + i.message).join('\n      ')
);

// 6.1 每个知识点都必须有题。
//     空知识点在错题本/进度统计里表现为「这个知识点永远 0 题」，
//     章节副标题却印着它的名字 —— 用户会以为是题没加载出来。
{
  const kpCount = {};
  for (const q of bank.QUESTIONS) {
    for (const kp of q.kpIds || []) kpCount[kp] = (kpCount[kp] || 0) + 1;
  }
  for (const kp of bank.KNOWLEDGE_POINTS) {
    check(
      '知识点「' + kp.name + '」至少有 3 道题',
      (kpCount[kp.id] || 0) >= 3,
      '实际 ' + (kpCount[kp.id] || 0) + ' 题 —— 太少撑不起一个练习关'
    );
  }
}

// 6.2 每个练习关的题量必须够（3 题以下用户 1 分钟就打完了，体验上等于没内容）
for (const lv of bank.LEVELS) {
  check(
    '[' + lv.id + '] 题量 ≥ 3',
    lv.questionIds.length >= 3,
    '只有 ' + lv.questionIds.length + ' 题'
  );
}

// 6.3 复习关必须真的跨知识点（否则它就只是又一个练习关）
{
  const review = bank.LEVELS.filter((l) => l.mode === 'review');
  check('至少有一个复习关', review.length > 0, '缺少复习关，间隔复习的设计落空');
  for (const lv of review) {
    const kps = new Set();
    for (const qid of lv.questionIds) {
      const q = bank.findQuestion(qid);
      if (q) for (const kp of q.kpIds) kps.add(kp);
    }
    check(
      '[' + lv.id + '] 复习关覆盖 ≥ 4 个知识点',
      kps.size >= 4,
      '只覆盖 ' + kps.size + ' 个 —— 起不到「混着练」的作用'
    );
  }
}

// 6.4 一道题不能同时出现在「练习关」和「编程关」里 ——
//     练习关会下发本地判分依据，而编程题必须服务端判分，两者互斥。
{
  const localLevels = bank.LEVELS.filter((l) => l.mode === 'practice' || l.mode === 'review');
  const remoteLevels = bank.LEVELS.filter((l) => l.mode === 'boss' || l.mode === 'challenge');
  const localIds = new Set();
  for (const l of localLevels) for (const q of l.questionIds) localIds.add(q);
  const overlap = [];
  for (const l of remoteLevels) {
    for (const q of l.questionIds) if (localIds.has(q)) overlap.push(l.id + '/' + q);
  }
  check(
    '同一道题不在「本地判分关」与「服务端判分关」里重复出现',
    overlap.length === 0,
    '重叠：' + overlap.join(', ') + ' —— 会导致同一题在两种关卡里判分口径不一致'
  );
}

// 6.5 难度分布不能全是同一个档。
//     全难度 3 的话，新手第一关就被劝退；全难度 1 则没有挑战。
{
  const diff = {};
  for (const q of bank.QUESTIONS) diff[q.difficulty] = (diff[q.difficulty] || 0) + 1;
  const distinct = Object.keys(diff).length;
  check(
    '题库难度至少有 3 个档位',
    distinct >= 3,
    '实际只有 ' + distinct + ' 档：' + JSON.stringify(diff)
  );
}

/* --------------------- 7. 学习闭环接线 --------------------- */

section('7. 学习闭环（进度 / 错题本 / 结果页）');

// 7.1 页面注册与入口按钮的跳转目标必须一致。
//     坑：按钮写了 /pages/wrong/wrong，但 app.json 忘了注册 →
//     真机上点击无反应（开发者工具里可能只是警告），用户会以为「按钮坏了」。
const registeredPages = appJson.pages;
const indexWxml = read('miniprogram/pages/index/index.wxml');
const profileTs = read('miniprogram/pages/profile/profile.ts');

check('错题本页已注册', registeredPages.indexOf('pages/wrong/wrong') >= 0);
check('我的页已注册', registeredPages.indexOf('pages/profile/profile') >= 0);

// 从 wxml/ts 里抠出所有 navigateTo 的 url，逐个校验目标页已注册
function collectNavTargets(src) {
  const out = [];
  const re = /\/pages\/[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[0]);
  return out;
}

const navSources = {
  'index.wxml': indexWxml,
  'index.ts': read('miniprogram/pages/index/index.ts'),
  'profile.ts': profileTs,
  'wrong.ts': read('miniprogram/pages/wrong/wrong.ts'),
  'level.ts': read('miniprogram/pages/level/level.ts'),
};

for (const [file, src] of Object.entries(navSources)) {
  const targets = collectNavTargets(src);
  for (const t of new Set(targets)) {
    const pagePath = t.replace(/^\//, '');
    check(
      file + ' 跳转目标已注册 ' + t,
      registeredPages.indexOf(pagePath) >= 0,
      'app.json 里没有 ' + pagePath
    );
  }
}

// 7.2 进度层必须保持「纯逻辑」：文件里不能出现 wx. 调用之外的框架依赖。
//     一旦有人图省事在 progress.ts 里 import 题库，Node 侧测试就废了。
const progressSrc = read('miniprogram/services/progress.ts');
check(
  'progress.ts 不依赖题库（保持可在 Node 测试）',
  progressSrc.indexOf('mock/bank') < 0,
  'progress.ts 不应 import 题库'
);
check(
  'progress.ts 也不依赖页面/组件',
  progressSrc.indexOf('pages/') < 0 && progressSrc.indexOf('components/') < 0
);

// 7.3 存储键隔离：主题偏好与进度快照必须是两个键。
//     否则「重置进度」会把用户的深色模式选择一起清掉。
const storeSrc = read('miniprogram/store/index.ts');
check(
  '主题偏好与进度快照使用不同的存储键',
  storeSrc.indexOf("'xxgk:theme:v1'") >= 0
);

// 7.4 结果页必须先落盘再渲染：否则快速返回首页会看到旧星级。
const levelTs = read('miniprogram/pages/level/level.ts');
const recordIdx = levelTs.indexOf('progressStore.record(');
const setDataFinishedIdx = levelTs.indexOf('finished: true');
check(
  '答题页先落盘再渲染结果页',
  recordIdx > 0 && setDataFinishedIdx > 0 && recordIdx < setDataFinishedIdx,
  'progressStore.record 必须在 setData({finished:true}) 之前'
);

// 7.5 存储写失败必须有可见反馈（静默丢进度是最糟的体验）
check(
  '答题页对保存失败有可见提示',
  levelTs.indexOf('saveFailed') >= 0 &&
    read('miniprogram/pages/level/level.wxml').indexOf('saveFailed') >= 0
);

// 7.6 掌握阈值只能来自配置，不能散落在页面里写死
//     扫 wxml 里的裸数字 2（「做对 2 次」），防止文案与配置脱节
const wrongWxml = read('miniprogram/pages/wrong/wrong.wxml');
check(
  '错题本页的掌握阈值来自配置而非硬编码',
  wrongWxml.indexOf('masteryStreak') >= 0 && wrongWxml.indexOf('做对 2 次') < 0
);

// 7.7 错题重做走的是「合成复习关」，必须带 ids 参数且页面支持该入口
const questionSrc = read('miniprogram/services/question.ts');
check('取题服务提供按 id 批量取题（错题重做用）', questionSrc.indexOf('fetchQuestionsByIds') >= 0);
check('答题页支持 ids 入口（错题重做）', levelTs.indexOf('options.ids') >= 0);
check(
  '错题本「重做」按钮指向答题页且带 ids',
  wrongWxml.indexOf('onRedoGroup') >= 0 && read('miniprogram/pages/wrong/wrong.ts').indexOf("'/pages/level/level?ids='") >= 0
);

// 7.8 重置进度必须二次确认（破坏性操作）
check(
  '重置进度有二次确认弹窗',
  profileTs.indexOf('showModal') >= 0 && profileTs.indexOf('progressStore.reset') >= 0
);

// 7.9 虚拟复习局不得写入关卡记录（否则个人页「已通关 X/3 关」凭空多一关）
check(
  '错题重做标记为非关卡（不污染通关数）',
  levelTs.indexOf('countsAsLevel') >= 0 &&
    read('miniprogram/services/progress.ts').indexOf('countsAsLevel') >= 0
);

// 7.10 页面自检脚本必须被 npm test 串上——加了测试却没进 CI 等于没加
const pkgJson = readJson('package.json');
check(
  'npm test 已包含页面逻辑自检',
  String(pkgJson.scripts.test).indexOf('pages.test.mjs') >= 0
);
check('页面自检脚本确实存在', existsSync(path.join(ROOT, 'tests/pages.test.mjs')));

// 7.11 页面上用到的 class 必须有样式定义。
//      坑：页面 wxss 是**页面级作用域**，在别的页面定义的类不会生效。
//      所以「复用了另一个页面的类名」会静默失效 —— 不报错、不警告，只是没样式。
//      这类问题肉眼极难发现（样式缺失通常表现为「就是有点丑」，说不上哪里不对）。
{
  const globalCss = read('miniprogram/styles/reset.wxss') + read('miniprogram/styles/variables.wxss');
  const globalClasses = new Set();
  const gcRe = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let gm;
  while ((gm = gcRe.exec(globalCss)) !== null) globalClasses.add(gm[1]);

  for (const page of appJson.pages) {
    const wxml = read('miniprogram/' + page + '.wxml');
    const wxss = read('miniprogram/' + page + '.wxss');
    const used = new Set();
    const cRe = /class="([^"]*)"/g;
    let m;
    while ((m = cRe.exec(wxml)) !== null) {
      for (const raw of m[1].split(/\s+/)) {
        // 只取纯类名，跳过 {{...}} 表达式片段
        if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(raw)) used.add(raw);
      }
    }
    const missing = [];
    for (const c of used) {
      if (wxss.indexOf('.' + c) >= 0) continue;
      if (globalClasses.has(c)) continue;
      missing.push(c);
    }
    check(
      '页面样式覆盖完整 ' + page,
      missing.length === 0,
      '缺少样式的类：' + missing.join(', ')
    );
  }
}

/* --------------------- 8. 主包体积内控 --------------------- */

section('8. 主包体积内控（1.5MB 阈值）');

function walk(dir) {
  let total = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      total += walk(full);
    } else {
      total += statSync(full).size;
    }
  }
  return total;
}

const mainBytes = walk(MP);
const mainKb = Math.round(mainBytes / 1024);
console.log('  主包源码体积：约 ' + mainKb + ' KB（含 mock 题库，上线前需移出）');
check('主包体积内控 1.5MB', mainBytes < 1.5 * 1024 * 1024, mainKb + ' KB 已超阈值');

const report = engine.rendererSizeReport();
check(
  '无超过 300KB 未分包的渲染器',
  report.oversize.length === 0,
  report.oversize.map((r) => r.type).join(',')
);

/* --------------------- 汇总 --------------------- */

console.log('\n' + '='.repeat(56));
console.log('通过 ' + passCount + ' 项，失败 ' + failCount + ' 项');
if (failCount > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('接线自检全部通过。');
}
console.log('='.repeat(56));
