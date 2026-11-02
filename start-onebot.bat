@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0napcat\NapCat.52230.Shell"

if not exist "NapCatWinBootMain.exe" (
  echo 未找到 NapCat，请先完成 napcat 目录中的安装。
  pause
  exit /b 1
)

call napcat.bat
endlocal
