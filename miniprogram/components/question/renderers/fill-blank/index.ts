/**
 * 渲染器 · 填空（判分策略 normalize / numeric / exact）
 *
 * 接口契约：
 *   properties.blanks       Array<{ key, label?, hint? }>
 *   properties.value        string[]      按空位顺序
 *   properties.placeholder  string        整体提示
 *   properties.locked       boolean
 *   event change            { value: string[] }
 *
 * 作答形态：string[]
 */

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    blanks: { type: Array, value: [] },
    value: { type: Array, value: [] },
    placeholder: { type: String, value: '' },
    locked: { type: Boolean, value: false },
  },

  data: {
    rows: [] as Array<{ key: string; label: string; hint: string; val: string }>,
  },

  observers: {
    'blanks, value'(this: any, blanks: any[], value: string[]) {
      const vals: string[] = Array.isArray(value) ? value : [];
      const list = Array.isArray(blanks) && blanks.length > 0 ? blanks : [{ key: 'b1', label: '' }];

      const rows = list.map(function (b: any, i: number) {
        return {
          key: b.key || 'b' + i,
          label: b.label || '',
          hint: b.hint || '',
          val: typeof vals[i] === 'string' ? vals[i] : '',
        };
      });

      this.setData({ rows: rows });
    },
  },

  methods: {
    onInput(this: any, e: any) {
      const index = Number(e.currentTarget.dataset.index);
      const val = e.detail.value;
      const path = 'rows[' + index + '].val';
      const patch: Record<string, unknown> = {};
      patch[path] = val;
      this.setData(patch);

      const out: string[] = [];
      const rows = this.data.rows as Array<{ val: string }>;
      for (let i = 0; i < rows.length; i++) {
        out.push(i === index ? val : rows[i].val || '');
      }
      this.triggerEvent('change', { value: out });
    },
  },
});
