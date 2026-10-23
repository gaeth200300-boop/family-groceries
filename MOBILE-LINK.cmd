@echo off
REM ============================================================================
REM  Family Groceries - phone link (HTTPS via Cloudflare Quick Tunnel)
REM      MOBILE-LINK.cmd            reuse a running tunnel or create one
REM      MOBILE-LINK.cmd -Restart   force a brand-new URL
REM  The PowerShell script starts the server too if it is not running.
REM ============================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mobile-link.ps1" %*
echo.
pause
