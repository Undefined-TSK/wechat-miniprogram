/**
 * 第一章 · 运算符与数据类型 —— 知识点 2：sizeof 运算符
 *
 * 围绕三个认知点：
 *   - sizeof 是运算符（编译期求值），不是函数
 *   - sizeof 的结果类型是 size_t，用 %zu 打印
 *   - sizeof 数组得到的是「整个数组的字节数」，而数组名作为函数参数会退化成指针
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP2_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. sizeof 的本质（多选） ---------------- */
  {
    id: 'q_c_0002',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_sizeof'],
    type: 'multi-choice',
    difficulty: 3,
    payload: {
      stem: '下列关于 sizeof 运算符的说法，正确的有哪些？',
      options: [
        { key: 'A', text: 'sizeof 是运算符，不是标准库函数' },
        { key: 'B', text: 'sizeof 可以作用于类型名，例如 sizeof(int)' },
        { key: 'C', text: 'sizeof 的结果在运行时才确定，每次执行都可能不同' },
        { key: 'D', text: 'sizeof 的返回值类型是 size_t' },
      ],
    },
    answer: ['A', 'B', 'D'],
    judge: { strategy: 'set', options: { partialCredit: true } },
    analysis: {
      text:
        'A 正确：sizeof 是编译期运算符，不需要包含头文件即可使用。\n'
        + 'B 正确：sizeof(int) 合法，sizeof 既能接表达式也能接类型名。\n'
        + 'C 错误：对定长类型，sizeof 是编译期常量，同一平台下结果固定。\n'
        + '  ⚠️ 一个例外是变长数组（VLA），它的 sizeof 确实在运行时求值。'
        + '但 VLA 是 C99 的可选特性，且考试的语境下说「每次执行都可能不同」是错的。\n'
        + 'D 正确：sizeof 的结果类型是 size_t（无符号整数），用 %zu 输出。\n'
        + '  ⚠️ 不要用 %d 打印 sizeof 的结果 —— size_t 与 int 宽度不同，属于未定义行为。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. sizeof 表达式不求值 ---------------- */
  {
    id: 'q_c_0011',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_sizeof'],
    type: 'single-choice',
    difficulty: 3,
    payload: {
      stem: '执行下面的代码后，变量 i 的值是多少？',
      code: {
        lang: 'c',
        content: 'int i = 5;\nint n = sizeof(i++);\nprintf("%d\\n", i);',
      },
      options: [
        { key: 'A', text: '5' },
        { key: 'B', text: '6' },
        { key: 'C', text: '未定义' },
        { key: 'D', text: '编译错误' },
      ],
      instantSubmit: true,
    },
    answer: 'A',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'i 仍然是 5。\n'
        + '原因：sizeof 的操作数**不会被求值** —— 编译器只需要知道它的类型（int），'
        + '就能算出字节数，根本不需要真的执行 i++。\n'
        + '所以在 sizeof(i++) 里，i++ 这个副作用**不会发生**。\n'
        + '⚠️ 这是一个很经典的安全特性：`sizeof(arr) / sizeof(arr[0])` 求数组长度时，'
        + '如果 sizeof 会求值，那这个惯用法就会造成副作用。\n'
        + '（但在 sizeof 后面接变长数组时，操作数**会**被求值 —— 又一处 VLA 的特殊性。）',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 数组的 sizeof ---------------- */
  {
    id: 'q_c_0012',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_sizeof'],
    type: 'program-output',
    difficulty: 3,
    payload: {
      stem: '假设 int 占 4 字节，阅读下面的程序，写出它的输出。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    int a[10];',
          '    printf("%zu\\n", sizeof(a));',
          '    printf("%zu\\n", sizeof(a[0]));',
          '    printf("%zu\\n", sizeof(a) / sizeof(a[0]));',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '输出三行数字',
    },
    answer: { expected: ['40', '4', '10'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：sizeof(a) 是整个数组的字节数 = 10 × 4 = 40。\n'
        + '第 2 行：sizeof(a[0]) 是单个元素的字节数 = 4。\n'
        + '第 3 行：40 / 4 = 10，这就是数组长度。\n'
        + '`sizeof(a) / sizeof(a[0])` 是求数组长度的经典惯用法，'
        + '好处是**改元素类型或改长度时不用改代码**：把 int 换成 double，10 依然算得出来。\n'
        + '⚠️ 但注意：这个惯用法**只在数组还是数组时才有效**。'
        + '如果 a 是函数参数（已退化成指针），sizeof(a) 会变成 8（64 位下的指针大小），'
        + '算出来的「长度」就完全错了。见下一题。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 数组退化成指针 ---------------- */
  {
    id: 'q_c_0013',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_sizeof'],
    type: 'single-choice',
    difficulty: 4,
    payload: {
      stem: '假设 int 占 4 字节、指针占 8 字节。下面程序的输出是？',
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
          '    f(a);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      options: [
        { key: 'A', text: '40' },
        { key: 'B', text: '8' },
        { key: 'C', text: '4' },
        { key: 'D', text: '10' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        '输出 8，也就是一个指针的大小。\n'
        + '原因：**数组作为函数参数时会退化成指针**。`void f(int arr[])` 里的 arr '
        + '在编译器眼里等同于 `int *arr`，sizeof 得到的是指针大小而不是数组大小。\n'
        + '⚠️ 这就是为什么 C 语言里**不能**用 sizeof 在函数内部求数组长度 —— '
        + '即便语法上你写的是 `int arr[]` 看起来像数组，它其实已经是指针了。\n'
        + '正确做法：把长度**作为额外参数**传进去，例如 `void f(int arr[], int n)`。\n'
        + '这个坑非常隐蔽：在 main 里 sizeof 是 40，一进函数就变成 8，'
        + '很多人会以为是编译器坏了。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 常见类型的 sizeof ---------------- */
  {
    id: 'q_c_0014',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_sizeof'],
    type: 'multi-choice',
    difficulty: 2,
    payload: {
      stem: '在典型的 32/64 位平台上（int 占 4 字节、char 占 1 字节），下列哪些 sizeof 结果恒定为 1？',
      options: [
        { key: 'A', text: 'sizeof(char)' },
        { key: 'B', text: 'sizeof(int)' },
        { key: 'C', text: 'sizeof(unsigned char)' },
        { key: 'D', text: 'sizeof(short)' },
      ],
    },
    answer: ['A', 'C'],
    judge: { strategy: 'set', options: { partialCredit: true } },
    analysis: {
      text:
        'C 语言标准**只保证** sizeof(char) == 1 —— 这是标准的硬性规定，没有例外。\n'
        + '而 `signed char` 和 `unsigned char` 都是 char 的变体，宽度与 char 相同，'
        + '所以 A 和 C 也恒为 1。\n'
        + 'B 错误：sizeof(int) 在 16 位平台上是 2，在现代平台上是 4 —— **不恒定**。\n'
        + 'D 错误：sizeof(short) 标准只保证「不小于 2」，实际平台可能不同。\n'
        + '⚠️ 常见误解：很多人以为 sizeof(int) 恒为 4。标准并没有这么规定，'
        + '只是现代主流平台恰好都是 4。写可移植代码时要用 sizeof 而不是写死 4。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
