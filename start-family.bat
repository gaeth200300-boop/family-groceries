@echo off
REM Family Groceries - local run (API + App). Keep this window open.
cd /d %~dp0server
start "Family API :8787" node src/index.js
cd /d %~dp0www
start "Family App :8080" python -m http.server 8080
echo.
echo Open the app at: http://localhost:8080
echo API health at:   http://localhost:8787/api/health
echo.
pause
