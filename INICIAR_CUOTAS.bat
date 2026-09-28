@echo off
title RECOLECTOR DE CUOTAS MULTI-ROL CON IA - SANTA CRUZ
cd /d "%~dp0"
echo ========================================================
echo   RECOLECTOR DE CUOTAS CON IA (MULTI-ROL Y MULTI-CURSO)
echo ========================================================
echo.
echo   Login (Acceso a Roles):     http://localhost:4000/login.html
echo   Panel Super Admin (Daniel): http://localhost:4000/admin-maestro.html
echo   Panel Directivo (Carmen):   http://localhost:4000/directivo.html
echo   Portal de Padres (Publico): http://localhost:4000/
echo   Chat WhatsApp IA:           http://localhost:4000/simulador_ia.html
echo.
echo   (No cierres esta ventana mientras uses el sistema)
echo ========================================================
node server.js
pause
