/**
 * 渲染器 · 单项选择（判分策略 exact）
 *
 * 接口契约：
 *   properties.options  Array<{ key, text }>
 *   properties.value    string            当前选中的 key
 *   properties.reveal   Reveal | null     判分后由容器传入，用于揭示正确项
 *   properties.locked   boolean           判分后锁定交互
 *   event change        { value: string }
 *
 * 作答形态：string
 */

Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    options: { type: Array, value: [] },
    value: { type: String, value: '' },
    reveal: { type: Object, value: null },
    locked: { type: Boolean, value: false },
  },

  data: {
    items: [] as Array<{ key: string; text: string; cls: string; mark: string }>,
  },

  observers: {
    'options, value, reveal, locked'(this: any, options: any[], value: string, reveal: any, locked: boolean) {
      const correctKeys: string[] =
        reveal && Array.isArray(reveal.correctKeys) ? reveal.correctKeys : [];

      const items = (options || []).map(function (o: any) {
        let cls = '';
        let mark = '';

        if (locked) {
          const isCorrect = correctKeys.indexOf(o.key) >= 0;
          const isPicked = value === o.key;

          if (isCorrect) {
            cls = 'is-right';
            mark = '✓';
          } else if (isPicked) {
            cls = 'is-wrong';
            mark = '✗';
          }
        } else if (value === o.key) {
          cls = 'is-selected';
        }

        return { key: o.key, text: o.text, cls: cls, mark: mark };
      });

      this.setData({ items: items });
    },
  },

  methods: {
    onTap(this: any, e: any) {
      if (this.data.locked) return;
      const key = e.currentTarget.dataset.key;
      this.triggerEvent('change', { value: key });
    },
  },
});
