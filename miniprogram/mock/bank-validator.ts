/**
 * 题库校验器
 *
 * ═══════════════════════════════════════════════════════════════════
 *  为什么需要它（录题是「写数据」，不是「写代码」——最容易漏校验）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 题库是纯数据。数据错了**不会编译报错**，只会在用户答题那一刻表现成：
 *   - 选择题答案填了个不存在的选项 key → 用户怎么选都判错（且没人知道为什么）
 *   - 填空题 blanks 有 3 个空、accepted 只给了 2 组 → 第 3 空永远是错的
 *   - 解析为空 → 错题本点开是空白，用户以为功能坏了
 *   - 缺 source 版权台账 → 提审时被驳回，而且是**逐题**被驳回
 *   - kpIds 指向不存在的知识点 → 错题本按知识点聚合时掉进「未归类」
 *   - 关卡引用了不存在的题目 id → 进关直接白屏
 *
 * 这些都是「批量录题」时最高的翻车点。所以录题必须过闸门。
 *
 * 设计成**纯函数 + 可复用**（`validateBank`），这样：
 *   - `scripts/check-bank.mjs` 能在提交前跑
 *   - `tests/wiring.test.mjs` 能直接 import 断言
 *   - 将来题库搬到后台，同一套规则可以搬到服务端做入库校验
 */

/* ------------------------------------------------------------------ */
/*  题型 → 允许的判分策略（与引擎注册表必须一致）                        */
/* ------------------------------------------------------------------ */

/**
 * 这张表是「题型能配哪些判分策略」的唯一声明。
 *
 * ⚠️ 必须与 `engine/judges/registry` 里的映射保持一致，
 *    否则会出现「渲染器是这个题型、判分器是那个策略」的错配，
 *    表现为用户提交后判分器报「未知策略」。
 */
export const TYPE_STRATEGY_MAP: Record<string, string[]> = {
  'single-choice': ['exact'],
  'multi-choice': ['set'],
  'fill-blank': ['normalize'],
  'program-output': ['output'],
  'code-editor': ['sandbox'],
};

/** 允许在客户端本地判分的策略（普通练习关）。与 engine/types 的 LOCAL_JUDGE_STRATEGIES 一致 */
export const LOCAL_STRATEGIES = ['exact', 'set', 'normalize', 'numeric', 'output'];

/* ------------------------------------------------------------------ */
/*  校验结果                                                            */
/* ------------------------------------------------------------------ */

export interface BankIssue {
  /** 出问题的对象 id（题目 id / 关卡 id / 知识点 id） */
  id: string;
  /** 问题分类，便于按类统计 */
  kind:
    | 'missing-field'
    | 'unknown-type'
    | 'strategy-mismatch'
    | 'bad-answer'
    | 'bad-payload'
    | 'missing-analysis'
    | 'missing-source'
    | 'dangling-ref'
    | 'duplicate-id'
    | 'invalid-difficulty'
    | 'level-empty';
  /** 给人看的说明 */
  message: string;
}

export interface BankValidateInput {
  subjects: Array<{ id: string; name: string }>;
  chapters: Array<{ id: string; subjectId: string; name: string }>;
  knowledgePoints: Array<{ id: string; chapterId: string; name: string }>;
  levels: Array<{
    id: string;
    chapterId: string;
    name: string;
    mode: string;
    questionIds: string[];
    starThresholds: number[];
    timeLimitMs?: number;
  }>;
  questions: Array<{
    id: string;
    subject: string;
    chapterId: string;
    kpIds: string[];
    type: string;
    difficulty: number;
    payload: Record<string, unknown>;
    answer: unknown;
    judge: { strategy: string; options?: Record<string, unknown> };
    analysis?: { text?: string };
    source?: { type?: string; note?: string; license?: string };
    status?: string;
  }>;
}

/* ------------------------------------------------------------------ */
/*  校验主函数（纯函数，可在 Node / 服务端 / 后台复用）                   */
/* ------------------------------------------------------------------ */

