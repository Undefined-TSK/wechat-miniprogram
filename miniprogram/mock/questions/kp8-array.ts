/**
 * 第一章 · 运算符与数据类型 —— 知识点 8：数组入门
 *
 * 围绕：
 *   - 数组下标从 0 开始，最后一个元素是 n-1
 *   - C 不做越界检查（越界是 UB，不是异常）
 *   - 数组名在表达式中会「退化」为指向首元素的指针，sizeof 是例外
 *   - 数组初始化：花括号里的值个数少于长度时，其余补 0
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP8_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 下标范围 ---------------- */
  {
    id: 'q_c_0038',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_array_basic'],
    type: 'single-choice',
    difficulty: 1,
    payload: {
      stem: '声明 `int a[10];` 后，下面哪个是**合法**的元素访问？',
      options: [
        { key: 'A', text: 'a[10]' },
        { key: 'B', text: 'a[1] 到 a[9] 以及 a[0]' },
        { key: 'C', text: 'a[-1]' },
        { key: 'D', text: 'a[10] 和 a[0]' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。C 的数组下标从 **0** 开始，`int a[10]` 的合法下标是 **0 到 9**，共 10 个元素。\n'
        + 'A、D 错误：`a[10]` 是**越界**，它访问的是第 11 个位置 —— 而数组只有 10 个。\n'
        + 'C 错误：`a[-1]` 也是越界（负下标在 C 里就是 UB；只有 Python 那种语言才支持负下标）。\n'
        + '⚠️ 最关键的一点：**C 不做数组越界检查**。\n'
        + '越界读写既不会抛异常、也不会立刻崩溃，它会静默地去读写相邻内存：\n'
        + '  写在函数的局部数组越界 → 可能覆盖栈上的其他局部变量或返回地址（栈溢出攻击的原理）；\n'
        + '  读越界 → 得到一段垃圾数据，表现为「结果里多一个奇怪的数」。\n'
        + '所以 `for (i = 0; i <= n; i++) a[i]` 这类 `<=` 笔误，'
        + '在 C 里是**最危险的一类 bug**：它不一定报错，但结果一定是错的。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 数组遍历输出 ---------------- */
  {
    id: 'q_c_0039',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_array_basic'],
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
          '    int a[5] = {3, 1, 4, 1, 5};',
          '    int i, sum = 0;',
          '    for (i = 0; i < 5; i++) {',
          '        sum += a[i];',
          '    }',
          '    printf("%d\\n", sum);',
          '    printf("%d\\n", a[0] + a[4]);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '两行数字',
    },
    answer: { expected: ['14', '8'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：循环累加全部 5 个元素：3+1+4+1+5 = **14**。\n'
        + '第 2 行：`a[0]` 是第一个元素 3，`a[4]` 是**最后一个**元素（长度是 5，最大下标是 4），'
        + '所以 3 + 5 = **8**。\n'
        + '这里想强调的是「最后一个元素是 a[n-1] 而不是 a[n]」这个恒等式 ——\n'
        + '在心里的模型里要牢牢记住：**下标 = 偏移量**，'
        + '`a[i]` 的含义就是「从 a 的首地址往后走 i 个元素」，所以第 1 个元素偏移 0。\n'
        + '这个「从 0 数」的约定不是 C 特有的失误，它让 `a[i]` 能直接编译成一条「基址 + 偏移」的寻址指令，'
        + '不需要任何加减修正，是性能与简洁性的自然结果。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 数组名退化 ---------------- */
  {
    id: 'q_c_0040',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_array_basic', 'kp_c_sizeof'],
    type: 'program-output',
    difficulty: 4,
    payload: {
      stem:
        '在 32 位平台（指针 4 字节、int 4 字节）上，阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'void f(int arr[]) {',
          '    printf("%zu\\n", sizeof(arr));',
          '}',
          '',
          'int main(void) {',
          '    int a[10];',
          '    printf("%zu\\n", sizeof(a));',
          '    f(a);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '两行数字：一个很大、一个很小',
    },
    answer: { expected: ['40', '4'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：在 **main 里**，`sizeof(a)` 得到的是整个数组的字节数：10 × 4 = **40**。'
        + '因为这里 a 是「真正的数组」，编译器知道它的大小。\n'
        + '第 2 行：**这是本题的核心**。数组名作为函数实参传递时，'
        + '会「退化」（decay）成**指向首元素的指针**，所以形参 `int arr[]` '
        + '实际上等价于 `int *arr` —— 它只是个指针，不是数组。'
        + '指针在 32 位平台上是 4 字节，所以 `sizeof(arr)` 得到 **4**。\n'
        + '⚠️ 这个坑的现实后果：**在函数里无法用 sizeof 求出数组长度**。\n'
        + '所以正确的做法是额外传一个长度参数：`void f(int arr[], int n)`，'
        + '在调用处用 `f(a, sizeof(a) / sizeof(a[0]))` 计算长度。\n'
        + '这也是「为什么 C 的数组总是要配一个长度参数」的根本原因。'
        + '把这条和知识点 2（sizeof 运算符）连起来看，就理解了 sizeof 的两副面孔：'
        + '对数组名**在定义作用域内**是数组大小，一旦传出去就变成指针大小。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 部分初始化 ---------------- */
  {
    id: 'q_c_0041',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_array_basic'],
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
          '    int a[5] = {1, 2};',
          '    int b[5] = {0};',
          '    int i, sa = 0, sb = 0;',
          '    for (i = 0; i < 5; i++) {',
          '        sa += a[i];',
          '        sb += b[i];',
          '    }',
          '    printf("%d\\n", sa);',
          '    printf("%d\\n", sb);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '两行数字',
    },
    answer: { expected: ['3', '0'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`int a[5] = {1, 2};` 只给了 2 个初值，'
        + '**剩下的元素会被自动补 0**，所以数组是 {1, 2, 0, 0, 0}，和是 1+2 = **3**。\n'
        + '第 2 行：`int b[5] = {0};` 这是一个**惯用写法** —— 第一个元素显式给 0，'
        + '其余全部自动补 0，于是整个数组都是 0，和是 **0**。\n'
        + '⚠️ 最重要的对比：**局部数组不写初始化就是「不确定值」**。\n'
        + '  `int c[5];` → 元素是栈上的垃圾数据（**不是 0**！）；\n'
        + '  `int c[5] = {0};` → 全部是 0。\n'
        + '很多人以为「没初始化就是 0」，这在全局/静态数组里成立（存在 .bss 段，系统会清零），'
        + '但**局部数组在栈上，绝不会自动清零**。这是 C 里最高频的初学 bug 之一：'
        + '累加前忘了清零，结果里混进一个巨大的随机数。\n'
        + '注意 `int b[5] = {0}` 只写一个 0 就够，不需要写成 `{0,0,0,0,0}`。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 数组作为参数求最大值 ---------------- */
  {
    id: 'q_c_0042',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_array_basic'],
    type: 'fill-blank',
    difficulty: 3,
    payload: {
      stem:
        '下面函数用于求数组 `arr` 中 `n` 个元素的最大值（保证 n ≥ 1）。'
        + '请补全两处空白。\n'
        + '```c\nint max_of(int arr[], int n) {\n'
        + '    int i, m = arr[____①____];\n'
        + '    for (i = 1; i < n; i++) {\n'
        + '        if (arr[i] ____②____ m) m = arr[i];\n'
        + '    }\n    return m;\n}\n```',
      blanks: [
        { key: 'b1', label: '①', hint: '填一个下标' },
        { key: 'b2', label: '②', hint: '填一个比较运算符' },
      ],
      placeholder: '① 是数字，② 是运算符（如 <、>、==）',
    },
    answer: {
      mode: 'multi',
      accepted: [['0', '零'], ['>']],
    },
    judge: { strategy: 'normalize', options: { ignoreCase: true, partialCredit: false } },
    analysis: {
      text:
        '① 填 **0**：初值取数组的第一个元素。\n'
        + '⚠️ 如果写成 `m = 0`，当数组全为**负数**时结果就错了 —— '
        + '最大值会错误地变成 0（0 比所有负数都大），而 0 根本不是数组里元素。\n'
        + '「初值从输入数据里取」是求最值的安全套路，专业术语叫「用数据自身做哨兵」。\n'
        + '② 填 **>**：因为目标是「最大值」，所以发现更大的值就更新。\n'
        + '一个容易写错的细节：条件写成 `>=` 也能得到正确的最大值，'
        + '但如果还要求返回**最大值的下标**，`>=` 会返回最后一个最大值的位置、'
        + '`>` 返回第一个 —— 语义上有区别，看需求定。\n'
        + '另外注意形参写的是 `int arr[]`，按知识点里的说明它其实是 `int *arr`，'
        + '所以**另一个 n 参数是必需的**，函数内部无法自己算出长度。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
