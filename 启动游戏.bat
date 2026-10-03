@echo off
chcp 65001 >nul
title 云端客机 - 飞行挑战

echo.
echo   ============================================
echo      云端客机 · 飞行挑战   正在启动...
echo   ============================================
echo.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 没有找到 Node.js
    echo.
    echo   请先安装 Node.js (推荐 18 或更高版本):
    echo     https://nodejs.org/
    echo.
    pause
    exit /b 1
)

start "" cmd /c "node tools\serve.mjs 8123"
echo   服务器已启动，正在打开浏览器...
echo   (关闭本窗口或按 Ctrl+C 可停止服务器)
echo.

timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8123/

echo   如果浏览器没有自动打开，请手动访问:
echo     http://127.0.0.1:8123/
echo.
echo   提示: 必须通过这个地址访问，不能直接双击 index.html
echo.
pause
