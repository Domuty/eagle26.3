@echo off
rem Starts the Donuts (School) survival server + the Eaglercraft bridge.
cd /d "%~dp0"
if not exist minecraft\server.jar (
  echo Missing minecraft\server.jar - download the Minecraft 26.3 server jar and put it there.
  pause
  exit /b 1
)
if not exist node_modules call npm install --omit=dev
start "Donuts bridge" node bridge.js
cd minecraft
java -Xms1G -Xmx2G -jar server.jar nogui
pause
