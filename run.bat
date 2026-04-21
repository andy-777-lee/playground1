@echo off
REM OpenSSL SECLEVEL 을 낮춘 상태로 서버 실행 (data.ex.co.kr 의 약한 CA 대응)
set NODE_OPTIONS=--openssl-config=%~dp0openssl-legacy.cnf
node "%~dp0server.js"
