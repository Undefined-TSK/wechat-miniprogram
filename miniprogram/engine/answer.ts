/**
 * 作答形态契约
 *
 * 渲染器与判分器之间的唯一约定。放在引擎里而不是组件里，是为了可测试：
 * 形态写错会让判分静默失败（判 0 分但用户以为答对了），必须集中约束。
 *
 *   single-choice   → string           选项 key
 *   multi-choice    → string[]         选项 key 数组
 *   fill-blank      → string[]         按空位顺序
 *   program-output  → string           多行文本
 *   code-editor     → string           完整源码（判题服务判分）
 */

import type { ClientQuestion } from './types';

export function describeAnswerShape(type: string): string {
  switch (type) {
    case 'single-choice':
      return 'string';
    case 'multi-choice':
      return 'string[]';
    case 'fill-blank':
      return 'string[]';
    case 'program-output':
      return 'string';
    case 'code-editor':
      return 'string';
    default:
      return 'unknown';
  }
}

/** 生成该题型的空答案，保证渲染器拿到类型正确的初值 */
export function emptyAnswerFor(q: ClientQuestion): unknown {
  const blankCount =
    q && q.payload && Array.isArray(q.payload.blanks) ? q.payload.blanks.length : 0;

  switch (q ? q.type : '') {
    case 'multi-choice': {
      const empty: string[] = [];
      return empty;
    }
    case 'fill-blank': {
      const arr: string[] = [];
      for (let i = 0; i < Math.max(blankCount, 1); i++) arr.push('');
      return arr;
    }
    case 'code-editor': {
      // 编程题的初值是预置骨架（题目数据驱动）。给空串会让用户从
      // `#include` 开始手写，体验很差；骨架同时保证「直接提交」也有意义。
      const tpl = q && q.payload ? q.payload.template : '';
      return typeof tpl === 'string' ? tpl : '';
    }
    case 'program-output':
    case 'single-choice':
      return '';
    default:
      return null;
  }
}

/** 是否可提交。只做「非空」判断，不参与任何正确性判断 */
export function isSubmittable(q: ClientQuestion, value: unknown): boolean {
  if (!q) return false;

  switch (q.type) {
    case 'single-choice':
      return typeof value === 'string' && value !== '';

    case 'multi-choice':
      return Array.isArray(value) && value.length > 0;

    case 'fill-blank': {
      if (!Array.isArray(value)) return false;
      for (let i = 0; i < value.length; i++) {
        if (String(value[i]).trim() !== '') return true;
      }
      return false;
    }

    case 'program-output':
      return typeof value === 'string' && value.trim() !== '';

    case 'code-editor': {
      if (typeof value !== 'string') return false;
      // 只判断「有没有实质内容」。骨架代码本身包含 main 与 include，
      // 但如果用户只留骨架不做修改，那也是合法提交（会判 WA，不是格式错误）。
      // 真正需要拦的是「只有骨架+空函数体」这种显然没写的情况——
      // 这里不拦，交给判题服务给出 AC/WA；前端只拦纯空白。
      return value.trim() !== '';
    }

    default:
      return value !== null && value !== undefined && value !== '';
  }
}
