@echo off
rem Image Studio: uruchamia backend i otwiera okno aplikacji (bez konsoli). Zamkniecie okna zatrzymuje backend i zwalnia model.
rem Interpreter Pythona z PyTorchem: zmienna IMAGE_STUDIO_PYTHON albo data\launcher.json {"python": "..."}.
rem Wersja z konsola (diagnostyka): set IMAGE_STUDIO_CONSOLE=1
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
if not exist "%ROOT%frontend\dist\index.html" (echo Brak frontend\dist - uruchom: cd frontend ^&^& npm install ^&^& npm run build & pause & exit /b 1)
if "%IMAGE_STUDIO_CONSOLE%"=="1" (python launcher.pyw) else (start "" pythonw launcher.pyw)
