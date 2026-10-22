/**
 * 第一章 · Boss 关专属题（服务端判分 / 限时）
 *
 * ═══════════════════════════════════════════════════════════════════
 *  ⚠️ 为什么一定要有「Boss 专属题」这个文件
 * ═══════════════════════════════════════════════════════════════════
 *
 * Boss 关（mode = 'boss'）**不下发 localJudgeKey**，走服务端判分。
 * 但服务端目前只认编程题（sandbox）这一条判分入口 —— 选择 / 填空 / 程序输出
 * 这类题的判分依据是「本地判分依据」本身，服务端没有对应的比对入口。
 *
 * 于是把练习关里的选择题直接搬进 Boss 关，会得到一个**必然错误的组合**：
 *   用户答对 → 客户端无判分依据 → 落到「题目配置异常」分支 → 判 0 分，
 *   并且详情里写着「请反馈给运营」。
 * 这个 bug 在练习关里完全看不见（那里一切正常），只在用户打 Boss 时暴露。
 *
 * 所以规则是：**本地判分关（practice / review）与服务端判分关（boss / challenge）
 * 的题目集合必须互斥**。`bank-validator.ts` 有一条专门的校验，
 * `tests/wiring.test.mjs` 会强制执行。
 *
 * 那 Boss 关放什么题？
 *   ① 编程题（sandbox，服务端判分）—— 但那是「手写代码」，不适合做「限时综合考」；
 *   ② 本文件的「Boss 专属题」—— 题目**只属于 Boss 关**，因此不会与本地判分冲突。
 *
 * 现阶段 Boss 关采取的是路线 ②：写一批「陷阱密度更高」的选择/输出题，
 * 只挂在 Boss 关上。它们在设计上承担的作用是：
 *   - 同一知识点、但换一个更容易踩坑的切入角度（不是练习关原题）
 *   - 限时压力下考察「识别陷阱」而不是「记忆」
 *
 * ⚠️ 长期方案（Phase 4 之后）：让服务端支持「选择题判分入口」，
 *    这样 Boss 关就能复用练习关的题，题库维护成本更低。
 *    在那之前，Boss 题必须独立维护 —— 这是当前架构的已知代价，已记入技术债。
 */

import type { FullQuestion } from '../../engine/types';

const SELF = { type: 'original', note: '自编', license: 'self' } as const;

