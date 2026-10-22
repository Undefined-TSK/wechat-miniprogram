/**
 * 判题服务 · 生产适配器
 *
 * 把内部接口落到真实依赖上。刻意保持简单：全是薄壳，没有业务逻辑，
 * 所有判断都在可测试的纯逻辑层（classify / policy / testcases / judges）。
 *
 * 依赖注入点：
 *   - PlanProvider  → 题库（开发用内存，生产接数据库/云开发）
 *   - ResultCache   → Redis（开发用内存）
 *   - WorkspacePort → 本地磁盘（生产接挂载卷）
 *
 * `mkdtemp` 保证每次提交一个全新目录，且目录权限 0700 —— 与容器里的
 * 非 root 用户（UID 1000）配合，做到「用自己的目录，看不到别人的」。
 */

import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { JudgeResponse } from './contract';
import type { JudgePlan } from './questions/testcases';
import { ARTIFACT_HANDOFF, languageSpec } from './sandbox/policy';
import { artifactDirFor } from './sandbox/runner';
import type { FileNamePort, PlanProvider, ResultCache, WorkspacePort } from './judges/types-internal';

/* ------------------------------ 题库 ------------------------------ */

export class MemoryPlanProvider implements PlanProvider {
  private plans = new Map<string, JudgePlan>();

  add(plan: JudgePlan): void {
    this.plans.set(plan.questionId + '::' + plan.language, plan);
  }

  async getPlan(questionId: string, language: string): Promise<JudgePlan | undefined> {
    return this.plans.get(questionId + '::' + language);
  }
}

/* ------------------------------ 结果缓存 ------------------------------ */

export class MemoryResultCache implements ResultCache {
  private map = new Map<string, JudgeResponse>();
  private stats = { hits: 0, misses: 0, writes: 0 };

  async get(submissionId: string): Promise<JudgeResponse | undefined> {
    const hit = this.map.get(submissionId);
    if (hit) {
      this.stats.hits++;
      // 回给调用方时标记为缓存命中，方便前端区分「秒回」是不是真的判过了
      return { ...hit, cacheHit: true };
    }
    this.stats.misses++;
    return undefined;
  }

  async set(submissionId: string, res: JudgeResponse): Promise<void> {
    this.stats.writes++;
    this.map.set(submissionId, { ...res, cacheHit: false });
  }

  /**
   * 统计口径刻意与 RedisResultCache 对齐。
   *
   * 为什么两个实现要有同一个形状：装配层（bootstrap）把 resultCache 挂到
   * bundle 上供运维与自检读取。如果内存实现少一个方法，那么
   * 「没配 Redis 的开发环境」与「配了 Redis 的生产」就是两套可观测性 ——
   * 于是自检里能跑的东西，生产上不一定能跑。接口一致比各自最省事更重要。
   */
  getStats(): { hits: number; misses: number; writes: number; degradedPass: number; errors: number; skipped: number; degraded: boolean } {
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      writes: this.stats.writes,
      // 内存实现没有「降级」概念，恒为 0/false —— 显式写出来，
      // 免得调用方要从「有没有这个字段」去猜后端是什么
      degradedPass: 0,
      errors: 0,
      skipped: 0,
      degraded: false,
    };
  }

  get size(): number {
    return this.map.size;
  }
}

/* ------------------------------ 工作区 ------------------------------ */

export class LocalWorkspace implements WorkspacePort {
  private root: string;
  /** 保留「提交 → 最近一次容器名」的映射，仅用于排障日志 */
  private containerOf = new Map<string, string>();
  /**
   * 是否由本机直接执行（JUDGE_SANDBOX=local）。
   *
   * 这个标记只影响**一件事**：编译产物需不需要从容器里拷出来。
   *   - docker 模式：产物在容器 tmpfs 里，必须 `docker cp` 到宿主
   *   - local  模式：产物由本机编译器**直接写在宿主中转目录**，无需拷贝
   *
   * 为什么用构造期开关而不是「先试 docker cp、失败就跳过」：
   *   后者会把「本机没装 docker」和「产物真的没生成」混成一个错误，
   *   表现为「编译成功但运行阶段找不到产物」——极难定位。
   *   显式开关让两种模式的路径都是**确定**的。
   */
  private localMode: boolean;

