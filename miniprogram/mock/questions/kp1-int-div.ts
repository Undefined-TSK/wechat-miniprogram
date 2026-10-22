/**
 * 第一章 · 运算符与数据类型 —— 知识点 1：整数除法与取模
 *
 * 这一组题围绕 C 语言新手最高频的翻车点：
 *   - 两个整数相除会「截断」而不是四舍五入
 *   - 负数取模的符号规则（C99 起：结果符号与被除数一致）
 *   - 除零是运行时错误（程序直接崩），不是编译错误
 *   - 想得到小数必须至少一个操作数是浮点型
 */

import type { FullQuestion } from '../../engine/types';

/** 统一的自编声明。所有题目共用，避免逐题重复写错 */
const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP1_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 基础：整数除法截断 ---------------- */
  {
    id: 'q_c_0001',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div'],
    type: 'single-choice',
    difficulty: 1,
    payload: {
      stem: 'C 语言中，表达式 7 / 2 的运算结果是？',
      options: [
        { key: 'A', text: '3.5' },
        { key: 'B', text: '3' },
        { key: 'C', text: '4' },
        { key: 'D', text: '编译错误' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        '两个 int 相除执行的是「整数除法」，小数部分被直接截断（不是四舍五入），所以 7 / 2 得 3。\n' +
        '想让结果变成 3.5，需要让至少一个操作数变成浮点型，例如 7 / 2.0 或 (double)7 / 2。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 负数取模（最容易被忽略） ---------------- */
  {
    id: 'q_c_0007',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div'],
    type: 'single-choice',
    difficulty: 3,
    payload: {
      stem: 'C99 标准下，表达式 -7 % 3 的结果是？',
      options: [
        { key: 'A', text: '1' },
        { key: 'B', text: '-1' },
        { key: 'C', text: '2' },
        { key: 'D', text: '-2' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'C99 起规定：取模结果的**符号与被除数相同**（不是与除数相同，也不是数学上的非负余数）。\n' +
        '-7 / 3 的整数商是 -2（向零截断），余数 = -7 - (-2 × 3) = -7 + 6 = -1，所以结果是 -1。\n' +
        '⚠️ 常见错误：很多人按数学直觉答 2（因为 -7 = 3×(-3) + 2）。这在数学上成立，'
        + '但 C 语言不是这么算的。\n'
        + '另外注意：负数取模的结果在 C89 里是「实现定义」的，所以写跨平台代码时不要依赖它。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 除零的行为 ---------------- */
  {
    id: 'q_c_0008',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem: 'C 语言中执行整数除法 `int x = 5 / 0;`，会发生什么？',
      code: { lang: 'c', content: 'int main(void) {\n    int x = 5 / 0;\n    printf("%d\\n", x);\n    return 0;\n}' },
      options: [
        { key: 'A', text: '编译报错，无法通过编译' },
        { key: 'B', text: 'x 被赋值为 0' },
        { key: 'C', text: '程序运行时崩溃（除零异常）' },
        { key: 'D', text: 'x 得到一个随机值，程序继续运行' },
      ],
      instantSubmit: true,
    },
    answer: 'C',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        '整数除以零在 C 语言里是**未定义行为**，在绝大多数平台上会触发硬件异常，'
        + '程序当场崩溃（Linux 上表现为 SIGFPE，Windows 上是整数除零异常）。\n'
        + '它**不是编译错误** —— 编译器检查不出「分母是常量 0」这种情况吗？现代编译器一般会警告'
        + '（gcc 会给 `warning: division by zero`），但警告不等于错误，仍然能生成可执行文件。\n'
        + '⚠️ 浮点除零不一样：5.0 / 0.0 不会崩，结果是 inf（无穷大），这是 IEEE 754 规定的。\n'
        + '所以「除零崩溃」只针对整数。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 程序输出：整数除法陷阱 ---------------- */
  {
    id: 'q_c_0009',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div'],
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
          '    int a = 10, b = 3;',
          '    printf("%d\\n", a / b);',
          '    printf("%d\\n", a % b);',
          '    printf("%.2f\\n", a / b);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '按程序实际输出逐行填写',
    },
    answer: { expected: ['3', '1', '3.00'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：10 / 3 是整数除法，得 3。\n'
        + '第 2 行：10 % 3 余 1。\n'
        + '第 3 行：**这是最容易错的一行**。虽然用了 %.2f 格式化输出，'
        + '但 `a / b` 这个表达式本身仍然在**整数域**计算，结果就是 3，'
        + '再被转成 double 打印成 3.00。\n'
        + '想打印 3.33，必须写成 `(double)a / b` 或 `a / 3.0` —— '
        + '关键在于**让除法发生时就处于浮点域**，而不是事后改变打印格式。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 浮点参与后的小数运算 ---------------- */
  {
    id: 'q_c_0010',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem: '下列哪个表达式能正确计算出 7 除以 2 的浮点结果 3.5？',
      options: [
        { key: 'A', text: '7 / 2' },
        { key: 'B', text: '(double)(7 / 2)' },
        { key: 'C', text: '(double)7 / 2' },
        { key: 'D', text: '7 % 2' },
      ],
      instantSubmit: true,
    },
    answer: 'C',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'C 正确：先把 7 转成 double，于是变成 7.0 / 2，2 会被隐式提升为 double，结果 3.5。\n'
        + 'A 错误：整数除法，得 3。\n'
        + 'B 错误：**先算出 7 / 2 = 3**，再把 3 转成 double 得到 3.0 —— '
        + '类型转换加在了「结果」上，而不是「操作数」上。这是极高频的错误写法。\n'
        + 'D 错误：% 是取模，7 % 2 得 1，而且整数取模的结果不可能是小数。\n'
        + '记住一句话：**转换要加在操作数上，不要加在整个表达式外面**。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
