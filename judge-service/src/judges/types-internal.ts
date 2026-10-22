/**
 * 判题服务内部契约（仅服务端可见，不参与小程序打包）
 *
 * 这层存在的意义：把「沙箱执行」「题库」「缓存」「工作区」都做成接口，
 * 于是主流程（judges/index.ts）可以在不装 docker、不连数据库的情况下被完整测试。
 * 生产实现在 adapters.ts 里。
 */

import type { JudgeResponse } from '../contract';
import type { JudgePlan } from '../questions/testcases';

/** 判题计划来源（生产：题库集合；开发：内置样例） */
export interface PlanProvider {
  getPlan(questionId: string, language: string): Promise<JudgePlan | undefined>;
}

/** 幂等结果缓存（生产：Redis；开发：内存） */
export interface ResultCache {
  get(submissionId: string): Promise<JudgeResponse | undefined>;
  set(submissionId: string, res: JudgeResponse): Promise<void>;
}

export interface WorkspacePort {
  /** 为一次提交建独立临时目录，返回宿主绝对路径 */
  prepare(submissionId: string): Promise<string>;
  /**
   * 建一个目录（递归、幂等）。
   *
   * 为什么需要它：运行阶段的编译产物要放在 workDir 的**同级** `.artifacts` 目录，
   * 那个目录不在 prepare() 的职责范围内（它只建提交工作区）。
   * 由编排层显式创建，而不是让 collectArtifact 隐式建 ——
   * 隐式建目录会让「产物目录在哪」这件事散落到多处。
   */
  mkdirp(dir: string): Promise<void>;
  writeSource(dir: string, fileName: string, code: string): Promise<void>;
  /**
   * 编译产物从编译容器落到宿主，供运行容器只读挂载。
   *
   * `containerName` 必须由调用方传入（= 编译容器的名字）。
   * 为什么不在这里自己记：工作区实现「怎么存文件」和编排层「跑了哪个容器」
   * 是两件事。让工作区去猜容器名，会让它必须和 runner 的命名规则耦合；
   * 而命名规则一旦调整（比如加环境前缀），漏改一处就会在运行时才炸。
   * 显式传参把这个耦合摆到类型上，编译期就拦住了。
   */
  collectArtifact(dir: string, artifactName: string, containerName: string): Promise<void>;
  cleanup(dir: string): Promise<void>;
}

export interface FileNamePort {
  fileNameFor(language: string): string;
  artifactNameFor(language: string): string;
  /** 运行阶段容器内要执行的命令（服务端生成，绝不含用户输入） */
  runArgvFor(language: string): string[];
}

/**
 * 限流预热钩子。
 *
 * 起因：RateCounter 接口是同步的（业务层不该知道存储是不是异步的），
 * 但 Redis 计数只能异步拿。这个接口给存储实现一个机会，
 * 在进入判题流程之前先把权威读数拉回本地，于是同步的 get()/ttl()
 * 也能给出多实例下正确的判定。
 *
 * ⚠️ 语义上它是**可选的结构性扩展**，不是 RateCounter 的替代品。
 *    类型声明放在 sandbox/ratelimit.ts（限流语义的一部分），
 *    这里只放一个结构化判定，避免为了一个类型把 adapters 拽进 redis 依赖。
 */
export interface Prefetchable {
  prefetch(userId: string, now: number): Promise<void>;
}

export function canPrefetch(c: object): c is Prefetchable {
  return typeof (c as Prefetchable).prefetch === 'function';
}
