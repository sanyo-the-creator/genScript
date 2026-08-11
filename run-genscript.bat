@echo off
title genScript
cd /d "%~dp0"
echo Starting genScript on http://localhost:3000 ...
start "" http://localhost:3000
node server.js
echo.
echo genScript stopped. Press any key to close.
pause >nul