export function validateBank(input: BankValidateInput): BankIssue[] {
  const issues: BankIssue[] = [];

  const subjectIds = toSet(input.subjects.map((s) => s.id));
  const chapterIds = toSet(input.chapters.map((c) => c.id));
  const kpIds = toSet(input.knowledgePoints.map((k) => k.id));
  const questionIds = toSet(input.questions.map((q) => q.id));

  /* ── 1. 章节 → 科目引用 ── */
  for (const c of input.chapters) {
    if (!subjectIds.has(c.subjectId)) {
      issues.push({
        id: c.id,
        kind: 'dangling-ref',
        message: '章节引用了不存在的科目 ' + c.subjectId,
      });
    }
  }

  /* ── 2. 知识点 → 章节引用 ── */
  for (const k of input.knowledgePoints) {
    if (!chapterIds.has(k.chapterId)) {
      issues.push({
        id: k.id,
        kind: 'dangling-ref',
        message: '知识点引用了不存在的章节 ' + k.chapterId,
      });
    }
  }

  /* ── 3. 题目 id 唯一性 ── */
  const seenQid = new Set<string>();
  for (const q of input.questions) {
    if (seenQid.has(q.id)) {
      issues.push({ id: q.id, kind: 'duplicate-id', message: '题目 id 重复' });
    }
    seenQid.add(q.id);
  }

  /* ── 4. 逐题校验 ── */
  for (const q of input.questions) {
    const where = '[' + q.id + '] ';

    // 4.1 必填字段
    if (!q.id) issues.push({ id: '(空)', kind: 'missing-field', message: '题目缺少 id' });
    if (!q.subject) issues.push({ id: q.id, kind: 'missing-field', message: where + '缺少 subject' });
    if (!q.chapterId) issues.push({ id: q.id, kind: 'missing-field', message: where + '缺少 chapterId' });
    if (!q.type) issues.push({ id: q.id, kind: 'missing-field', message: where + '缺少 type' });

    // 4.2 引用完整性
    if (q.subject && !subjectIds.has(q.subject)) {
      issues.push({ id: q.id, kind: 'dangling-ref', message: where + '引用了不存在的科目 ' + q.subject });
    }
    if (q.chapterId && !chapterIds.has(q.chapterId)) {
      issues.push({ id: q.id, kind: 'dangling-ref', message: where + '引用了不存在的章节 ' + q.chapterId });
    }
    if (!Array.isArray(q.kpIds) || q.kpIds.length === 0) {
      issues.push({
        id: q.id,
        kind: 'missing-field',
        message: where + 'kpIds 为空 —— 错题本按知识点聚合时会掉进「未归类」',
      });
    } else {
      for (const kp of q.kpIds) {
        if (!kpIds.has(kp)) {
          issues.push({ id: q.id, kind: 'dangling-ref', message: where + '引用了不存在的知识点 ' + kp });
        }
      }
    }

    // 4.3 难度
    if (typeof q.difficulty !== 'number' || q.difficulty < 1 || q.difficulty > 5) {
      issues.push({
        id: q.id,
        kind: 'invalid-difficulty',
        message: where + 'difficulty 必须是 1-5 的整数，实际 ' + JSON.stringify(q.difficulty),
      });
    }

    // 4.4 题型 → 策略匹配
    const allowed = TYPE_STRATEGY_MAP[q.type];
    if (!allowed) {
      issues.push({
        id: q.id,
        kind: 'unknown-type',
        message: where + '题型 ' + q.type + ' 没有注册（可用：' + Object.keys(TYPE_STRATEGY_MAP).join(' / ') + '）',
      });
    } else if (!q.judge || allowed.indexOf(q.judge.strategy) < 0) {
      issues.push({
        id: q.id,
        kind: 'strategy-mismatch',
        message:
          where + '题型 ' + q.type + ' 应配策略 ' + allowed.join('/') +
          '，实际 ' + (q.judge ? q.judge.strategy : '(缺失 judge)'),
      });
    }

    // 4.5 解析必须非空
    //     合规与体验双重理由：错题本点开是空白会让用户以为功能坏了；
    //     另外有解析才说得上「AI 生成内容显式标识」那套合规流程。
    if (!q.analysis || typeof q.analysis.text !== 'string' || q.analysis.text.trim().length === 0) {
      issues.push({ id: q.id, kind: 'missing-analysis', message: where + '解析为空' });
    }

    // 4.6 版权台账（提审前逐题复查项）
    if (!q.source || !q.source.type || !q.source.license) {
      issues.push({
        id: q.id,
        kind: 'missing-source',
        message: where + '版权台账不完整（需要 source.type 与 source.license）',
      });
    }

    // 4.7 按题型校验 payload 与答案形态
    issues.push(...validateByType(q));
  }

  /* ── 5. 关卡校验 ── */
  const seenLid = new Set<string>();
  for (const lv of input.levels) {
    if (seenLid.has(lv.id)) {
      issues.push({ id: lv.id, kind: 'duplicate-id', message: '关卡 id 重复' });
    }
    seenLid.add(lv.id);

    if (!lv.name) {
      issues.push({ id: lv.id, kind: 'missing-field', message: '[' + lv.id + '] 关卡缺少 name' });
    }
    if (!chapterIds.has(lv.chapterId)) {
      issues.push({
        id: lv.id,
        kind: 'dangling-ref',
        message: '[' + lv.id + '] 关卡引用了不存在的章节 ' + lv.chapterId,
      });
    }

    // 关卡不能是空的（空关卡点进去直接白屏/立即结束）
    if (!Array.isArray(lv.questionIds) || lv.questionIds.length === 0) {
      issues.push({
        id: lv.id,
        kind: 'level-empty',
        message: '[' + lv.id + '] 关卡没有题目 —— 点进去会立刻结束',
      });
    } else {
      for (const qid of lv.questionIds) {
        if (!questionIds.has(qid)) {
          issues.push({
            id: lv.id,
            kind: 'dangling-ref',
            message: '[' + lv.id + '] 引用了不存在的题目 ' + qid + ' —— 进关会白屏',
          });
        }
      }
    }

    // 星级阈值必须是 3 个、递增、在 (0, 1]
    if (!Array.isArray(lv.starThresholds) || lv.starThresholds.length !== 3) {
      issues.push({
        id: lv.id,
        kind: 'bad-payload',
        message: '[' + lv.id + '] starThresholds 必须是 3 个值',
      });
    } else {
      const t = lv.starThresholds;
      const okRange = t.every((v) => typeof v === 'number' && v > 0 && v <= 1);
      const ascending = t[0] < t[1] && t[1] <= t[2];
      if (!okRange || !ascending) {
        issues.push({
          id: lv.id,
          kind: 'bad-payload',
          message: '[' + lv.id + '] starThresholds 必须递增且落在 (0,1]，实际 ' + JSON.stringify(t),
        });
      }
    }

    // Boss 关有时限才有意义（否则「限时」这个设计点就落空了）
    if (lv.mode === 'boss' && !(typeof lv.timeLimitMs === 'number' && lv.timeLimitMs > 0)) {
      issues.push({
        id: lv.id,
        kind: 'bad-payload',
        message: '[' + lv.id + '] Boss 关必须设置 timeLimitMs',
      });
    }
  }

  /* ── 6. 同一道题不得横跨「本地判分关」与「服务端判分关」 ──
   *
   * 背景（这是真踩过的坑）：
   *   practice / review 关会下发 localJudgeKey（客户端本地判分）；
   *   boss / challenge 关**不下发**，走服务端判分。
   *
   *   一道选择题如果同时出现在练习关和 Boss 关，那么它在 Boss 关里
   *   既没有 localJudgeKey、又没有任何服务端判分入口（服务端只认编程题的 sandbox），
   *   结果是**用户答对也判 0 分**，还被告知「题目配置异常」。
   *   这个错误在开发时完全看不见（练习关里它是好的），只在用户打 Boss 时暴露。
   *
   *   所以两个关卡集合必须**互斥**（questionIds 不重叠）。
   */
  const localLevelQids = new Set<string>();
  const remoteLevelQids = new Set<string>();
  for (const lv of input.levels) {
    const isLocal = lv.mode === 'practice' || lv.mode === 'review';
    const isRemote = lv.mode === 'boss' || lv.mode === 'challenge';
    if (!Array.isArray(lv.questionIds)) continue;
    for (const qid of lv.questionIds) {
      if (isLocal) localLevelQids.add(qid);
      if (isRemote) remoteLevelQids.add(qid);
    }
  }
  for (const qid of remoteLevelQids) {
    if (localLevelQids.has(qid)) {
      issues.push({
        id: qid,
        kind: 'dangling-ref',
        message:
          '题目 ' + qid + ' 同时出现在「本地判分关」与「服务端判分关」——' +
          '服务端判分关里它既无本地判分依据、又无服务端判分入口，用户答对也会被判 0 分',
      });
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/*  按题型校验 payload 与答案（最容易出错的部分，单独拎出来）             */
/* ------------------------------------------------------------------ */

function validateByType(q: BankValidateInput['questions'][number]): BankIssue[] {
  const out: BankIssue[] = [];
  const p = (q.payload || {}) as Record<string, any>;
  const where = '[' + q.id + '] ';

  // 题干必须非空
  if (typeof p.stem !== 'string' || p.stem.trim().length === 0) {
    out.push({ id: q.id, kind: 'bad-payload', message: where + '题干（payload.stem）为空' });
  }

  if (q.type === 'single-choice' || q.type === 'multi-choice') {
    const opts = p.options;
    if (!Array.isArray(opts) || opts.length < 2) {
      out.push({
        id: q.id,
        kind: 'bad-payload',
        message: where + '选择题至少要有 2 个选项',
      });
      return out;
    }

    // 选项 key 必须唯一且非空
    const keys: string[] = [];
    for (const o of opts) {
      if (!o || typeof o.key !== 'string' || o.key.length === 0) {
        out.push({ id: q.id, kind: 'bad-payload', message: where + '有选项缺少 key' });
        continue;
      }
      if (typeof o.text !== 'string' || o.text.trim().length === 0) {
        out.push({ id: q.id, kind: 'bad-payload', message: where + '选项 ' + o.key + ' 的文本为空' });
      }
      keys.push(o.key);
    }
    if (new Set(keys).size !== keys.length) {
      out.push({ id: q.id, kind: 'bad-payload', message: where + '选项 key 有重复' });
    }

    // ⚠️ 最重要的一条：答案必须能在选项里找到
    //    否则用户怎么选都判错，而且没有任何报错 —— 最难排查的一类录题错误
    if (q.type === 'single-choice') {
      if (typeof q.answer !== 'string') {
        out.push({
          id: q.id,
          kind: 'bad-answer',
          message: where + '单选答案必须是字符串，实际 ' + JSON.stringify(q.answer),
        });
      } else if (keys.indexOf(q.answer) < 0) {
        out.push({
          id: q.id,
          kind: 'bad-answer',
          message: where + '单选答案 "' + q.answer + '" 不在选项里 —— 用户怎么选都会判错',
        });
      }
    } else {
      if (!Array.isArray(q.answer) || q.answer.length === 0) {
        out.push({
          id: q.id,
          kind: 'bad-answer',
          message: where + '多选答案必须是非空字符串数组',
        });
      } else {
        for (const a of q.answer) {
          if (keys.indexOf(a) < 0) {
            out.push({
              id: q.id,
              kind: 'bad-answer',
              message: where + '多选答案 "' + a + '" 不在选项里',
            });
          }
        }
        // 多选至少要 2 个正确项，否则它其实就是单选（题型用错了）
        if (q.answer.length < 2) {
          out.push({
            id: q.id,
            kind: 'bad-answer',
            message: where + '多选只给了 1 个正确答案 —— 应该改用 single-choice',
          });
        }
      }
    }
  }

  if (q.type === 'fill-blank') {
    const blanks = p.blanks;
    const ans = q.answer as any;

    if (!Array.isArray(blanks) || blanks.length === 0) {
      out.push({ id: q.id, kind: 'bad-payload', message: where + '填空题必须有 blanks' });
      return out;
    }

    const bKeys: string[] = [];
    for (const b of blanks) {
      if (!b || typeof b.key !== 'string' || b.key.length === 0) {
        out.push({ id: q.id, kind: 'bad-payload', message: where + '有填空位缺少 key' });
      } else {
        bKeys.push(b.key);
      }
    }
    if (new Set(bKeys).size !== bKeys.length) {
      out.push({ id: q.id, kind: 'bad-payload', message: where + '填空位 key 有重复' });
    }

    if (!ans || typeof ans !== 'object') {
      out.push({ id: q.id, kind: 'bad-answer', message: where + '填空答案必须是对象' });
      return out;
    }

    const mode = ans.mode;
    if (mode !== 'single' && mode !== 'multi') {
      out.push({
        id: q.id,
        kind: 'bad-answer',
        message: where + '填空答案 mode 必须是 single 或 multi，实际 ' + JSON.stringify(mode),
      });
      return out;
    }

    if (!Array.isArray(ans.accepted)) {
      out.push({ id: q.id, kind: 'bad-answer', message: where + '填空答案缺少 accepted' });
      return out;
    }

    if (mode === 'multi') {
      // ⚠️ 第二个高发错误：空位数与答案组数必须一一对应
      //    少一组 → 那个空位永远是错的；多一组 → 多余答案被忽略（更隐蔽）
      if (ans.accepted.length !== blanks.length) {
        out.push({
          id: q.id,
          kind: 'bad-answer',
          message:
            where + '填空有 ' + blanks.length + ' 个空，但 accepted 给了 ' +
            ans.accepted.length + ' 组 —— 空的个数与答案组数必须一致',
        });
      }
      for (let i = 0; i < ans.accepted.length; i++) {
        const g = ans.accepted[i];
        if (!Array.isArray(g) || g.length === 0) {
          out.push({
            id: q.id,
            kind: 'bad-answer',
            message: where + '第 ' + (i + 1) + ' 个空的可接受答案为空',
          });
        }
      }
    } else {
      // single 模式下 accepted 是「一个可接受答案数组」
      if (ans.accepted.length === 0) {
        out.push({ id: q.id, kind: 'bad-answer', message: where + '填空的可接受答案为空' });
      }
      if (blanks.length > 1) {
        out.push({
          id: q.id,
          kind: 'bad-answer',
          message: where + '有 ' + blanks.length + ' 个空却用了 single 模式 —— 应该用 multi',
        });
      }
    }
  }

  if (q.type === 'program-output') {
    const ans = q.answer as any;
    if (!ans || !Array.isArray(ans.expected) || ans.expected.length === 0) {
      out.push({
        id: q.id,
        kind: 'bad-answer',
        message: where + '程序输出题必须有非空的 answer.expected',
      });
    }
    if (!p.code || typeof p.code.content !== 'string' || p.code.content.trim().length === 0) {
      out.push({
        id: q.id,
        kind: 'bad-payload',
        message: where + '程序输出题必须有代码块（payload.code.content）',
      });
    }
  }

  if (q.type === 'code-editor') {
    const ans = q.answer as any;
    // 编程题的判分依据在服务端（题库 judge_plans），客户端只带一个引用
    if (!ans || ans.kind !== 'testcases' || !ans.planRef) {
      out.push({
        id: q.id,
        kind: 'bad-answer',
        message: where + '编程题必须带 { kind: "testcases", planRef }',
      });
    }
    if (!p.language || typeof p.language !== 'string') {
      out.push({ id: q.id, kind: 'bad-payload', message: where + '编程题必须声明 language' });
    }
  }

  return out;
}

function toSet(list: string[]): Set<string> {
  const s = new Set<string>();
  for (const x of list) s.add(x);
  return s;
}

/* ------------------------------------------------------------------ */
/*  自检辅助：把问题列表压成「人类可读」的摘要                            */
/* ------------------------------------------------------------------ */

export function summarizeIssues(issues: BankIssue[]): string {
  if (issues.length === 0) return '（无问题）';
  const byKind: Record<string, number> = {};
  for (const it of issues) {
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  }
  const parts: string[] = [];
  const keys = Object.keys(byKind).sort();
  for (const k of keys) parts.push(k + '×' + byKind[k]);
  return parts.join(', ');
}
