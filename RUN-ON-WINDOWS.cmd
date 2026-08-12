@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title VideoFactory Desktop Launcher

set "LOG_FILE=%~dp0VideoFactory-Last-Startup.log"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\setup-and-run.ps1" -LogPath "%LOG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo ================================================================
  echo VideoFactory did not start. This window will remain open so the
  echo error can be reviewed.
  echo.
  echo Startup log:
  echo %LOG_FILE%
  echo ================================================================
  echo.
  if exist "%LOG_FILE%" type "%LOG_FILE%"
) else (
  echo VideoFactory exited normally.
  echo Startup log: %LOG_FILE%
)

echo.
pause
exit /b %EXIT_CODE%
