@echo off
chcp 65001 >nul
title 게임 계정샵 서버
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [오류] Node.js 를 찾을 수 없습니다.
  echo https://nodejs.org 에서 LTS 버전^(22.5 이상^)을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo Node.js %NODEVER% 로 서버를 시작합니다...
echo.

node server.js

echo.
echo 서버가 종료되었습니다. 오류 메시지가 있다면 위 내용을 확인해 주세요.
pause
