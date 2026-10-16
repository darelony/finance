@echo off
rem Isto kao pokreni.vbs, ali sa vidljivom konzolom - za proveru gresaka.
cd /d "%~dp0"
node server.js --open
pause
