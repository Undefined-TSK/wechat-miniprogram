/**
 * 第一章 · 运算符与数据类型 —— 知识点 5：关系运算与逻辑运算
 *
 * 围绕：
 *   - 赋值 `=` 与相等 `==` 的经典笔误
 *   - 关系表达式的值是 int 0/1，不是布尔类型（C99 前没有 bool）
 *   - 逻辑运算的短路求值（&& 与 ||）
 *   - 运算符优先级：&& 高于 ||，关系运算高于逻辑运算
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP5_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 短路求值 ---------------- */
  {
    id: 'q_c_0023',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops'],
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
          '    int a = 0, b = 0, c = 0;',
          '    int r = (a != 0) && (++b > 0);',
          '    printf("r=%d b=%d\\n", r, b);',
          '    int s = (a == 0) || (++c > 0);',
          '    printf("s=%d c=%d\\n", s, c);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '注意被短路掉的那个表达式有没有执行',
    },
    answer: { expected: ['r=0 b=0', 's=1 c=0'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：a 是 0，`a != 0` 为假。`&&` 的**短路规则**是「左边为假就不再算右边」，'
        + '所以 `++b > 0` 根本没执行，b 保持 0，整个表达式得 0。\n'
        + '第 2 行：a 是 0，`a == 0` 为真。`||` 的短路规则是「左边为真就不再算右边」，'
        + '所以 `++c > 0` 也没执行，c 保持 0，整个表达式得 1。\n'
        + '核心价值：短路不只是性能优化，它是**语义保证**。'
        + '典型用法 `if (p != NULL && p->value > 0)` —— 正是靠短路才能安全解引用，'
        + '否则取空指针成员会直接崩溃。反过来，如果写成 `if (p->value > 0 && p != NULL)`，'
        + '检查顺序错了，程序照样崩。**有副作用的表达式别写在逻辑右边**，'
        + '因为「它到底执不执行」依赖左边的值，读代码的人很容易看漏。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. = 与 == ---------------- */
  {
    id: 'q_c_0024',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem:
        '初学者写了 `if (x = 5) { ... }`（本意是判断 x 是否等于 5），会发生什么？',
      options: [
        { key: 'A', text: '编译报错 —— 条件里不能出现赋值' },
        { key: 'B', text: 'x 被赋值为 5，条件恒为真，分支**总会**执行' },
        { key: 'C', text: 'x 被赋值为 5，但条件按 x 的旧值判断' },
        { key: 'D', text: 'x 保持不变，条件按是否正确赋值来判断' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。`=` 是赋值运算符，本身有值（就是赋进去的那个值），所以 `x = 5` 的值是 5，'
        + '非零即为真 → 分支总会执行，同时 x 被偷偷改成了 5。\n'
        + '⚠️ 这是 C 语言最著名的「一个字间距引发的 bug」。它**不是编译错误**，'
        + '现代编译器一般给 `warning: suggest parentheses around assignment`，但默认不拦截。\n'
        + '防御写法两种：\n'
        + '  ① 把常量写在左边：`if (5 == x)` —— 这样写成 `if (5 = x)` 会**直接编译报错**，'
        + '因为常量不能被赋值。这叫「Yoda 条件」，是 C 圈流传很广的防呆技巧。\n'
        + '  ② 把编译器的 `-Wparentheses` 打开并当作错误处理。\n'
        + '注意：赋值表达式有值这一点本身是**特性**不是缺陷，'
        + '`while ((c = getchar()) != EOF)` 就是依赖它才写得这么简洁。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 关系表达式的值 ---------------- */
  {
    id: 'q_c_0025',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops'],
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
          '    int a = 3, b = 5;',
          '    printf("%d\\n", a < b);',
          '    printf("%d\\n", a > b);',
          '    printf("%d\\n", a < b < 1);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '三行都是数字',
    },
    answer: { expected: ['1', '0', '0'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`a < b` 为真，在 C 里真用 **1** 表示（不是任何非零值），所以输出 1。\n'
        + '第 2 行：`a > b` 为假，用 **0** 表示。\n'
        + '第 3 行：**这是本题的坑**。`<` 是**左结合**的，所以 `a < b < 1` 等价于 `(a < b) < 1`，'
        + '即 `1 < 1`，为假，输出 0。\n'
        + '很多人以为它会像数学那样写成「3 < 5 < 1」，但 C 里这种链式比较是**逐次求值**的，'
        + '几乎永远得不到你想的结果。想表达「5 在 3 和 1 之间」必须写成 `a < b && b < 1`。\n'
        + '⚠️ 顺带一个常见写法：`a - b` 这种算术结果是任意整数，'
        + '而关系运算的结果**保证只有 0 或 1**。所以 `printf("%d", a < b)` 永远只会打印 0 或 1。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 逻辑运算的优先级 ---------------- */
  {
    id: 'q_c_0026',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops'],
    type: 'single-choice',
    difficulty: 3,
    payload: {
      stem: '表达式 `1 || 0 && 0` 的结果是？',
      options: [
        { key: 'A', text: '0' },
        { key: 'B', text: '1' },
        { key: 'C', text: '语法错误' },
        { key: 'D', text: '不确定，取决于编译器' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。`&&` 的优先级**高于** `||`，所以表达式等价于 `1 || (0 && 0)`，'
        + '先算 `0 && 0` 得 0，再算 `1 || 0` 得 1。\n'
        + '⚠️ 危险点：如果你本来想表达 `(1 || 0) && 0`，结果会是 0 —— '
        + '**一样写对语法、结果却完全相反**，而且没有任何报错。\n'
        + '优先级速记（从高到低）：\n'
        + '  算术 `* / %` > 关系 `< <= > >=` > 相等 `== !=` > 逻辑与 `&&` > 逻辑或 `||`\n'
        + '经验法则：**只要一个表达式里同时出现 && 和 ||，就加括号**。'
        + '括号不花钱，但读代码的人不必去背优先级表。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 逻辑取反 ---------------- */
  {
    id: 'q_c_0027',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem: '下列关于 `!` （逻辑非）的说法，正确的是？',
      options: [
        { key: 'A', text: '`!5` 的结果是 -5' },
        { key: 'B', text: '`!5` 的结果是 0，因为 5 为真，取反得假' },
        { key: 'C', text: '`!` 只能作用于 0 或 1' },
        { key: 'D', text: '`!!5` 的结果是 5' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。`!` 是**逻辑**非：先把操作数当「真假」看（非 0 即真），再取反，'
        + '结果是 int 0 或 1。所以 `!5` 得 0。\n'
        + 'A 错误：`-5` 是算术取负，那是单目运算符 `-`，与 `!` 完全是两回事。'
        + '`!5` 是 0，`-5` 是 -5。\n'
        + 'C 错误：`!` 可以作用于任意标量表达式，`!x` 对任何非零 x 都得 0。\n'
        + 'D 错误：`!!5` = `!(!5)` = `!(0)` = **1**。'
        + '这个写法很常见 —— 它的作用是「把任意值规范成 0 或 1」，'
        + '比 `x != 0` 更短，但可读性差一些。\n'
        + '⚠️ 别把 `!` 和 `!=` 看混。`a = !b` 与 `a = !b` 里少写一个 `=` 是两种完全不同的语义。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
