/**
 * 第一章 · 运算符与数据类型 —— 知识点 3：字符常量与整型提升
 *
 * 围绕：
 *   - 字符常量是 int 类型（不是 char）
 *   - 整型提升（integer promotion）规则
 *   - 'A' 与 "A" 的区别（字符 vs 字符串）
 *   - 转义字符与 ASCII 码
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP3_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 字符常量与整型提升（填空） ---------------- */
  {
    id: 'q_c_0003',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_char_type'],
    type: 'fill-blank',
    difficulty: 2,
    payload: {
      stem: "C 语言中，字符常量 'A' 的 ASCII 码值是 ____①____；当它参与算术运算时，会被当作 ____②____ 类型处理。",
      blanks: [
        { key: 'b1', label: '①', hint: '填十进制数字' },
        { key: 'b2', label: '②', hint: '填类型名' },
      ],
      placeholder: '第 2 空可填 int 或 整型',
    },
    answer: {
      mode: 'multi',
      accepted: [['65'], ['int', '整型', 'int类型', 'int 类型', 'integer']],
    },
    judge: { strategy: 'normalize', options: { ignoreCase: true, partialCredit: false } },
    analysis: {
      text:
        "① 'A' 的 ASCII 码是 65（十进制）。常见要记的：'0' 是 48，'A' 是 65，'a' 是 97。\n"
        + "② 在算术表达式中，char 会发生「整型提升」（integer promotion），先被提升为 int 再参与运算，"
        + "所以 'A' + 1 得到的是 int 类型的 66，而不是 char。\n"
        + "⚠️ 一个反直觉的细节：**字符常量本身在 C 语言里就是 int 类型**，"
        + "sizeof('A') 在 C 里等于 4（而在 C++ 里等于 1）。\n"
        + "整型提升的意义：让运算在 int 宽度上进行，避免中间结果溢出。"
        + "比如两个 unsigned char 相加，如果不提升，结果会在 8 位内回绕。",
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 'A' 与 "A" 的区别 ---------------- */
  {
    id: 'q_c_0015',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_char_type'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem: "在 C 语言中，'A' 和 \"A\" 的区别是什么？",
      options: [
        { key: 'A', text: '没有区别，可以互换使用' },
        { key: 'B', text: "'A' 是字符常量，\"A\" 是字符串字面量，占用 2 个字节" },
        { key: 'C', text: "'A' 是字符串，\"A\" 是字符" },
        { key: 'D', text: '两者都是 int 类型' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        "单引号 'A' 是**字符常量**，类型是 int，值为 65。\n"
        + '双引号 "A" 是**字符串字面量**，类型是 char[2]，因为字符串末尾会自动补一个 '
        + "结束符 '\\0'，所以它占 2 个字节：{'A', '\\0'}。\n"
        + '⚠️ 最典型的错误：\n'
        + "  `if (c == \"A\")` —— 这里把字符和字符串比，"
        + '实际上比的是「c 的整数值」与「字符串首地址」，永远不相等（且编译器只给警告）。\n'
        + '  正确写法是 `if (c == \'A\')`。\n'
        + '这个错误在初学者代码里出现率极高，而且往往能编译通过，非常难查。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 字符参与运算的输出 ---------------- */
  {
    id: 'q_c_0016',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_char_type'],
    type: 'program-output',
    difficulty: 3,
    payload: {
      stem: '阅读下面的程序，写出它的完整输出（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          "    char c = 'A';",
          '    printf("%c\\n", c);',
          '    printf("%d\\n", c);',
          '    printf("%c\\n", c + 1);',
          '    printf("%d\\n", c + 1);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '四行输出（其中两行是字符，两行是数字）',
    },
    answer: { expected: ['A', '65', 'B', '66'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        "第 1 行：%c 按字符打印 c，输出 A。\n"
        + '第 2 行：%d 按十进制打印 c，输出它的 ASCII 码 65。\n'
        + '第 3 行：c + 1 先做整型提升得到 int 66，%c 把 66 当字符打印，即 B。\n'
        + '第 4 行：同一个表达式的值 66，用 %d 打印就是 66。\n'
        + '关键点：**同一个值，用 %c 打印是字符、用 %d 打印是数字** —— '
        + '区别只在 printf 的格式串，与值本身无关。\n'
        + '⚠️ 注意 %c 接收的参数其实应该是 int，printf 会把它截断到 unsigned char。'
        + '所以传一个超过 255 的值给 %c 是未定义行为。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 转义字符 ---------------- */
  {
    id: 'q_c_0017',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_char_type'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem: "字符常量 '\\0' 表示什么？",
      options: [
        { key: 'A', text: '字符 0' },
        { key: 'B', text: '空字符（ASCII 码 0），用作字符串结束标志' },
        { key: 'C', text: '数字 0 的 ASCII 码 48' },
        { key: 'D', text: '一个编译错误' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        "① '\\0' 是**空字符（null character）**，ASCII 码值为 0，不是字符 '0'。\n"
        + "② 它与 '0' 完全不同：'0' 的 ASCII 码是 **48**，是可打印的字符。\n"
        + "③ C 语言用 '\\0' 作为**字符串的结束标志**："
        + '字符数组存储字符串时，末尾必须有它，否则 printf("%s") 会一直读到内存里碰巧遇到 0 为止（越界读取）。\n'
        + '⚠️ 别混淆这三个：\n'
        + "  '0'   → ASCII 48，可打印的字符零\n"
        + "  '\\0'  → ASCII 0，字符串结束符（也可以写 0 或 NULL）\n"
        + '  0     → 整数零（在这个位置与 \'\\0\' 等价，因为 \'\\0\' 本身就是 int 0）',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 大小写转换 ---------------- */
  {
    id: 'q_c_0018',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_char_type'],
    type: 'single-choice',
    difficulty: 3,
    payload: {
      stem: "如何用算术运算把大写字母 'A' 转换成小写字母 'a'（不使用库函数）？",
      options: [
        { key: 'A', text: "c = 'A' + 26" },
        { key: 'B', text: "c = 'A' + ('a' - 'A')" },
        { key: 'C', text: "c = 'A' * 2" },
        { key: 'D', text: "c = 'A' - 32" },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        "B 正确：'a' - 'A' = 97 - 65 = 32，所以 'A' + 32 = 97 = 'a'。\n"
        + "写成 ('a' - 'A') 而不是直接写 32 的好处是**自文档化**："
        + '读代码的人一看就知道「这是在大小写之间转换」，而不是一个魔法数字。\n'
        + "⚠️ 但这两个写法都**不可移植**：C 标准只保证 'a' > 'A'，"
        + '并不保证相邻字母的码值是连续的（这一点在 EBCDIC 编码里不成立）。\n'
        + '健壮的做法：用 <ctype.h> 里的 tolower() / toupper()，'
        + '它们会正确处理非字母字符（比如 tolower(\'1\') 原样返回 \'1\'）。\n'
        + 'A 错误：+26 得到的是 91，即 \'[\'，不是字母。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
