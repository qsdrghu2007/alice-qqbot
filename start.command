#!/bin/sh
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22 或更高版本。"
  read -r _
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm。请重新安装包含 npm 的 Node.js。"
  read -r _
  exit 1
fi

if [ ! -f node_modules/ws/package.json ]; then
  echo "首次运行，正在安装依赖..."
  npm install || {
    echo "依赖安装失败，请检查网络后重试。"
    read -r _
    exit 1
  }
fi

npm start
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "程序已退出，状态码：$STATUS"
  read -r _
fi
exit "$STATUS"
