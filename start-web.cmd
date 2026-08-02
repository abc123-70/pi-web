@echo off
cd /d %~dp0
rem 如果服务已在运行，就不再重复启动，直接开浏览器
netstat -ano | findstr ":8765" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  start "pi-web" /min cmd /k "node server.mjs"
  timeout /t 3 /nobreak >nul
)
start "" http://127.0.0.1:8765
