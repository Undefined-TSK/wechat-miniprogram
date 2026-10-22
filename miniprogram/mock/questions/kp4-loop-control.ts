/**
 * 第一章 · 运算符与数据类型 —— 知识点 4：循环控制 continue / break
 *
 * 围绕：
 *   - continue（结束本次迭代）与 break（结束整个循环）的区别
 *   - for 循环里 continue 会执行「步进表达式」，while 里不会
 *   - 嵌套循环里 break 只跳出最内层
 *   - 循环变量的作用域与「多一条分号」这类手滑错误
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP4_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. continue 与 break 的区别（保留原题） ---------------- */
  {
    id: 'q_c_0004',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue'],
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
          '    int i, s = 0, c = 0;',
          '    for (i = 1; i <= 5; i++) {',
          '        if (i % 2 == 0) continue;',
          '        s += i;',
          '        c++;',
          '    }',
          '    printf("sum=%d\\n", s);',
          '    printf("count=%d\\n", c);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '按程序实际输出逐行填写',
    },
    answer: { expected: ['sum=9', 'count=3'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '循环 i 从 1 到 5，i 为偶数时 continue 跳过累加：\n'
        + 'i=1 → s=1, c=1；i=2 → 跳过；i=3 → s=4, c=2；i=4 → 跳过；i=5 → s=9, c=3。\n'
        + 'continue 只结束本次循环、不跳出循环，所以循环仍会继续到 i=5，最终输出 sum=9 与 count=3。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. continue 和 break 放在一起 ---------------- */
  {
    id: 'q_c_0019',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem:
        '关于 continue 和 break，下列说法正确的是？',
      options: [
        { key: 'A', text: 'continue 结束整个循环，break 结束本次迭代' },
        { key: 'B', text: 'continue 结束本次迭代（继续下一轮），break 结束整个循环' },
        { key: 'C', text: '两者作用完全相同，只是写法不同' },
        { key: 'D', text: '两者都只能用在 switch 语句里' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。\n'
        + 'continue：跳过本次迭代中它**后面**的语句，直接进入下一轮循环。\n'
        + 'break：立刻跳出**整个循环**，循环条件不再判断。\n'
        + '⚠️ 最容易混淆的一点：在 while 循环里用 continue，如果循环变量的自增写在循环体末尾，'
        + '它会被 continue 跳过 → 循环变量永不变化 → **死循环**。\n'
        + '而在 for 循环里没有这个问题，因为 for 的「步进表达式」是 continue 之后仍会执行的。\n'
        + 'D 错误：break 确实也能用在 switch 里（跳出 switch），但两者都**不限于** switch，'
        + '在 for / while / do-while 里都可以用。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. for + continue 的输出 ---------------- */
  {
    id: 'q_c_0020',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue'],
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
          '    int i;',
          '    for (i = 0; i < 6; i++) {',
          '        if (i == 3) continue;',
          '        if (i == 5) break;',
          '        printf("%d ", i);',
          '    }',
          '    printf("\\n");',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '注意最后打印的是一个换行使输出只有一行',
    },
    answer: { expected: ['0 1 2 4'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        'i 取值 0,1,2 时两个 if 都不成立，依次打印。\n'
        + 'i=3 时命中 continue，跳过 printf，进入下一轮 i=4。\n'
        + 'i=4 打印后 i 变 5，命中 break，**整个循环结束**（不会再有 i=5 的处理）。\n'
        + '所以输出是 `0 1 2 4 `（数字之间各有一个空格，末尾也有一个，'
        + '但程序随后打印了一个换行，所以整体只有一行）。\n'
        + '⚠️ 注意 `break` 之后 printf("\\n") 仍然会执行 —— 它已经不在循环体里了。'
        + '初学者常误以为 break 会结束整个程序。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 嵌套循环里的 break ---------------- */
  {
    id: 'q_c_0021',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue'],
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
          '    int i, j;',
          '    for (i = 1; i <= 3; i++) {',
          '        for (j = 1; j <= 3; j++) {',
          '            if (j == 2) break;',
          '            printf("%d%d\\n", i, j);',
          '        }',
          '    }',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '每行是两个数字连在一起，共 3 行',
    },
    answer: { expected: ['11', '21', '31'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '外层每循环一次，内层 j 从 1 开始：j=1 时打印，j=2 时 break 跳出**内层**循环。\n'
        + '所以每轮外层只打印一行，共 3 行：11、21、31。\n'
        + '核心结论：**break 只跳出「包含它的那一层」循环**，外层循环不受影响。\n'
        + '这正是本题的考察点 —— 很多同学以为一处 break 就能跳出全部嵌套循环。\n'
        + '如果确实想一次跳出两层，常用做法是设一个标志变量（flag），'
        + '或者用 goto（虽然有争议，但在「跳出多层循环」这一场景里是 C 标准认可的合理用法）。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. while 里 continue 的死循环陷阱 ---------------- */
  {
    id: 'q_c_0022',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue'],
    type: 'single-choice',
    difficulty: 4,
    payload: {
      stem: '下面这段程序会发生什么？',
      code: {
        lang: 'c',
        content: [
          'int i = 0;',
          'while (i < 5) {',
          '    if (i == 2) continue;',
          '    printf("%d ", i);',
          '    i++;',
          '}',
        ].join('\n'),
      },
      options: [
        { key: 'A', text: '输出 0 1 3 4，正常结束' },
        { key: 'B', text: '输出 0 1 3 4 5，正常结束' },
        { key: 'C', text: '输出 0 1 之后陷入死循环，程序卡死' },
        { key: 'D', text: '编译报错' },
      ],
      instantSubmit: true,
    },
    answer: 'C',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'C 正确。i 增加到 2 时命中 continue，直接跳回循环条件判断 —— '
        + '**`printf` 和 `i++` 都被跳过了**，所以 i 永远是 2，条件 2 < 5 永远成立 → 死循环。\n'
        + '⚠️ 这是 while + continue 的经典陷阱：自增语句在循环体末尾时会被 continue 跨过。\n'
        + '三种修法：\n'
        + '  ① 把 `i++` 提到 continue 之前（但要小心调整逻辑顺序）；\n'
        + '  ② 把自增写进循环条件：`while (i++ < 5)`；\n'
        + '  ③ 改用 for 循环 —— **for 的步进表达式在 continue 之后仍会执行**，天然没有这个坑。\n'
        + '这也是「能用 for 就别用 while」这条经验法则背后的真实原因。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
