/**
 * 判题沙箱 · 真机执行器（调用 docker CLI）
 *
 * 只用 `docker run` 与 `docker inspect` 两个子命令，不引第三方 SDK：
 *   - 参数数组直传，绝不拼 shell 字符串（防注入）
 *   - 墙钟超时由 Node 侧计时器负责 kill，因为容器自身不会因为 wall clock 退出
 *   - 峰值内存靠 docker inspect 事后取，不靠猜
 *
 * 只在服务端运行，不参与小程序打包。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SandboxPlan } from './policy';
import { containerNameOf, type ExecResult, type Executor } from './runner';

export interface DockerExecutorOptions {
  dockerBin?: string;
  /** 提交级别的工作根目录，每次提交在其下开一个独立子目录 */
  workspaceRoot: string;
}

export class DockerExecutor implements Executor {
  private dockerBin: string;
  private workspaceRoot: string;

  constructor(opts: DockerExecutorOptions) {
    this.dockerBin = opts.dockerBin || 'docker';
    this.workspaceRoot = opts.workspaceRoot;
  }

  /** 为一次提交开独立临时目录（独立 UID + 独立目录 + 容器销毁即清） */
  prepareWorkspace(submissionId: string): string {
    const safe = sanitizeSegment(submissionId);
    const dir = path.join(this.workspaceRoot, safe);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    return dir;
  }

  writeSource(dir: string, fileName: string, code: string): string {
    const p = path.join(dir, fileName);
    writeFileSync(p, code, { encoding: 'utf8', mode: 0o644 });
    return p;
  }

  cleanupWorkspace(dir: string): void {
    // 只删自己 workspaceRoot 之下的目录，避免误删
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(this.workspaceRoot))) return;
    try {
      rmSync(resolved, { recursive: true, force: true });
    } catch (e) {
      console.error('[judge] 清理临时目录失败', resolved, e);
    }
  }

  async exec(plan: SandboxPlan, timeoutMs: number): Promise<ExecResult> {
    const started = Date.now();
    const name = containerNameOf(plan);
    // 容器名必须来自计划本身。取不到说明计划被外部改过，宁可早失败也别
    // 让 docker 去跑一个没有名字的一次性容器（那会让 kill/清理都失去抓手）
    if (!name) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        wallMs: 0,
        peakMemoryKB: 0,
        wallTimeout: false,
        execError: '容器计划缺少 --name，拒绝执行',
      };
    }

    return new Promise<ExecResult>(function (resolve) {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let wallTimeout = false;

      // stdin 必须显式打开：docker run 带了 -i，容器内进程会去读 stdin。
      // 不写数据就 close，会让 scanf/input() 立刻拿到 EOF —— 程序可能因此
      // 读到空值而输出错误答案（而不是报错），是最难查的一类误判。
      const child = spawn('docker', ['run', ...plan.args], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // 喂测试点输入，然后**立刻关掉** stdin：
      // 不关的话，那些「循环读到 EOF 才结束」的程序会一直等下去 → 超时 → 误判 TLE。
      if (child.stdin) {
        if (plan.stdin) child.stdin.write(plan.stdin, 'utf8');
        child.stdin.end();
      }

      // 墙钟超时：先 SIGTERM 容器，再兜底 SIGKILL
      const timer = setTimeout(function () {
        wallTimeout = true;
        killContainer();
        if (!settled) {
          try {
            child.kill('SIGKILL');
          } catch (e) {
            // 忽略
          }
        }
      }, timeoutMs);

      child.stdout.on('data', function (chunk: Buffer) {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', function (chunk: Buffer) {
        stderr += chunk.toString('utf8');
      });

      child.on('error', function (err: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: null,
          signal: null,
          stdout: stdout,
          stderr: stderr,
          wallMs: Date.now() - started,
          peakMemoryKB: 0,
          wallTimeout: false,
          execError: err.message,
        });
      });

      child.on('close', function (code: number | null, signal: string | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code,
          signal: signal,
          stdout: stdout,
          stderr: stderr,
          wallMs: Date.now() - started,
          peakMemoryKB: 0, // 由调用方按需 inspect，避免每次多一次进程调用
          wallTimeout: wallTimeout,
        });
      });

      function killContainer() {
        try {
          const killer = spawn('docker', ['kill', name], { windowsHide: true });
          killer.on('error', function () {
            // 容器可能已自行退出
          });
        } catch (e) {
          // 忽略
        }
      }
    });
  }
}

/** 只保留安全字符，避免提交 ID 里的路径穿越 */
function sanitizeSegment(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'submission';
}
