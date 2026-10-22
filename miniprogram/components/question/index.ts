/**
 * 答题引擎容器
 *
 * 职责：
 *  1. 按 question.type 分发到对应渲染器（wx:if 链，见 index.wxml 顶部说明）
 *  2. 持有当前题的作答值，判断能否提交
 *  3. 渲染判分反馈与解析
 *
 * 明确不做的事：不判分。判分一律走 services/judge —— 否则「必须服务端判分」
 * 的场次会被前端绕过，防作弊就成了一句空话。
 */

import type { ClientQuestion, JudgeResult } from '../../engine/types';
import { emptyAnswerFor, isSubmittable } from '../../engine/answer';
import { getRenderer } from '../../engine/registry';
import { splitLines } from '../../utils/format';

const FALLBACK_LABELS: Record<string, string> = {
  'single-choice': '单项选择',
  'multi-choice': '多项选择',
  'fill-blank': '填空',
  'program-output': '程序阅读与输出',
};

const DIFFICULTY_LABELS: Record<number, string> = {
  1: '入门',
  2: '基础',
  3: '进阶',
  4: '困难',
  5: '挑战',
};

Component({
  // apply-shared：让 app.wxss 里的全局类（pill / code-wrap / btn 等）在组件内生效，
  // 同时组件自身样式不会外泄到页面。
  options: { styleIsolation: 'apply-shared' },

  properties: {
    question: { type: Object, value: null },
    feedback: { type: Object, value: null },
    locked: { type: Boolean, value: false },
    isLast: { type: Boolean, value: false },
  },

  data: {
    renderer: '',
    typeLabel: '',
    difficultyLabel: '',
    stemLines: [] as string[],
    codeLines: [] as string[],
    codeLang: '',
    analysisLines: [] as string[],
    analysisAigc: false,
    expectedLines: [] as string[],
    partialPercent: 0,
    answerValue: null as unknown,
    canSubmit: false,
  },

  observers: {
    question(this: any, q: ClientQuestion | null) {
      if (!q) {
        this.setData({ renderer: '', stemLines: [], codeLines: [], answerValue: null });
        return;
      }

      const meta = getRenderer(q.type);
      const payload = q.payload || ({} as ClientQuestion['payload']);
      const code = payload.code;

      this.setData({
        renderer: q.type,
        typeLabel: meta ? meta.label : FALLBACK_LABELS[q.type] || q.type,
        difficultyLabel: DIFFICULTY_LABELS[q.difficulty] || '未标定',
        stemLines: splitLines(payload.stem || ''),
        codeLines: code && code.content ? splitLines(code.content) : [],
        codeLang: code ? code.lang : '',
        answerValue: emptyAnswerFor(q),
        canSubmit: false,
      });
    },

    feedback(this: any, f: JudgeResult | null) {
      if (!f) {
        this.setData({
          analysisLines: [],
          analysisAigc: false,
          expectedLines: [],
          partialPercent: 0,
        });
        return;
      }
      const q = this.data.question as ClientQuestion | null;
      const analysis = q && q.analysis ? q.analysis.text : '';
      const reveal = f.reveal || {};
      this.setData({
        analysisLines: analysis ? splitLines(analysis) : [],
        analysisAigc: !!(q && q.analysis && q.analysis.aigc),
        expectedLines: Array.isArray(reveal.expectedLines) ? reveal.expectedLines : [],
        partialPercent: Math.round(f.score * 100),
      });
    },
  },

  methods: {
    onChange(this: any, e: any) {
      const value = e.detail.value;
      const q = this.data.question as ClientQuestion | null;
      const canSubmit = isSubmittable(q, value);
      this.setData({ answerValue: value, canSubmit: canSubmit });

      // 单选支持「点选即判」（由题目数据控制，不由页面写死）
      if (q && q.payload && q.payload.instantSubmit && q.type === 'single-choice') {
        this.emitSubmit(value);
      }
    },

    onSubmit(this: any) {
      this.emitSubmit(this.data.answerValue);
    },

    emitSubmit(this: any, value: unknown) {
      if (this.data.locked) return;
      if (!isSubmittable(this.data.question as ClientQuestion, value)) return;
      this.triggerEvent('submit', { answer: value });
    },

    onNext(this: any) {
      this.triggerEvent('next', {});
    },
  },
});
