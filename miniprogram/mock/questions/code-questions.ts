/**
 * 第一章 · 运算符与数据类型 —— 编程题（code-editor，走服务端沙箱判分）
 *
 * ⚠️ 本文件里的每一道题都必须在 `judge-service/src/questions/mock-plans.ts`
 *    里有对应的判题计划（planRef 一一对应），否则提交会返回「题目未配置判题计划」。
 *    `tests/wiring.test.mjs` 会强制检查这个对应关系。
 *
 * ⚠️ 编程题**绝不能**出现在 practice / review 关里 —— 那里会下发本地判分依据，
 *    而编程题必须服务端判分（客户端拿不到测试点）。
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const CODE_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 读入 n，求 1..n 的和（类型溢出考点） ---------------- */
  {
    id: 'q_c_0005',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue', 'kp_c_operator_int_div'],
    type: 'code-editor',
    difficulty: 3,
    payload: {
      stem:
        '编程题：读入一个正整数 n，输出 1 到 n 的累加和。\n'
        + '示例：输入 5，输出 15（因为 1+2+3+4+5=15）。\n'
        + '注意：n 最大可到 100000，请选择合适的数据类型，避免溢出。',
      language: 'c',
      template: [
        '#include <stdio.h>',
        '',
        'int main(void) {',
        '    int n, i;',
        '    long long sum = 0;',
        '    /* 在这里读入 n，并累加 1..n */',
        '',
        '    printf("%lld\\n", sum);',
        '    return 0;',
        '}',
      ].join('\n'),
      placeholder: '在骨架代码的注释处补完逻辑',
    },
    // 判分依据在服务端：题目的测试点存放在题库的 judge_plans 集合里。
    // 客户端这里的 answer 只作为「题库自检」用的摘要，sanitize 时会剔除。
    answer: { kind: 'testcases', planRef: 'plan_q_c_0005_c' },
    judge: { strategy: 'sandbox', options: { compare: 'exact-lines' } },
    analysis: {
      text:
        '标准做法是循环累加：sum 从 0 开始，i 从 1 到 n，每次 sum += i。\n'
        + '关键点是**数据类型**：n 到 100000 时，和约为 5×10^9，超过 int 上限（约 2.1×10^9），'
        + '必须用 long long，并且 printf 用 %lld。这就是本题的主要考察点——\n'
        + '很多同学的逻辑完全正确，却因为类型选小而拿到错误的输出。\n'
        + '进阶写法：用等差数列公式 n × (n+1) / 2 一步算完，O(1)。'
        + '但要注意先乘后除、并保证乘法本身不溢出（要用 long long 计算）。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 读入若干整数直到 EOF，求最大值（初值陷阱） ---------------- */
  {
    id: 'q_c_0006',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_loop_continue'],
    type: 'code-editor',
    difficulty: 4,
    payload: {
      stem:
        '编程题：不断读入整数直到输入结束（EOF），输出这些整数中的最大值。\n'
        + '输入保证至少有一个整数，且所有整数都在 int 范围内。\n'
        + '提示：用 while (scanf("%d", &x) == 1) 的形式循环读入，可以自然处理 EOF。',
      language: 'c',
      template: [
        '#include <stdio.h>',
        '',
        'int main(void) {',
        '    /* 读入若干整数（以 EOF 结束），输出其中的最大值 */',
        '',
        '    return 0;',
        '}',
      ].join('\n'),
      placeholder: '补完读入与求最大值的逻辑',
    },
    answer: { kind: 'testcases', planRef: 'plan_q_c_0006_c' },
    judge: { strategy: 'sandbox', options: { compare: 'exact-lines' } },
    analysis: {
      text:
        '用 scanf 的返回值做循环条件是最简洁的写法：scanf 成功读到 1 个整数返回 1，'
        + '遇到 EOF 返回 EOF（-1），所以 while (scanf("%d", &x) == 1) 能完整读完全部输入。\n'
        + '初始最大值不要写 0——如果输入全是负数，答案就会错。正确做法是：'
        + '把第一个读到的数直接作为初值，或者用 INT_MIN。这是本题的隐藏陷阱。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 判断闰年（逻辑运算符综合） ---------------- */
  {
    id: 'q_c_0043',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops', 'kp_c_operator_int_div'],
    type: 'code-editor',
    difficulty: 3,
    payload: {
      stem:
        '编程题：读入一个年份 y（1 ≤ y ≤ 9999），判断它是不是闰年。\n'
        + '是闰年输出 `yes`，否则输出 `no`。\n'
        + '闰年的判定规则：能被 4 整除但不能被 100 整除，或者能被 400 整除。\n'
        + '示例：输入 2000 → 输出 yes；输入 1900 → 输出 no。',
      language: 'c',
      template: [
        '#include <stdio.h>',
        '',
        'int main(void) {',
        '    int y;',
        '    scanf("%d", &y);',
        '    /* 用逻辑运算符组合出闰年条件，按要求输出 yes 或 no */',
        '',
        '    return 0;',
        '}',
      ].join('\n'),
      placeholder: '注意短路求值与 && / || 的优先级',
    },
    answer: { kind: 'testcases', planRef: 'plan_q_c_0043_c' },
    judge: { strategy: 'sandbox', options: { compare: 'exact-lines' } },
    analysis: {
      text:
        '正确条件：`(y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)`。\n'
        + '⚠️ 括号不能省：`&&` 的优先级高于 `||`，所以不加括号的 '
        + '`y%4==0 && y%100!=0 || y%400==0` **恰好也是对的**——但这是「碰巧对」，'
        + '靠的是优先级规则，读代码的人得停下来想一遍。加括号是零成本的清晰化。\n'
        + '⚠️ 最常见的错误：只判 `y % 4 == 0`，这样 1900 会被误判成闰年。\n'
        + '1900 能被 4 整除但能被 100 整除、且不能被 400 整除，所以**不是**闰年。'
        + '这就是「世纪年特例」，也是本题刻意设置的测试点。\n'
        + '另一个易错点：`y % 4 == 0` 里的 `==` 写成 `=`，条件恒为真 —— 见知识点 5。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 统计 1..n 中满足条件的数（循环 + 位运算） ---------------- */
  {
    id: 'q_c_0044',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise', 'kp_c_loop_continue'],
    type: 'code-editor',
    difficulty: 4,
    payload: {
      stem:
        '编程题：读入一个正整数 n（1 ≤ n ≤ 1000000），'
        + '统计 1 到 n 中「是 3 的倍数，但不是 5 的倍数」的整数有多少个。\n'
        + '示例：输入 10 → 1..10 中 3 的倍数是 3、6、9，都不是 5 的倍数，所以输出 3。',
      language: 'c',
      template: [
        '#include <stdio.h>',
        '',
        'int main(void) {',
        '    int n, i, cnt = 0;',
        '    scanf("%d", &n);',
        '    /* 遍历 1..n，统计满足条件的数的个数 */',
        '',
        '    printf("%d\\n", cnt);',
        '    return 0;',
        '}',
      ].join('\n'),
      placeholder: '可以只用一次循环；注意 continue 的用法',
    },
    answer: { kind: 'testcases', planRef: 'plan_q_c_0044_c' },
    judge: { strategy: 'sandbox', options: { compare: 'exact-lines' } },
    analysis: {
      text:
        '直观写法：循环 i 从 1 到 n，`if (i % 3 == 0 && i % 5 != 0) cnt++;`\n'
        + '也可以写成「提前跳过」的风格，正好练习 continue：\n'
        + '```c\nfor (i = 1; i <= n; i++) {\n'
        + '    if (i % 3 != 0) continue;\n'
        + '    if (i % 5 == 0) continue;\n'
        + '    cnt++;\n}\n```\n'
        + '⚠️ 边界检查：n 最大 1000000，`i <= n` 用的是 `<=` 还是 `<` 会差 1 个元素。'
        + '这类「差一错误」（off-by-one）是循环题最高频的失分点，'
        + '测试点里专门放了 n=1（此时答案是 0）来卡这个边界。\n'
        + '数学解法（进阶）：3 的倍数有 ⌊n/3⌋ 个，其中 15 的倍数（3 和 5 的公倍数）'
        + '有 ⌊n/15⌋ 个，答案是两者相减。O(1) 完成，但要注意整除的向下取整语义。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 累加各位数字（while + 取模） ---------------- */
  {
    id: 'q_c_0045',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div', 'kp_c_loop_continue'],
    type: 'code-editor',
    difficulty: 4,
    payload: {
      stem:
        '编程题：读入一个非负整数 n（0 ≤ n ≤ 2000000000），'
        + '输出它**各个数位上的数字之和**。\n'
        + '示例：输入 12345 → 1+2+3+4+5 = 15，输出 15；输入 0 → 输出 0。',
      language: 'c',
      template: [
        '#include <stdio.h>',
        '',
        'int main(void) {',
        '    long long n, sum = 0;',
        '    scanf("%lld", &n);',
        '    /* 反复取出最后一位并累加，然后去掉最后一位 */',
        '',
        '    printf("%lld\\n", sum);',
        '    return 0;',
        '}',
      ].join('\n'),
      placeholder: '用 % 10 取末位、用 / 10 去掉末位',
    },
    answer: { kind: 'testcases', planRef: 'plan_q_c_0045_c' },
    judge: { strategy: 'sandbox', options: { compare: 'exact-lines' } },
    analysis: {
      text:
        '核心两行：`sum += n % 10;` 取出末位累加，`n /= 10;` 去掉末位，循环直到 n 变成 0。\n'
        + '```c\nwhile (n > 0) { sum += n % 10; n /= 10; }\n```\n'
        + '⚠️ 这里考察两个知识点：\n'
        + '  ① 整数除法 `n / 10` 是**截断**的（1234/10 = 123），正好等价于「去掉末位」；'
        + '  ② 取模 `n % 10` 得到末位数字。\n'
        + '这个组合是「按位拆解整数」的标准套路，后面学字符串、进制转换时会反复用到。\n'
        + '⚠️ 边界陷阱：**n = 0 时 while (n > 0) 一次都不执行**，'
        + '循环体里累加初值不能依赖循环，sum 必须初始化为 0 —— 这正好得到正确答案 0。'
        + '如果用的是 do-while，n=0 也会进一次循环，结果同样正确；'
        + '但如果逻辑写反（比如先除再取模）就会出错。测试点专门放了 n=0。\n'
        + '⚠️ 还有一个隐蔽问题：题目说 n 可到 2000000000（2×10^9），'
        + '虽然勉强在 int 范围内（2147483647），但为了不踩边界，'
        + '骨架代码里直接用 long long 更稳 —— 这是「防御性选型」，成本为零。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
