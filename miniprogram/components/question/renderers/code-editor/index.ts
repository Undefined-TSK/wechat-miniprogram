/**
 * 渲染器 · 编程题代码编辑器（判分策略 sandbox）
 *
 * 接口契约：
 *   properties.template   string   预置代码骨架（如 #include 与 main 签名）
 *   properties.language   string   'c' | 'cpp' | 'python'
 *   properties.value      string   当前代码
 *   properties.locked     boolean  判分后锁定
 *   event change          { value: string }
 *
 * 作答形态：string（完整源码）
 *
 * ── 为什么这里用原生 textarea 而不是 WebView + CodeMirror ──────────
 * v1.1 方案把 CodeMirror 放在 Phase 0 的 POC 里，因为它需要 WebView、
 * 需要 postMessage 双向桥、需要处理键盘遮挡与滚动同步——是一个独立工作量。
 *
 * 本组件的取舍：**先让编程题能作答、能判分**（这是闭环价值），语法高亮后补。
 * 对外契约（properties + change 事件）已经定稳，将来把 textarea 换成 web-view
 * 时**这个契约一行都不用改**——这正是把渲染器做成独立组件的收益。
 *
 * ⚠️ 一个重要的能力边界（写清楚，避免误导用户与后续开发者）：
 *    这里的「自动缩进 / 插入缩进」只能在**整行粒度**上编辑文本。
 *    微信小程序的 textarea 原生组件不支持程序化设置光标位置
 *    （没有 selectionStart/selectionEnd 的写入能力），
 *    所以做不了 IDE 那种「在当前光标处插入 4 空格」。这不是偷懒，
 *    是平台能力限制；要真正的光标级编辑必须上 WebView 编辑器。
 */

const INDENT = '    ';

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    value: { type: String, value: '' },
    template: { type: String, value: '' },
    language: { type: String, value: 'c' },
    placeholder: { type: String, value: '在这里写你的代码' },
    locked: { type: Boolean, value: false },
  },

  data: {
    /** 行号栏内容（纯展示，最多渲染 999 行） */
    lines: [''] as string[],
    lineCount: 1,
    charCount: 0,
    /** 光标所在行（1 起）。列号无法精确获取（平台限制），故不展示 */
    cursorLine: 1,
    /** 骨架代码是否与当前内容一致（用于「重置」按钮的可见性） */
    dirty: false,
  },

  observers: {
    'value, template'(this: any, value: string, template: string) {
      // 题目带骨架且用户还没输入过 → 用骨架填充，避免用户从空白开始手写 include
      if (!value && template) {
        this.setData({ value: template, dirty: false });
        this.refresh(template);
        // 把骨架同步给容器，否则用户不做任何修改直接提交会提交空字符串
        this.triggerEvent('change', { value: template });
        return;
      }
      this.refresh(value || '');
      this.setData({ dirty: !!template && String(value || '') !== template });
    },
  },

  lifetimes: {
    attached(this: any) {
      const initial = this.data.value || this.data.template || '';
      if (initial) this.refresh(initial);
    },
  },

  methods: {
    /** 只重算渲染需要的派生数据 */
    refresh(this: any, text: string) {
      const s = String(text);
      const parts = s.split('\n');
      this.setData({
        lineCount: parts.length,
        charCount: s.length,
        lines: parts.length > 0 ? parts.slice(0, 999) : [''],
      });
    },

    /** 由输入内容反推光标所在行，用于展示「你正在第几行」 */
    updateCursorLine(this: any, text: string, caret: number) {
      const before = String(text).slice(0, Math.max(0, caret));
      const rows = before.split('\n');
      this.setData({ cursorLine: rows.length });
    },

    onInput(this: any, e: any) {
      const text = String(e.detail.value);
      this.refresh(text);
      if (typeof e.detail.cursor === 'number') {
        this.updateCursorLine(text, e.detail.cursor);
      }
      this.setData({ dirty: true });
      this.triggerEvent('change', { value: text });
    },

    onFocus(this: any) {
      this.setData({ focused: true });
    },

    onBlur(this: any) {
      this.setData({ focused: false });
    },

    /** 一键重置为骨架代码 */
    onReset(this: any) {
      if (this.data.locked) return;
      const template = this.data.template || '';
      this.setData({ value: template, dirty: false });
      this.refresh(template);
      this.triggerEvent('change', { value: template });
    },

    /**
     * 给光标所在行加一级缩进（整行粒度）。
     *
     * 为什么做成「整行」而不是「在光标处插入」：小程序 textarea 无法写光标位置。
     * 对写 C 代码来说，整行缩进已经能覆盖绝大部分场景（把一段代码整体缩进，
     * 或给新写的 if 体缩进）。
     */
    onIndent(this: any) {
      if (this.data.locked) return;
      const lineIdx = Math.max(0, Math.min(this.data.cursorLine - 1, this.data.lineCount - 1));
      const parts = String(this.data.value).split('\n');
      parts[lineIdx] = INDENT + parts[lineIdx];
      const text = parts.join('\n');
      this.setData({ value: text, dirty: true });
      this.refresh(text);
      this.triggerEvent('change', { value: text });
    },

    /** 反缩进：去掉行首最多 4 个空格 */
    onOutdent(this: any) {
      if (this.data.locked) return;
      const lineIdx = Math.max(0, Math.min(this.data.cursorLine - 1, this.data.lineCount - 1));
      const parts = String(this.data.value).split('\n');
      parts[lineIdx] = parts[lineIdx].replace(/^ {1,4}/, '');
      const text = parts.join('\n');
      this.setData({ value: text, dirty: true });
      this.refresh(text);
      this.triggerEvent('change', { value: text });
    },
  },
});
