/**
 * 题型引擎 · 数据契约
 *
 * 设计原则：题目是「纯数据」，页面不感知题型。
 * 新增题型 = 注册渲染器 + 注册判分器，不改任何页面代码。
 *
 * ⚠️ 本文件不依赖任何小程序 API，可在 Node 中直接运行测试。
 */

/** 判分策略。L1 确定性判分（本地可跑）/ L2 编译判分 / L3 AI 语义判分 */
export type JudgeStrategy =
  | 'exact'
  | 'set'
  | 'normalize'
  | 'numeric'
  | 'output'
  | 'sandbox'
  | 'ai';

/** 允许在客户端本地执行的判分策略（普通练习关）。
 *  注意：sandbox / ai 必须服务端判分，永不下发判分依据。 */
export type LocalJudgeStrategy = 'exact' | 'set' | 'normalize' | 'numeric' | 'output';

export const LOCAL_JUDGE_STRATEGIES: LocalJudgeStrategy[] = [
  'exact',
  'set',
  'normalize',
  'numeric',
  'output',
];

export function isLocalJudgeStrategy(s: string): s is LocalJudgeStrategy {
  return (LOCAL_JUDGE_STRATEGIES as string[]).indexOf(s) >= 0;
}

/** 判分后允许向用户揭示的信息。由判分器填充，渲染器只负责展示。 */
export interface Reveal {
  /** 选择题正确选项 key */
  correctKeys?: string[];
  /** 填空题可接受答案（取每组首个用于展示） */
  acceptedText?: string[];
  /** 数值题正确答案 */
  correctText?: string;
  /** 程序输出题期望输出（逐行） */
  expectedLines?: string[];
  /** 主观题评分要点（AI 判分返回） */
  scorePoints?: string[];
}

/** 统一判分结果 */
export interface JudgeResult {
  /** 是否完全正确。Combo 递增只看这个字段 */
  correct: boolean;
  /** 是否部分正确（用于「部分得分」提示，不递增 Combo） */
  partial: boolean;
  /** 得分率 0-1。星级与掌握度用这个字段 */
  score: number;
  /** 给用户看的一句话 */
  detail: string;
  /** 判分发生在哪一层 */
  layer: 'local' | 'remote';
  /** 实际使用的判分策略 */
  strategy: string;
  /** 允许揭示的答案信息 */
  reveal?: Reveal;
}

/** 题目载荷：题型私有数据，渲染器按 type 消费 */
export interface QuestionPayload {
  /** 题干（纯文本，可含 \n） */
  stem: string;
  /** 题干中的 LaTeX 片段（构建期已预渲染为 SVG，此处存 SVG 字符串） */
  stemLatexSvg?: string[];
  /** 代码块 */
  code?: { lang: string; content: string };
  /** 选择题选项 */
  options?: Array<{ key: string; text: string; code?: string }>;
  /** 填空题位 */
  blanks?: Array<{ key: string; label?: string; hint?: string }>;
  /** 作答提示 */
  placeholder?: string;
  /** 单选是否点选即判（多邻国式交互） */
  instantSubmit?: boolean;
  /** 题型额外字段 */
  [k: string]: unknown;
}

export interface QuestionAnalysis {
  text: string;
  latex?: string[];
  /** 是否为 AI 生成内容（合规要求：必须显式标识） */
  aigc?: boolean;
}

/** 版权台账。每道题必须带，提审前复查 */
export interface QuestionSource {
  type: 'original' | 'adapted' | 'licensed';
  note?: string;
  license?: string;
  author?: string;
}

export interface QuestionJudge {
  strategy: JudgeStrategy;
  options?: Record<string, unknown>;
}

/** 服务端完整题（含答案，绝不下发） */
export interface FullQuestion {
  id: string;
  subject: string;
  chapterId: string;
  kpIds: string[];
  /** 与渲染器 tag 同名的题型标识 */
  type: string;
  /** 1-5 */
  difficulty: number;
  payload: QuestionPayload;
  /** 判分依据。**永不下发客户端** */
  answer: unknown;
  judge: QuestionJudge;
  analysis: QuestionAnalysis;
  source: QuestionSource;
  status?: 'draft' | 'reviewing' | 'published' | 'offline';
}

/** 客户端可见题（已剔除答案） */
export interface ClientQuestion {
  id: string;
  subject: string;
  chapterId: string;
  kpIds: string[];
  type: string;
  difficulty: number;
  payload: QuestionPayload;
  /** 仅练习关下发：本地判分时即时展示解析 */
  analysis?: QuestionAnalysis;
  /** 仅练习关 + L1 策略下发：本地判分的最小信息 */
  localJudgeKey?: LocalJudgeKey;
}

/**
 * 本地判分依据。
 *
 * ⚠️ 取舍说明：对选择/判断/填空类题型，localJudgeKey 在数学上等价于答案。
 * 因此它**只在「普通练习关」下发**——练习关不计入任何排行榜、不参与 PK、不作为段位依据。
 * 需防作弊的场次（PK / 排行榜 / 模拟考 / 编程题）一律不传该字段，走服务端判分。
 */
export interface LocalJudgeKey {
  strategy: LocalJudgeStrategy;
  key: unknown;
  options?: Record<string, unknown>;
}

/** 关卡形态 */
export type LevelMode = 'practice' | 'boss' | 'challenge' | 'review';

export interface LevelDef {
  id: string;
  chapterId: string;
  name: string;
  mode: LevelMode;
  questionIds: string[];
  /** 星级阈值 [1星, 2星, 3星]，按得分率 */
  starThresholds: [number, number, number];
  /** 是否有作答时限（毫秒），Boss 关使用 */
  timeLimitMs?: number;
}
