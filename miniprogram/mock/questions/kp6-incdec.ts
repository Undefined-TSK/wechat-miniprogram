/**
 * 第一章 · 运算符与数据类型 —— 知识点 6：自增自减与副作用
 *
 * 围绕：
 *   - 前置 ++i 与后置 i++ 在「表达式里的值」上的差别
 *   - 未定义行为：同一个变量在一个表达式里被多次修改
 *   - sizeof 不求值、但 ++ 会求值（与知识点 2 呼应）
 *   - 参数求值顺序未定义
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP6_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 前自增 vs 后自增 ---------------- */
  {
    id: 'q_c_0028',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_incdec'],
    type: 'program-output',
    difficulty: 2,
    payload: {
      stem: '阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    int i = 5;',
          '    int a = i++;',
          '    int b = ++i;',
          '    printf("a=%d i=%d\\n", a, i);',
          '    printf("b=%d i=%d\\n", b, i);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '注意 i 的最终值',
    },
    answer: { expected: ['a=5 i=6', 'b=7 i=7'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '`i++`（后置）先取值 5 赋给 a，再让 i 变成 6。所以 a=5，i=6。\n'
        + '`++i`（前置）先把 i 从 6 加到 7，再取 7 赋给 b。所以 b=7，i=7。\n'
        + '记忆方法：**看 ++ 写在变量哪一边，就什么时候生效** ——\n'
        + '  写在左边（++i）：先加，后用；\n'
        + '  写在右边（i++）：先用，后加。\n'
        + '⚠️ 一个重要结论：**如果自增自减是独立的一条语句**（比如 `for (i = 0; i < n; i++)`），'
        + '前置和后置**完全等价**，结果和性能都没有区别。'
        + '「前置更快」的说法在 C++ 里对自定义类型成立（避免构造临时对象），'
        + '但对 C 的内置类型不成立 —— 编译器会优化成同一条机器指令。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 未定义行为 ---------------- */
  {
    id: 'q_c_0029',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_incdec'],
    type: 'single-choice',
    difficulty: 4,
    payload: {
      stem: '表达式 `i = i++ + 1;`（i 的初值为 5）的结果是？',
      options: [
        { key: 'A', text: 'i 等于 6' },
        { key: 'B', text: 'i 等于 7' },
        { key: 'C', text: '这是未定义行为，不同编译器结果可能不同' },
        { key: 'D', text: '编译报错' },
      ],
      instantSubmit: true,
    },
    answer: 'C',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'C 正确。这属于 **未定义行为（undefined behavior, UB）**。\n'
        + '原因：在同一个表达式里对变量 i 做了两次「无顺序保证」的修改'
        + '（一次是 `i++` 的副作用，一次是 `i = ...` 的赋值），'
        + 'C 标准没有规定它们的先后，所以结果不确定。\n'
        + '⚠️ 关键在于：**UB 不等于「随便一个值」，而是「编译器可以做任何事」**。'
        + '实际观察到过：gcc -O0 得 6、gcc -O2 得 7、clang 直接优化掉整条语句，'
        + '甚至有人遇到过循环被优化成死循环。\n'
        + '这也解释了为什么「本地跑对了、交上去判题错了」这种情况在 C 里特别常见 —— '
        + '判题机和你的机器不是同一个编译器版本、不同优化级别。\n'
        + '写代码的纪律：**一个变量在一个表达式里最多修改一次**。'
        + '想要明确语义就拆成两句：`i++; i = i + 1;`。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 自增参与运算的输出 ---------------- */
  {
    id: 'q_c_0030',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_incdec'],
    type: 'program-output',
    difficulty: 3,
    payload: {
      stem: '阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    int i = 1;',
          '    printf("%d ", i++);',
          '    printf("%d ", i);',
          '    printf("%d ", ++i);',
          '    printf("%d\\n", i);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '输出只有一行，四个数字',
    },
    answer: { expected: ['1 2 3 3'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 个：`i++` 取旧值 1 打印，然后 i 变成 2。输出 1。\n'
        + '第 2 个：直接打印 i，此时是 2。输出 2。\n'
        + '第 3 个：`++i` 先把 2 加到 3，再取 3 打印。输出 3。\n'
        + '第 4 个：i 仍是 3。输出 3。\n'
        + '所以一行输出 `1 2 3 3`。\n'
        + '⚠️ 与上一题对比：这里每个 printf 都是一个**独立的完整表达式**，'
        + '副作用在 printf 返回时已经结算完毕，所以结果**完全确定**、与编译器无关。\n'
        + '这正好说明 UB 的边界在哪：不是「用了 ++ 就危险」，'
        + '而是「同一个表达式里对同一变量修改多次」才危险。'
        + '把自增拆成独立语句是最省心的写法。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 用作数组下标 / 循环 ---------------- */
  {
    id: 'q_c_0031',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_incdec'],
    type: 'single-choice',
    difficulty: 3,
    payload: {
      stem: '下面两段代码，哪一段是正确的「遍历数组前 n 个元素」的写法？',
      options: [
        { key: 'A', text: '`for (i = 0; i <= n; i++) sum += a[i];`' },
        { key: 'B', text: '`for (i = 0; i < n; i++) sum += a[i];`' },
        { key: 'C', text: '`for (i = 1; i < n; i++) sum += a[i];`' },
        { key: 'D', text: '`for (i = 0; i < n; i++) sum += a[i++];`' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确：i 从 0 到 n-1，正好覆盖下标 0..n-1 这 n 个元素。\n'
        + 'A 错误：`i <= n` 会多访问一次 `a[n]` —— **越界读取**。'
        + '这是 C 语言最经典的 bug，而且它往往不报错（读到相邻内存的垃圾值），'
        + '表现为「结果偶尔多一个奇怪的数」。要注意 C 不做数组越界检查。\n'
        + 'C 错误：i 从 1 开始，漏掉了 `a[0]`。\n'
        + 'D 错误：`for` 的步进表达式已经有一次 `i++`，循环体里再 `a[i++]` 又自增一次，'
        + '于是 i 每次跨 2 —— 只遍历了一半元素，还可能越界。'
        + '而且**这和上一题的 UB 是同一类问题**：同一变量在相关表达式中被修改多次。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. sizeof 与自增（和知识点 2 联动） ---------------- */
  {
    id: 'q_c_0032',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_incdec', 'kp_c_sizeof'],
    type: 'program-output',
    difficulty: 4,
    payload: {
      stem: '阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    int i = 10;',
          '    printf("%zu\\n", sizeof(i++));',
          '    printf("%d\\n", i);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '在常见平台上 int 占 4 字节；注意第二行',
    },
    answer: { expected: ['4', '10'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`sizeof` 是**编译期**运算符，它只需要知道操作数的**类型**，'
        + '**不会对操作数求值**。所以 `i++` 没有被执行，sizeof 只算出了 int 的大小 = 4（字节），'
        + '用 %zu 输出 4。\n'
        + '第 2 行：因为上一行的 `i++` 从未执行，i 仍然是 **10**。\n'
        + '⚠️ 这里有个反直觉点：**`i++` 看起来有副作用，却根本没发生**。'
        + '如果换成 `sizeof(++i)`，结果一样是 4，i 依然是 10。\n'
        + '这正是「为什么 sizeof 是运算符而不是函数」的一个直观证据 —— '
        + '函数参数必须先求值，而 sizeof 不需要。\n'
        + '⚠️ 唯一会真正求值的情况是**变长数组** `int a[n]; sizeof(a)`，'
        + '此时长度在运行期确定，sizeof 才会求值。（变长数组是 C99 的可选特性，C11 起非必需）',
    },
    source: { ...SELF },
    status: 'published',
  },
];
