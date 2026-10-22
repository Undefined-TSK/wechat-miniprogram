/**
 * ⚠️ 模拟题库 —— 仅用于本地开发与验收演示
 *
 * 生产环境这个文件**不应存在于客户端**：它等价于云数据库的 questions 集合，
 * 必须只在云函数侧存在，客户端通过 getLevelQuestions 云函数取得剔除后的数据。
 * 上线前请删除本目录，或加入 project.config.json 的 packOptions.ignore。
 *
 * ── 目录结构 ─────────────────────────────────────────────────────────
 *
 *   bank.ts                 本文件：科目 / 章节 / 知识点 / 关卡 / 汇总
 *   questions/kp1-int-div.ts       知识点 1 题目
 *   questions/kp2-sizeof.ts        知识点 2 题目
 *   questions/kp3-char-promotion.ts 知识点 3 题目
 *   questions/kp4-loop-control.ts  知识点 4 题目
 *   questions/kp5-logic-ops.ts     知识点 5 题目
 *   questions/kp6-incdec.ts        知识点 6 题目
 *   questions/kp7-bitwise.ts       知识点 7 题目
 *   questions/kp8-array.ts         知识点 8 题目
 *   questions/code-questions.ts    编程题（走服务端判分）
 *
 * 一个知识点一个文件，好处是：
 *   - 录题时冲突面小（两个人可以同时改不同文件）
 *   - 查问题定位快（题目 id 前缀 + 文件名直接对应）
 *   - 单文件不会膨胀到几千行
 *
 * ── 录题纪律 ─────────────────────────────────────────────────────────
 *
 * 新增或修改题目后**必须**跑：
 *   node scripts/check-bank.mjs --stats
 * 它会检查题型/策略匹配、答案是否在选项里、填空空位数与答案组数是否一致、
 * 关卡引用是否悬空、版权台账是否完整等等（详见 bank-validator.ts）。
 * `tests/wiring.test.mjs` 里也有同一条闸门，提交时自动跑。
 */

import type { FullQuestion, LevelDef } from '../engine/types';

import { KP1_QUESTIONS } from './questions/kp1-int-div';
import { KP2_QUESTIONS } from './questions/kp2-sizeof';
import { KP3_QUESTIONS } from './questions/kp3-char-promotion';
import { KP4_QUESTIONS } from './questions/kp4-loop-control';
import { KP5_QUESTIONS } from './questions/kp5-logic-ops';
import { KP6_QUESTIONS } from './questions/kp6-incdec';
import { KP7_QUESTIONS } from './questions/kp7-bitwise';
import { KP8_QUESTIONS } from './questions/kp8-array';
import { CODE_QUESTIONS } from './questions/code-questions';
import { BOSS_QUESTIONS } from './questions/boss-questions';

export interface SubjectDef {
  id: string;
  name: string;
  desc: string;
}

export interface ChapterDef {
  id: string;
  subjectId: string;
  name: string;
  order: number;
}

export interface KnowledgePointDef {
  id: string;
  chapterId: string;
  name: string;
}

export const SUBJECTS: SubjectDef[] = [
  { id: 'c_lang', name: 'C 语言', desc: '10 种题型 · 数据驱动引擎' },
  { id: 'cet4', name: '英语四级', desc: '听力 / 阅读 / 写作（待扩科）' },
  { id: 'cet6', name: '英语六级', desc: '听力 / 阅读 / 写作（待扩科）' },
  { id: 'math', name: '高等数学', desc: 'LaTeX 公式（待扩科）' },
  { id: 'linalg', name: '线性代数', desc: '矩阵运算（待扩科）' },
];

export const CHAPTERS: ChapterDef[] = [
  { id: 'c_ch01', subjectId: 'c_lang', name: '第一章 · 运算符与数据类型', order: 1 },
];

/**
 * 知识点顺序 = 学习顺序 = 关卡顺序。
 * `pages/index` 的章节副标题由这张表拼出，所以名字要能连读。
 */
export const KNOWLEDGE_POINTS: KnowledgePointDef[] = [
  { id: 'kp_c_operator_int_div', chapterId: 'c_ch01', name: '整数除法与取模' },
  { id: 'kp_c_sizeof', chapterId: 'c_ch01', name: 'sizeof 运算符' },
  { id: 'kp_c_char_type', chapterId: 'c_ch01', name: '字符常量与整型提升' },
  { id: 'kp_c_loop_continue', chapterId: 'c_ch01', name: '循环控制 continue' },
  { id: 'kp_c_logic_ops', chapterId: 'c_ch01', name: '关系与逻辑运算' },
  { id: 'kp_c_incdec', chapterId: 'c_ch01', name: '自增自减与副作用' },
  { id: 'kp_c_bitwise', chapterId: 'c_ch01', name: '位运算入门' },
  { id: 'kp_c_array_basic', chapterId: 'c_ch01', name: '数组入门' },
];

