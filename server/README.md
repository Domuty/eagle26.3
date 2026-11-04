# Donuts (School) — survival server

A plain survival Minecraft 26.3 server that the Eaglercraft client in `../index.html` can join.

Browsers can't open normal Minecraft (TCP) connections, so two programs run together:

```
browser (index.html) --wss--> bridge.js (port 8081) --> Minecraft 26.3 server (port 25565)
```

`bridge.js` handles the Eaglercraft login and then passes normal Minecraft traffic to the server.

## 1. Requirements (on the computer that hosts the server)

- Java 21 or newer
- Node.js 18 or newer
- The **Minecraft 26.3 server jar** (from minecraft.net/download/server, or a Paper 26.3 build). Save it as `server/minecraft/server.jar`.

## 2. Start it

```bash
cd server
./start.sh        # Windows: double-click start.bat
```

On the first run, Minecraft creates `minecraft/eula.txt` and stops. Read the EULA, change the file to `eula=true`, and run the script again.

`minecraft/server.properties` is already set up for survival. Keep `online-mode=false`: Eaglercraft players don't have Microsoft accounts.

## 3. Get a public `wss://` address

When `index.html` is opened over `https://` (for example GitHub Pages), it can only connect to `wss://` addresses. Expose port **8081** with any HTTPS tunnel or reverse proxy, for example:

- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8081` gives a free `https://….trycloudflare.com` URL. Use it as `wss://….trycloudflare.com`. A quick tunnel gets a new URL every restart. A named tunnel on your own domain keeps the same one.
- A VPS with nginx or Caddy proxying a domain to `localhost:8081` with TLS.

## 4. Point the client at it

In `index.html`, search for `YOUR-DONUTS-ADDRESS-HERE` and replace it with your address:

```js
{ addr: "wss://your-address-here", name: "Donuts (School)", hideAddr: true }
```

"Donuts (School)" then appears in the Multiplayer list for everyone using the page.

## Bridge settings (optional environment variables)

| Variable      | Default            |
|---------------|--------------------|
| `BRIDGE_PORT` | `8081`             |
| `MC_HOST`     | `127.0.0.1`        |
| `MC_PORT`     | `25565`            |
| `MOTD`        | `Donuts (School)\|Simple survival` |
| `MAX_PLAYERS` | `20`               |

Note: with `online-mode=false`, anyone can join under any username. Consider a login plugin (on Paper) or `white-list=true` if that matters.
