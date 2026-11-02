@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 npm。请重新安装包含 npm 的 Node.js。
  pause
  exit /b 1
)

if not exist "node_modules\ws\package.json" (
  echo 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 (
  echo 程序已退出，请查看上方提示。
  pause
)

endlocal
