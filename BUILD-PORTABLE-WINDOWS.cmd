@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title VideoFactory Desktop Portable Build
set "LOG_FILE=%~dp0VideoFactory-Last-Build.log"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\build-portable.ps1" -LogPath "%LOG_FILE%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  if exist "%LOG_FILE%" type "%LOG_FILE%"
  echo.
  pause
)
exit /b %EXIT_CODE%
