/**
 * 渲染器 · 程序阅读与输出（判分策略 output）
 *
 * 接口契约：
 *   properties.value        string        多行文本
 *   properties.placeholder  string
 *   properties.locked       boolean
 *   event change            { value: string }
 *
 * 作答形态：string
 *
 * 说明：这里用原生 textarea 而非 WebView 代码编辑器——本题型写的是「运行结果」
 *      而不是代码，不需要语法高亮。真正的代码编辑器（T8/T9 编程题）走
 *      components/code-editor（WebView + CodeMirror）。
 */

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    value: { type: String, value: '' },
    placeholder: { type: String, value: '按程序实际输出逐行填写' },
    locked: { type: Boolean, value: false },
  },

  methods: {
    onInput(this: any, e: any) {
      this.triggerEvent('change', { value: e.detail.value });
    },
  },
});
