@echo off
start "" npm run web
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
