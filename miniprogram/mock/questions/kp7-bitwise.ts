/**
 * 第一章 · 运算符与数据类型 —— 知识点 7：位运算入门
 *
 * 围绕：
 *   - & | ^ ~ << >> 的语义（与逻辑运算的区别）
 *   - 左移右移与「乘除 2 的幂」的关系
 *   - 有符号数右移的实现定义性
 *   - 位运算的典型用途：判断奇偶、取某一位、开关位
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const KP7_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 位运算结果 ---------------- */
  {
    id: 'q_c_0033',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise'],
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
          '    int a = 12, b = 10;',
          '    printf("%d\\n", a & b);',
          '    printf("%d\\n", a | b);',
          '    printf("%d\\n", a ^ b);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '三行都是十进制数字',
    },
    answer: { expected: ['8', '14', '6'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '先把两个数写成二进制（各 4 位就够）：\n'
        + '  12 = 1100\n'
        + '  10 = 1010\n'
        + '逐位运算：\n'
        + '  与 &：每一位都取「都为 1 才为 1」→ 1000 = **8**\n'
        + '  或 |：每一位都取「有一个为 1 就为 1」→ 1110 = **14**\n'
        + '  异或 ^：每一位取「不同才为 1」→ 0110 = **6**\n'
        + '⚠️ 最容易混的地方：**`&` 和 `&&` 不是一个东西**。\n'
        + '  `12 && 10` 的结果是 1（两个都非零 → 逻辑真）；\n'
        + '  `12 & 10` 的结果是 8（逐位相与）。\n'
        + '把 `if (a && b)` 写成 `if (a & b)` 时**不一定报错**，'
        + '但语义已从「a 和 b 都非零」变成「a 和 b 的二进制有公共 1 位」，是个静默的逻辑 bug。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 移位与乘除 ---------------- */
  {
    id: 'q_c_0034',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise'],
    type: 'single-choice',
    difficulty: 2,
    payload: {
      stem: '对于正整数 x，表达式 `x << 2` 等价于？',
      options: [
        { key: 'A', text: 'x + 2' },
        { key: 'B', text: 'x × 2' },
        { key: 'C', text: 'x × 4' },
        { key: 'D', text: 'x 的平方' },
      ],
      instantSubmit: true,
    },
    answer: 'C',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'C 正确。左移 n 位相当于乘以 2 的 n 次方，所以 `x << 2` = x × 4。\n'
        + '同理 `x >> 1` 相当于整除 2（`x >> n` = x / 2ⁿ，**向下取整**）。\n'
        + '⚠️ 三个必须知道的边界：\n'
        + '  ① **移位位数不能 ≥ 类型宽度**。对 32 位 int 写 `x << 32` 是未定义行为，'
        + '不同 CPU 上结果不同（x86 会把移位量按 31 取模，于是变成 `x << 0`）。\n'
        + '  ② **左移溢出是未定义行为**。`1 << 31` 对 int 是 UB（符号位被改），'
        + '想要 2147483648 得用 `1u << 31` 或 `1LL << 31`。\n'
        + '  ③ **负数右移是实现定义**（算术右移补 1 还是逻辑右移补 0 由编译器决定），'
        + '所以 `-8 >> 1` 不要指望得到确定的答案。\n'
        + 'D 错误：平方没有位运算捷径，那是完全不同的操作。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. 位运算的典型用途 ---------------- */
  {
    id: 'q_c_0035',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise'],
    type: 'multi-choice',
    difficulty: 3,
    payload: {
      stem: '下列关于位运算用途的说法，正确的有哪些？',
      options: [
        { key: 'A', text: '`x & 1` 可以用来判断 x 的奇偶（结果为 1 表示奇数）' },
        { key: 'B', text: '`x & (1 << k)` 可以用来判断 x 的第 k 位是否为 1' },
        { key: 'C', text: '`x |= (1 << k)` 可以把 x 的第 k 位置为 1' },
        { key: 'D', text: '`x ^ x` 的结果是 1' },
        { key: 'E', text: '`x ^ x` 的结果是 0，这个性质常用来「清零」或查重' },
      ],
    },
    answer: ['A', 'B', 'C', 'E'],
    judge: { strategy: 'set', options: { partialCredit: true } },
    analysis: {
      text:
        'A 正确：二进制最低位为 1 就是奇数，所以 `x & 1` 是最快的奇偶判断。\n'
        + 'B 正确：`1 << k` 造出一个「只有第 k 位是 1」的掩码，与 x 相与，'
        + '非零说明 x 的第 k 位是 1。注意结果不是 0/1 而是 0 或 2ᵏ，'
        + '所以一般要写成 `if (x & (1 << k))` 而不是 `== 1`。\n'
        + 'C 正确：`|=` 是「或赋值」。或上掩码只会把目标位置 1，不会影响其他位。\n'
        + 'D 错误：`x ^ x` 每一位都相同，异或得 0。\n'
        + 'E 正确：这是异或最常用的性质 —— **a ^ a = 0、a ^ 0 = a**。'
        + '经典应用「找出只出现一次的数」：把数组全部异或起来，'
        + '成对出现的数互相抵消，剩下就是那个唯一的数。\n'
        + '补充一个更常用的清位写法：`x &= ~(1 << k)` —— 取反后与，只把第 k 位清 0。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 交换两个数 ---------------- */
  {
    id: 'q_c_0036',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise'],
    type: 'single-choice',
    difficulty: 4,
    payload: {
      stem: '下面用异或交换两个整数的写法，有什么问题？',
      code: {
        lang: 'c',
        content: [
          'void swap_xor(int *a, int *b) {',
          '    *a = *a ^ *b;',
          '    *b = *a ^ *b;',
          '    *a = *a ^ *b;',
          '}',
        ].join('\n'),
      },
      options: [
        { key: 'A', text: '没有交换效果' },
        { key: 'B', text: '当两个指针指向同一个变量时会失败' },
        { key: 'C', text: '只能交换正数' },
        { key: 'D', text: '编译报错' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。异或交换三步走对**两个不同的变量**是有效的：\n'
        + '  第 1 步后 *a = a^b；第 2 步后 *b = (a^b)^b = a；第 3 步后 *a = (a^b)^a = b。\n'
        + '但**如果 a 和 b 指向同一块内存**（比如调用 `swap_xor(&x, &x)`），'
        + '三次异或都作用在同一个变量上：\n'
        + '  *a = x^x = 0 → *b 也是这个变量 = 0 → 再做 0^0 = 0。结果原值**被抹成 0**。\n'
        + '这类 bug 在「自己和自己交换」时才会出现（比如数组元素的排序交换里），很难排查。\n'
        + '⚠️ 还有一个现实理由：现代编译器和 CPU 对「用临时变量交换」优化得非常好，'
        + '异或交换**并不更快**，却牺牲了可读性、还引入了这个陷阱。\n'
        + '所以工程结论是：**用临时变量交换**（`int t = *a; *a = *b; *b = t;`），'
        + '异或交换只该出现在面试题和位运算教学里。\n'
        + 'C 错误：异或对负数的位模式一视同仁，可以正常交换（只要不是同一变量）。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. ~ 与补码 ---------------- */
  {
    id: 'q_c_0037',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise'],
    type: 'program-output',
    difficulty: 4,
    payload: {
      stem: '在 32 位补码平台上，阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    int x = 5;',
          '    printf("%d\\n", ~x);',
          '    printf("%d\\n", ~x + 1);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '第二行是「取反加一」的结果',
    },
    answer: { expected: ['-6', '-5'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`~` 是**按位取反**（包括符号位）。5 的补码是 `...00000101`，'
        + '取反得 `...11111010`，这正是 **-6** 的补码。所以输出 -6。\n'
        + '规律：对任意整数 x 都有 `~x == -x - 1`。验算：-5-1 = -6 ✓\n'
        + '第 2 行：`~x + 1` = -6 + 1 = **-5**。\n'
        + '⚠️ 这里的意义在于：**「取反加一」就是求相反数**，'
        + '这正是补码表示法的核心定义（`-x = ~x + 1`）。'
        + '所以「求负」和「取反加一」是同一件事的两个名字。\n'
        + '顺带说明另一个易混点：`~` 是**逐位取反**，`!` 是**逻辑取反**。\n'
        + '  `~5` = -6（改的是二进制位）\n'
        + '  `!5` = 0（只看真假）\n'
        + '搞混这两个的后果是「代码能编译、逻辑全错」。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
