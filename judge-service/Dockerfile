# 判题服务镜像
#
# ⚠️ 这是**控制面**镜像（接收提交、编排容器、返回结果）。
#    它不自己跑用户代码——用户代码由它 spawn 出的一次性容器执行。
#
# 因此本镜像必须挂载 docker socket（或用 dind），且必须在
# judge-service/docker-compose.yml 里做网络与能力层面的限制。
# 详见 README.md 的「部署拓扑」一节。

# Ubuntu 而非 alpine：需要 glibc 与完整 gcc 工具链来跑判题容器调度
#
# Node 版本必须 >= 22：`src/server.js` 是薄垫片，真正实现在 `server.ts`，
# 靠 Node 内置的 TypeScript 类型剥离直接执行（无需构建步骤）。
# Node 20 不支持类型剥离，用 20 会表现为「入口一跑就 SyntaxError」。
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="xx-chuangguan judge-service"
LABEL org.opencontainers.image.description="判题服务控制面：编排一次性沙箱容器执行用户代码"

# 只装必需包。client 用于调用 Docker API（比挂 socket 更可控，也便于后续换远端节点）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       tini \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户，UID 固定 1000（与沙箱容器内 UID 一致，便于临时目录权限配合）
RUN groupadd -g 1000 judge \
    && useradd -u 1000 -g judge -m -s /usr/sbin/nologin judge

WORKDIR /app

# 先拷依赖描述，利用构建缓存
COPY package.json ./
# 注意：本项目零运行时依赖，所以这里没有 npm install。
# 若后续引入依赖（如 redis client），在此处补 `RUN npm ci --omit=dev`
# 且必须先提交 package-lock.json。

COPY src ./src

# ---------------------------------------------------------------
# seccomp profile
#
# ⚠️ 必须放在 /etc/judge/ 下，且**与判断逻辑里的默认值一致**。
#
# 历史坑（务必不要回退）：
#   早期版本把 profile 放在 /etc/seccomp-judge.json，而 policy.ts 里写的是
#   /etc/judge/seccomp-judge.json —— 路径不一致。更糟的是 Dockerfile 里用了
#       RUN chmod 0444 /etc/seccomp-judge.json 2>/dev/null || true
#   `|| true` 把「文件不存在」这个错误静默吞掉了，于是构建成功、
#   运行时才因为 seccomp profile 找不到而失败（docker 的报错也不指向根因）。
#   现在：显式 COPY 到正确路径，并让 sh 在文件缺失时**构建失败**。
# ---------------------------------------------------------------
COPY etc/seccomp-judge.json /etc/judge/seccomp-judge.json

# 只读化：docker 只需要读它。不要 chmod 掉写位之前先确认文件确实存在
# （前面的 COPY 已保证；这里不加 || true，让它出错就出错）
RUN chmod 0444 /etc/judge/seccomp-judge.json \
    && test -s /etc/judge/seccomp-judge.json

# 判题工作区。必须交给 judge 用户可写，因为编译容器要以 UID 1000 读写它
RUN mkdir -p /var/lib/judge/workspace \
    && chown -R judge:judge /var/lib/judge /app

ENV NODE_ENV=production
ENV JUDGE_WORKSPACE_ROOT=/var/lib/judge/workspace
ENV JUDGE_SECCOMP_PROFILE=/etc/judge/seccomp-judge.json
ENV JUDGE_PORT=8600

USER 1000:1000

EXPOSE 8600

# tini 做 PID 1：正确回收被 docker kill 掉的一次性容器的僵尸进程
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]

# 健康检查：判题服务卡住时编排层要能发现
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.JUDGE_PORT+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
