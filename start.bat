@echo off
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
python start.py %*
if errorlevel 1 pause
