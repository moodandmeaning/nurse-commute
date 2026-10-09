@echo off
rem Double-click to start the app. Closing this window stops it.
cd /d "%~dp0"
title Nurse Commute - close this window to stop the app
start "" http://127.0.0.1:5000
".venv\Scripts\python.exe" app.py
pause
