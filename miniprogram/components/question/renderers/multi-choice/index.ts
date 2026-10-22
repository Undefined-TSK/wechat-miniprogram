/**
 * 渲染器 · 多项选择（判分策略 set）
 *
 * 接口契约：
 *   properties.options  Array<{ key, text }>
 *   properties.value    string[]          已选 key 数组（保持升序，便于比对）
 *   properties.reveal   Reveal | null
 *   properties.locked   boolean
 *   event change        { value: string[] }
 *
 * 作答形态：string[]
 */

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    options: { type: Array, value: [] },
    value: { type: Array, value: [] },
    reveal: { type: Object, value: null },
    locked: { type: Boolean, value: false },
  },

  data: {
    items: [] as Array<{ key: string; text: string; cls: string; mark: string }>,
    pickedCount: 0,
  },

  observers: {
    'options, value, reveal, locked'(this: any, options: any[], value: string[], reveal: any, locked: boolean) {
      const picked: string[] = Array.isArray(value) ? value : [];
      const correctKeys: string[] =
        reveal && Array.isArray(reveal.correctKeys) ? reveal.correctKeys : [];

      const items = (options || []).map(function (o: any) {
        const isPicked = picked.indexOf(o.key) >= 0;
        let cls = '';
        let mark = '';

        if (locked) {
          if (correctKeys.indexOf(o.key) >= 0) {
            // 判分后直接揭示所有正确项（漏选也标出来，用户才知道漏了什么）
            cls = 'is-right';
            mark = '✓';
          } else if (isPicked) {
            cls = 'is-wrong';
            mark = '✗';
          }
        } else if (isPicked) {
          cls = 'is-selected';
        }

        return { key: o.key, text: o.text, cls: cls, mark: mark };
      });

      this.setData({ items: items, pickedCount: picked.length });
    },
  },

  methods: {
    onTap(this: any, e: any) {
      if (this.data.locked) return;
      const key = e.currentTarget.dataset.key;
      const picked: string[] = (this.data.value || []).slice();
      const idx = picked.indexOf(key);
      if (idx >= 0) {
        picked.splice(idx, 1);
      } else {
        picked.push(key);
      }
      picked.sort();
      this.triggerEvent('change', { value: picked });
    },
  },
});