/* ================================================================== */
/*  关卡（顺序即解锁顺序，第 1 关默认解锁）                             */
/* ================================================================== */

/**
 * 关卡编号策略：
 *   lv01..lv08  每个知识点一个练习关（允许本地判分）
 *   复习关        串联前 4 个知识点，模式 review
 *   boss         混合难题，限时，服务端判分
 *   code         编程关，全部走沙箱
 */

/** 练习关 1：整数除法与取模 */
const LV01: LevelDef = {
  id: 'c_ch01_lv01',
  chapterId: 'c_ch01',
  name: '整数除法与取模',
  mode: 'practice',
  questionIds: ['q_c_0001', 'q_c_0007', 'q_c_0008', 'q_c_0009', 'q_c_0010'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 2：sizeof 运算符 */
const LV02: LevelDef = {
  id: 'c_ch01_lv02',
  chapterId: 'c_ch01',
  name: 'sizeof 运算符',
  mode: 'practice',
  questionIds: ['q_c_0002', 'q_c_0011', 'q_c_0012', 'q_c_0013', 'q_c_0014'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 3：字符常量与整型提升 */
const LV03: LevelDef = {
  id: 'c_ch01_lv03',
  chapterId: 'c_ch01',
  name: '字符常量与整型提升',
  mode: 'practice',
  questionIds: ['q_c_0003', 'q_c_0015', 'q_c_0016', 'q_c_0017', 'q_c_0018'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 4：循环控制 continue / break */
const LV04: LevelDef = {
  id: 'c_ch01_lv04',
  chapterId: 'c_ch01',
  name: '循环控制 continue',
  mode: 'practice',
  questionIds: ['q_c_0004', 'q_c_0019', 'q_c_0020', 'q_c_0021', 'q_c_0022'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 5：关系与逻辑运算 */
const LV05: LevelDef = {
  id: 'c_ch01_lv05',
  chapterId: 'c_ch01',
  name: '关系与逻辑运算',
  mode: 'practice',
  questionIds: ['q_c_0023', 'q_c_0024', 'q_c_0025', 'q_c_0026', 'q_c_0027'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 6：自增自减与副作用 */
const LV06: LevelDef = {
  id: 'c_ch01_lv06',
  chapterId: 'c_ch01',
  name: '自增自减与副作用',
  mode: 'practice',
  questionIds: ['q_c_0028', 'q_c_0029', 'q_c_0030', 'q_c_0031', 'q_c_0032'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 7：位运算入门 */
const LV07: LevelDef = {
  id: 'c_ch01_lv07',
  chapterId: 'c_ch01',
  name: '位运算入门',
  mode: 'practice',
  questionIds: ['q_c_0033', 'q_c_0034', 'q_c_0035', 'q_c_0036', 'q_c_0037'],
  starThresholds: [0.6, 0.8, 1.0],
};

/** 练习关 8：数组入门 */
const LV08: LevelDef = {
  id: 'c_ch01_lv08',
  chapterId: 'c_ch01',
  name: '数组入门',
  mode: 'practice',
  questionIds: ['q_c_0038', 'q_c_0039', 'q_c_0040', 'q_c_0041', 'q_c_0042'],
  starThresholds: [0.6, 0.8, 1.0],
};

/**
 * 复习关：跨知识点串联。
 *
 * 用途是**间隔复习**——不同知识点的题混在一起，用户必须真的分得清「这题考哪个规则」，
 * 而不是靠题目顺序猜。这是「刷一遍就忘」和「记住了」的分界线。
 */
const REVIEW: LevelDef = {
  id: 'c_ch01_review',
  chapterId: 'c_ch01',
  name: '复习关 · 运算符综合',
  mode: 'review',
  questionIds: ['q_c_0007', 'q_c_0012', 'q_c_0016', 'q_c_0020', 'q_c_0025', 'q_c_0030', 'q_c_0034', 'q_c_0040'],
  starThresholds: [0.6, 0.8, 1.0],
};

/**
 * Boss 关：不下发 localJudgeKey，必须服务端判分；限时。
 *
 * ⚠️ Boss 关的题**必须与练习关/复习关完全互斥**（见 boss-questions.ts 的说明）：
 *    Boss 关不下发本地判分依据，而服务端目前只认编程题的 sandbox 入口，
 *    所以把练习关的选择题搬进 Boss 关 = 用户答对也判 0 分。
 *    `bank-validator.ts` 有一条专门校验，`tests/wiring.test.mjs` 会强制执行。
 *
 * 题目全部是「陷阱密度更高」的题，而且打散知识点顺序 —— Boss 关考的不是记忆，
 * 是在压力下还能不能识别出陷阱。
 */
const BOSS: LevelDef = {
  id: 'c_ch01_boss',
  chapterId: 'c_ch01',
  name: 'Boss 关 · 运算符陷阱终极考验',
  mode: 'boss',
  questionIds: ['q_c_0050', 'q_c_0051', 'q_c_0052', 'q_c_0053', 'q_c_0054', 'q_c_0055'],
  starThresholds: [0.6, 0.8, 1.0],
  timeLimitMs: 10 * 60 * 1000,
};

/**
 * 编程关：全部是编程题，每一道都必须走判题服务。
 *
 * 这个关卡的用途是**打通 L2 判题链路**：
 *   客户端取题（无判分依据）→ 用户写代码 → 云函数中转 → 判题服务沙箱 → 结构化判题结论
 *
 * ⚠️ 未部署判题服务时，本关提交会返回「判题服务繁忙」——
 *    这是预期行为，不是 bug。验收方式见 docs 的判题服务章节。
 */
const CODE: LevelDef = {
  id: 'c_ch01_code',
  chapterId: 'c_ch01',
  name: '编程关 · 手写代码',
  mode: 'challenge',
  questionIds: ['q_c_0005', 'q_c_0043', 'q_c_0044', 'q_c_0045', 'q_c_0006'],
  starThresholds: [0.6, 0.8, 1.0],
};

export const LEVELS: LevelDef[] = [
  LV01, LV02, LV03, LV04, LV05, LV06, LV07, LV08,
  REVIEW, BOSS, CODE,
];

/* 兼容旧引用：单关常量曾在 app 里被直接 import */
export const PRACTICE_LEVEL = LV01;
export const CODE_LEVEL = CODE;
export const BOSS_LEVEL = BOSS;

/* ================================================================== */
/*  题目汇总                                                           */
/* ================================================================== */

/**
 * ⚠️ 顺序无关紧要（页面按 LEVELS 的 questionIds 取题），
 *    但保持「按 id 递增」便于人工 review 时定位。
 */
export const QUESTIONS: FullQuestion[] = [
  ...KP1_QUESTIONS,
  ...KP2_QUESTIONS,
  ...KP3_QUESTIONS,
  ...KP4_QUESTIONS,
  ...KP5_QUESTIONS,
  ...KP6_QUESTIONS,
  ...KP7_QUESTIONS,
  ...KP8_QUESTIONS,
  ...CODE_QUESTIONS,
  ...BOSS_QUESTIONS,
];

/* ================================================================== */
/*  索引与查询                                                         */
/* ================================================================== */

/** id → 题目。启动时建一次，避免 findQuestion 线性扫描 */
const QUESTION_INDEX: Record<string, FullQuestion> = (function build() {
  const out: Record<string, FullQuestion> = {};
  for (let i = 0; i < QUESTIONS.length; i++) out[QUESTIONS[i].id] = QUESTIONS[i];
  return out;
})();

export function findQuestion(id: string): FullQuestion | undefined {
  return QUESTION_INDEX[id];
}

export function findLevel(id: string): LevelDef | undefined {
  for (let i = 0; i < LEVELS.length; i++) {
    if (LEVELS[i].id === id) return LEVELS[i];
  }
  return undefined;
}

/** 某一章节下的关卡，按解锁顺序 */
export function levelsOfChapter(chapterId: string): LevelDef[] {
  const out: LevelDef[] = [];
  for (let i = 0; i < LEVELS.length; i++) {
    if (LEVELS[i].chapterId === chapterId) out.push(LEVELS[i]);
  }
  return out;
}

/** 某一章节下的知识点，按声明顺序 */
export function knowledgePointsOfChapter(chapterId: string): KnowledgePointDef[] {
  const out: KnowledgePointDef[] = [];
  for (let i = 0; i < KNOWLEDGE_POINTS.length; i++) {
    if (KNOWLEDGE_POINTS[i].chapterId === chapterId) out.push(KNOWLEDGE_POINTS[i]);
  }
  return out;
}
