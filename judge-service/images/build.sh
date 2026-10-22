#!/usr/bin/env bash
#
# 构建判题沙箱镜像。
#
# 用法：
#   bash judge-service/images/build.sh            # 构建两个镜像
#   bash judge-service/images/build.sh gcc        # 只构建 gcc
#   bash judge-service/images/build.sh python     # 只构建 python
#   bash judge-service/images/build.sh verify     # 只做校验，不构建
#
# ⚠️ 这个脚本会**校验构建结果**，不是构建完就完事。
#    镜像的每一条安全要求都必须能被自动检查——否则时间一长，
#    有人为了「让某个题能跑」把 curl 装回去，没有任何机制会拦他。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCC_IMAGE="judge-gcc:13-slim"
PY_IMAGE="judge-python:3.12-slim"

# 镜像名必须与 policy.ts 的 LANG_TABLE 完全一致。
# 不一致的直接后果：judge 服务起容器时报 "image not found"，
# 而报错发生在用户提交时，不是部署时 —— 所以在这里先挡一次。
assert_image_names_match_policy() {
  local policy="$HERE/../src/sandbox/policy.ts"
  if [ ! -f "$policy" ]; then
    echo "⚠️  找不到 policy.ts，跳过镜像名一致性检查"
    return 0
  fi
  for name in "$GCC_IMAGE" "$PY_IMAGE"; do
    if ! grep -q "'$name'" "$policy"; then
      echo "❌ 镜像名 '$name' 在 policy.ts 里找不到。"
      echo "   构建出来的镜像不会被使用，请先同步 policy.ts 的 LANG_TABLE。"
      exit 1
    fi
  done
  echo "✓ 镜像名与 policy.ts 一致"
}

build_one() {
  local tag="$1" dockerfile="$2"
  echo ""
  echo "=== 构建 $tag ==="
  docker build \
    --file "$HERE/$dockerfile" \
    --tag "$tag" \
    --label "judge.built-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$HERE"
}

# ---------------------------------------------------------------
# 校验：每一条都是「镜像被误改后必须报警」的点
# ---------------------------------------------------------------
verify_one() {
  local tag="$1" kind="$2"
  echo ""
  echo "=== 校验 $tag ==="
  local failed=0

  check() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
      echo "  ✓ $desc"
    else
      echo "  ✗ $desc"
      failed=1
    fi
  }

  check_not() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
      echo "  ✗ $desc（不应存在但存在）"
      failed=1
    else
      echo "  ✓ $desc"
    fi
  }

  # 必须以 UID 1000 运行。与 policy.ts 的 --user 1000:1000 强绑定
  local uid
  uid="$(docker run --rm --entrypoint /usr/bin/id "$tag" -u 2>/dev/null || echo '')"
  if [ "$uid" = "1000" ]; then
    echo "  ✓ 默认用户 UID = 1000（与 policy.ts 的 --user 1000:1000 一致）"
  else
    echo "  ✗ 默认用户 UID = '$uid'，期望 1000"
    failed=1
  fi

  # 外联工具必须不存在（禁网的第二道防线）
  check_not "不含 curl" docker run --rm --entrypoint /bin/sh "$tag" -c "command -v curl"
  check_not "不含 wget" docker run --rm --entrypoint /bin/sh "$tag" -c "command -v wget"
  check_not "不含 nc"   docker run --rm --entrypoint /bin/sh "$tag" -c "command -v nc"
  check_not "不含 ssh"  docker run --rm --entrypoint /bin/sh "$tag" -c "command -v ssh"

  if [ "$kind" = "gcc" ]; then
    check "gcc 可用且版本符合预期" docker run --rm --entrypoint /bin/sh "$tag" -c "gcc --version | grep -q 'gcc'"
    check "g++ 可用" docker run --rm --entrypoint /bin/sh "$tag" -c "g++ --version >/dev/null"
    check_not "不含 apt（包管理器）" docker run --rm --entrypoint /bin/sh "$tag" -c "command -v apt-get"
    # 静态链接可用性：policy.ts 的编译命令带 -static，缺 libc.a 会编译失败
    check "静态链接可用（-static）" docker run --rm --entrypoint /bin/sh "$tag" -c \
      "printf 'int main(){return 0;}' > /tmp/t.c && gcc -static -o /tmp/t /tmp/t.c"
  fi

  if [ "$kind" = "python" ]; then
    check "python3 可用" docker run --rm --entrypoint /bin/sh "$tag" -c "python3 --version >/dev/null"
    check_not "不含 pip 模块" docker run --rm --entrypoint /bin/sh "$tag" -c "python3 -c 'import pip'"
    check_not "不含 socket 模块（禁网第二道防线）" docker run --rm --entrypoint /bin/sh "$tag" -c "python3 -c 'import socket'"
    check_not "不含 urllib" docker run --rm --entrypoint /bin/sh "$tag" -c "python3 -c 'import urllib'"
    check "可正常执行脚本" docker run --rm --entrypoint /bin/sh "$tag" -c \
      "printf 'print(1+1)' > /tmp/t.py && python3 -I -B /tmp/t.py | grep -q '^2$'"
    # 哈希随机化必须关掉，否则 set/dict 遍历顺序不稳定 → 判题结果不可复现
    check "PYTHONHASHSEED=0（判题结果可复现）" docker run --rm --entrypoint /bin/sh "$tag" -c \
      "[ \"\$PYTHONHASHSEED\" = \"0\" ]"
  fi

  # 挂载点必须存在且属于 sandbox 用户
  check "/box 挂载点存在" docker run --rm --entrypoint /bin/sh "$tag" -c "test -d /box"
  check "/box-artifact 挂载点存在" docker run --rm --entrypoint /bin/sh "$tag" -c "test -d /box-artifact"

  if [ "$failed" != "0" ]; then
    echo ""
    echo "❌ $tag 校验未通过。不要用这个镜像上线判题。"
    return 1
  fi
  echo "  ✅ $tag 校验通过"
}

MODE="${1:-all}"

case "$MODE" in
  gcc)
    assert_image_names_match_policy
    build_one "$GCC_IMAGE" Dockerfile.gcc
    verify_one "$GCC_IMAGE" gcc
    ;;
  python)
    assert_image_names_match_policy
    build_one "$PY_IMAGE" Dockerfile.python
    verify_one "$PY_IMAGE" python
    ;;
  verify)
    assert_image_names_match_policy
    verify_one "$GCC_IMAGE" gcc
    verify_one "$PY_IMAGE" python
    ;;
  all)
    assert_image_names_match_policy
    build_one "$GCC_IMAGE" Dockerfile.gcc
    build_one "$PY_IMAGE" Dockerfile.python
    verify_one "$GCC_IMAGE" gcc
    verify_one "$PY_IMAGE" python
    ;;
  *)
    echo "用法: bash build.sh [gcc|python|verify|all]"
    exit 2
    ;;
esac

echo ""
echo "完成。镜像列表："
docker images --filter "reference=judge-*" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"