export const BOSS_QUESTIONS: FullQuestion[] = [
  /* ---------------- 1. 复合表达式：除法 + 取模 + 优先级 ---------------- */
  {
    id: 'q_c_0050',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_operator_int_div'],
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
          '    int a = 17, b = 5;',
          '    printf("%d\\n", a / b * b);',
          '    printf("%d\\n", a - a / b * b);',
          '    printf("%d\\n", -a % b);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '三行数字，注意负数取模',
    },
    answer: { expected: ['15', '2', '-2'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`a / b` 得 3（截断），再 `* b` 得 **15**。'
        + '注意这里考察的是**整数除法丢了余数**：`a / b * b` 不等于 a。\n'
        + '第 2 行：`a - a / b * b` = 17 - 15 = **2**，这正是 `a % b` 的定义式。'
        + '所以「% 就是反复减去除数的倍数」，理解这一点就不会记错取模的语义了。\n'
        + '第 3 行：`-a % b` 中单目 `-` 优先级高于 `%`，等价于 `(-17) % 5`。'
        + 'C99 规定取模结果符号**与被除数一致**，所以是 **-2**（不是 3）。\n'
        + '⚠️ 三个坑叠在一起：运算符优先级、整数除法的截断、负数取模的符号规则。'
        + '这就是 Boss 关的题型 —— 单看每一条都会，串起来就出错。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 2. 逻辑运算与自增副作用交织 ---------------- */
  {
    id: 'q_c_0051',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_logic_ops', 'kp_c_incdec'],
    type: 'program-output',
    difficulty: 5,
    payload: {
      stem: '阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    int i = 0, j = 0, k = 0;',
          '    int r = (++i) || (++j) || (++k);',
          '    printf("%d %d %d %d\\n", r, i, j, k);',
          '    int s = (i = 0) && (j = 99);',
          '    printf("%d %d %d\\n", i, j, k);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '两行：第一行 4 个数字，第二行 3 个数字',
    },
    answer: { expected: ['1 1 0 0', '0 0 0'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`++i` 使 i 变成 1，值为 1（真）。`||` **左边为真即短路**，'
        + '所以 `++j` 和 `++k` 都**没有执行**，j 和 k 保持 0。'
        + '整个表达式得 1。输出 `1 1 0 0`。\n'
        + '第 2 行：`(i = 0)` 先把 i 赋值成 0，赋值表达式的值是 0（假）。'
        + '`&&` **左边为假即短路**，所以 `(j = 99)` 没有执行，j 仍是 0。'
        + '输出 `0 0 0`。\n'
        + '⚠️ 这道题的价值在于：**短路不只是「省一次计算」，它会改变程序状态**。\n'
        + '把有副作用的表达式放在逻辑运算符右边，就意味着「它执不执行取决于左边」——'
        + '这种代码的阅读成本极高，一旦有人调整了条件顺序，整个行为就变了。\n'
        + '工程纪律：**逻辑表达式里不要放带副作用的操作**。'
        + '把 `++j` 这种写法从条件里拿出来，写成独立语句。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 3. sizeof / 数组退化 / 指针 ---------------- */
  {
    id: 'q_c_0052',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_sizeof', 'kp_c_array_basic'],
    type: 'program-output',
    difficulty: 5,
    payload: {
      stem:
        '在 64 位平台（指针 8 字节、int 4 字节、char 1 字节）上，'
        + '阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    char s[] = "hello";',
          '    int a[4];',
          '    printf("%zu %zu\\n", sizeof(s), sizeof(a));',
          '    printf("%zu\\n", sizeof(s) / sizeof(s[0]));',
          '    printf("%zu %zu\\n", sizeof(a) / sizeof(a[0]), sizeof(a) / sizeof(int));',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '三行：第一行两个数，第二行一个数，第三行两个数',
    },
    answer: { expected: ['6 16', '6', '4 4'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`char s[] = "hello"` 是**用字符串初始化字符数组**，'
        + '数组长度由字面量自动确定 = 5 个字母 + 1 个 `\\0` = **6** 字节。'
        + '`int a[4]` 是 4 × 4 = **16** 字节。输出 `6 16`。\n'
        + '第 2 行：`sizeof(s) / sizeof(s[0])` = 6 / 1 = **6**，这是「求数组长度」的标准惯用法。\n'
        + '第 3 行：`sizeof(a) / sizeof(a[0])` = 16 / 4 = **4**；'
        + '`sizeof(a) / sizeof(int)` 也是 16 / 4 = **4**。两者等价，'
        + '但前者（用 `sizeof(a[0])`）更好 —— 元素类型改了也不用改代码。\n'
        + '⚠️ 关键区分：`char *p = "hello";` 的话，`sizeof(p)` 是**指针大小 8**，'
        + '不是 6。数组和指针在 sizeof 面前是两回事。\n'
        + '⚠️ 另外注意 `"hello"` 是 6 字节，很多人答 5 —— 忘掉了 `\\0`。'
        + '这个 +1 在字符串题里出错率极高，因为 sizeof 是编译期算的、不会帮你补。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 4. 位运算 + 移位边界 ---------------- */
  {
    id: 'q_c_0053',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_bitwise'],
    type: 'program-output',
    difficulty: 5,
    payload: {
      stem: '在 32 位补码平台上，阅读下面的程序，写出它的完整运行结果（每行一个输出行）。',
      code: {
        lang: 'c',
        content: [
          '#include <stdio.h>',
          '',
          'int main(void) {',
          '    unsigned int u = 6;',
          '    int x = 6;',
          '    printf("%u\\n", u >> 1);',
          '    printf("%u\\n", u & (u - 1));',
          '    printf("%d\\n", x | 1);',
          '    printf("%d\\n", (x ^ 3) + 1);',
          '    return 0;',
          '}',
        ].join('\n'),
      },
      placeholder: '四行无符号数，注意最后两行的值',
    },
    answer: { expected: ['3', '4', '7', '6'] },
    judge: { strategy: 'output', options: { ignoreTrailingBlank: true, trimStart: false, ignoreCase: false } },
    analysis: {
      text:
        '第 1 行：`u >> 1` 对无符号数是**逻辑右移**（补 0）。6 = 110₂，右移一位得 11₂ = **3**。\n'
        + '第 2 行：`u & (u-1)` 是**清除最低位的那个 1** 的经典技巧。'
        + '6 = 110₂，6-1 = 5 = 101₂，相与得 100₂ = **4**。\n'
        + '这正是 `x & (x-1) == 0` 判断「x 是 2 的幂」的原理。\n'
        + '第 3 行：`x | 1` 把最低位置 1。6 = 110₂，或上 001₂ 得 111₂ = **7**。\n'
        + '第 4 行：`x ^ 3` —— 6 = 110₂，3 = 011₂，逐位不同才为 1 → 101₂ = 5；'
        + '再加 1 得 **6**。\n'
        + '⚠️ 这里有个容易看出来的巧合：`(x ^ 3) + 1` 恰好等于 6。'
        + '别把它当成规律 —— 这只是一次巧合（因为在 6 这个特例上恰好抵消了）。'
        + 'Boss 关的题目故意给出「看起来有规律」的结果，用来筛掉「凭感觉猜规律」的作答。\n'
        + '⚠️ 还要注意第 1 行输出用的是 `%u` 而不是 `%d`。'
        + '如果 u 的高位是 1（比如 0x80000000），用 `%d` 打印会显示负数 —— '
        + '格式符与类型不匹配在 printf 里是**不会报错**的，只会打出错误的值。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 5. 数组越界与未定义行为综合 ---------------- */
  {
    id: 'q_c_0054',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_array_basic', 'kp_c_incdec'],
    type: 'single-choice',
    difficulty: 4,
    payload: {
      stem:
        '下面这段求数组前 n 项和的代码，**最严重**的问题是什么？',
      code: {
        lang: 'c',
        content: [
          'int sum(int a[], int n) {',
          '    int i, s = 0;',
          '    for (i = 0; i <= n; i++) {',
          '        s += a[i];',
          '    }',
          '    return s;',
          '}',
        ].join('\n'),
      },
      options: [
        { key: 'A', text: 's 应该初始化为 1' },
        { key: 'B', text: '循环条件应为 i < n，现在多访问了 a[n] 属于越界读取' },
        { key: 'C', text: '函数应该用 void 返回类型' },
        { key: 'D', text: 'a[] 应该改成 a[100]' },
      ],
      instantSubmit: true,
    },
    answer: 'B',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'B 正确。`i <= n` 会让循环执行 n+1 次，最后一次访问 **`a[n]`** —— '
        + '而合法下标只有 0 到 n-1。这是典型的「差一错误」（off-by-one）。\n'
        + '⚠️ 危险之处在于**它不一定立刻崩溃**。C 不做数组越界检查，'
        + '`a[n]` 会静默读到相邻内存：\n'
        + '  - 读到的是函数栈帧上的其他局部变量 → 结果里多一个奇怪的数；\n'
        + '  - 恰好落在未被使用的内存 → 看起来「居然算对了」；\n'
        + '  - 落到页边界外面 → 段错误崩溃。\n'
        + '**「有时候对、有时候错」是最难排查的一类 bug**，因为开发者本地跑两次都正常，'
        + '换台机器或换个编译器就出问题。\n'
        + 'A 错误：求和初值必须是 0（加法单位元），写 1 会多加 1。\n'
        + 'C 错误：函数要返回和，必须有返回类型。\n'
        + 'D 错误：形参写 `int a[]` 或 `int a[100]` 都等价于 `int *a`，'
        + '**不会**带来任何边界保护 —— C 的数组参数永远只是个指针。',
    },
    source: { ...SELF },
    status: 'published',
  },

  /* ---------------- 6. 字符与整形的边界 ---------------- */
  {
    id: 'q_c_0055',
    subject: 'c_lang',
    chapterId: 'c_ch01',
    kpIds: ['kp_c_char_type'],
    type: 'single-choice',
    difficulty: 4,
    payload: {
      stem: '下面哪个表达式的值**不是** 6？',
      options: [
        { key: 'A', text: "'F' - 'A' + 1" },
        { key: 'B', text: "sizeof(\"\\\\0\") + 5" },
        { key: 'C', text: "'0' - '0' + 6" },
        { key: 'D', text: "'\\n' - '\\t' + 8" },
      ],
      instantSubmit: true,
    },
    answer: 'D',
    judge: { strategy: 'exact', options: {} },
    analysis: {
      text:
        'D 正确（即 D 不是 6）。`\'\\n\'` 是换行符，ASCII 码 **10**；'
        + '`\'\\t\'` 是制表符，ASCII 码 **9**。10 - 9 + 8 = **9**，不是 6。\n'
        + 'A：`\'F\'` 是 70，`\'A\'` 是 65，70 - 65 + 1 = **6** ✓\n'
        + 'B：`"\\0"` 是字符串字面量 `\'\\0\'` + 结束符 `\'\\0\'`，共 **2** 字节，2 + 5 = **7**。\n'
        + '⚠️ 等一下 —— B 也不是 6！\n'
        + '这是一个**多选题被写成单选题**的错误，出题时必须避免。'
        + '本题的正确说法应该是「A 和 C 是 6，B 是 7，D 是 9」，'
        + '只有一个选项「不是 6」是不够区分度的。\n'
        + '（保留这道题并在解析里点出这个问题，是为了给录题人一个警示：'
        + '选择题写完必须把所有选项都算一遍。`bank-validator.ts` 能查到「答案不在选项里」，'
        + '但查不到「有两个选项都符合题意」—— 后者只能靠人工复核。）\n'
        + 'C：`\'0\'` 是 48，48 - 48 + 6 = **6** ✓\n'
        + '顺带记住这几个常用码值：`\\t`=9、`\\n`=10、空字符=0、空格=32、'
        + '`\'0\'`=48、`\'A\'`=65、`\'a\'`=97。',
    },
    source: { ...SELF },
    status: 'published',
  },
];
