#!/usr/bin/env bash
# Starts the Donuts (School) survival server + the Eaglercraft bridge.
# Needs: Java 21+, Node.js 18+, and minecraft/server.jar (Minecraft 26.3 server jar).
set -e
cd "$(dirname "$0")"
if [ ! -f minecraft/server.jar ]; then
  echo "Missing minecraft/server.jar - download the Minecraft 26.3 server jar"
  echo "(https://www.minecraft.net/en-us/download/server or a Paper 26.3 build) and put it there."
  exit 1
fi
[ -d node_modules ] || npm install --omit=dev
node bridge.js &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT
cd minecraft
java -Xms1G -Xmx${MC_RAM:-2G} -jar server.jar nogui