  constructor(root: string, opts?: { localMode?: boolean }) {
    this.root = root;
    this.localMode = !!(opts && opts.localMode);
  }

  /** 记录一次容器名，便于出错时打印「是哪个容器」。不影响 collectArtifact 的取值 */
  noteContainer(submissionId: string, containerName: string): void {
    this.containerOf.set(submissionId, containerName);
  }

  lastContainer(submissionId: string): string | undefined {
    return this.containerOf.get(submissionId);
  }

  async prepare(submissionId: string): Promise<string> {
    const safe = String(submissionId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'submission';
    const dir = path.join(this.root, safe + '-' + Date.now().toString(36));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async mkdirp(dir: string): Promise<void> {
    // 只允许在 root 之下建目录 —— 防止路径穿越（虽然调用方传的是服务端算出的路径）
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error('[judge] 拒绝在工作区之外创建目录: ' + dir);
    }
    // 0755 而非 0700：容器内以 UID 1000 运行，需要能读并**执行**产物
    await mkdir(resolved, { recursive: true, mode: 0o755 });
  }

  async writeSource(dir: string, fileName: string, code: string): Promise<void> {
    const target = path.join(dir, fileName);
    await writeFile(target, code, { encoding: 'utf8', mode: 0o644 });
  }

  /**
   * 编译产物从容器拷到宿主。
   *
   * 这是「编译与运行分容器」的代价：多一次 docker cp。
   * 换来的是运行容器里没有编译器——攻击面显著变小。
   *
   * 容器名由调用方传入（见 WorkspacePort 的注释）。
   * 传入空值**必须抛错**而不是静默跳过——否则会退化成
   * 「运行阶段找不到产物」这种极难定位的故障。
   */
  async collectArtifact(dir: string, artifactName: string, containerName: string): Promise<void> {
    if (this.localMode) {
      // 本机执行：编译器已经把产物直接写在 dir 里了（见 local-executor 的
      // redirectArtifactOutput）。所以这里只需要**确认它真的在**。
      //
      // 为什么要确认而不是直接返回：编译成功但产物缺失，是我们最不希望
      // 静默放过的情况——它会在运行阶段变成「找不到文件」，用户看到的是
      // 自己的代码被判错。宁可在这里明确报错。
      const target = path.join(dir, artifactName);
      try {
        await access(target);
      } catch {
        throw new Error('[judge] 本地模式下编译产物未生成: ' + target);
      }
      return;
    }

    if (!containerName) {
      throw new Error('[judge] 未提供编译容器名，无法收集编译产物: ' + dir);
    }
    // 容器名做一次白名单校验：它虽然由服务端生成，但过一道更稳
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerName)) {
      throw new Error('[judge] 非法的容器名: ' + containerName);
    }
    await new Promise<void>(function (resolve, reject) {
      const child = spawn(
        'docker',
        ['cp', containerName + ':' + ARTIFACT_HANDOFF.compileOutputInContainer, path.join(dir, artifactName)],
        { windowsHide: true }
      );
      child.on('error', reject);
      child.on('close', function (code) {
        if (code === 0) resolve();
        else reject(new Error('docker cp 失败，退出码 ' + String(code)));
      });
    });
  }

  /**
   * 清理一次提交的全部痕迹。
   *
   * ⚠️ 必须**同时**删掉同级 `.artifacts` 目录。
   * 产物不在 workDir 里（为了让它可执行，见 policy.ts 的说明），
   * 只删 workDir 会留下一地编译产物 —— 判题服务撑爆磁盘最经典的成因。
   */
  async cleanup(dir: string): Promise<void> {
    const resolved = path.resolve(dir);
    const root = path.resolve(this.root);
    if (!resolved.startsWith(root)) return;
    await rm(resolved, { recursive: true, force: true });
    await rm(artifactDirFor(resolved, ARTIFACT_HANDOFF.hostStagingDirSuffix), {
      recursive: true,
      force: true,
    });
  }
}

/* ------------------------------ 文件名与命令 ------------------------------ */

export const defaultFileNames: FileNamePort = {
  fileNameFor: function (language: string) {
    return languageSpec(language as 'c').fileName;
  },
  artifactNameFor: function () {
    return 'box.out';
  },
  runArgvFor: function (language: string) {
    return languageSpec(language as 'c').run;
  },
};
