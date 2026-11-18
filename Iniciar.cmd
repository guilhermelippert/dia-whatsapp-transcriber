@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 22 ou superior e abra novamente.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\setup.mjs" --start
if errorlevel 1 (
  pause
  exit /b 1
)
