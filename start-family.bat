@echo off
REM ============================================================================
REM  Family Groceries - local run (API + PWA on one origin).
REM  Keep this window open. For phone access use MOBILE-LINK.cmd instead.
REM ============================================================================
cd /d %~dp0server
start "Family App :8787" node src/index.js
timeout /t 2 >nul
start "" http://localhost:8787
echo.
echo App:        http://localhost:8787
echo API health: http://localhost:8787/api/health
echo Phone:      run MOBILE-LINK.cmd from the project folder
echo.
pause
