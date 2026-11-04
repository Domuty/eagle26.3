// Donuts (School) - Eaglercraft 26.3 WebSocket bridge
//
// Browsers can't open raw TCP sockets, so the Eaglercraft client talks to this
// bridge over a WebSocket. The bridge answers the EaglerX login handshake and
// then pipes ordinary Minecraft packets to/from a normal Java Edition server
// (vanilla or Paper 26.3, offline mode) on localhost.
//
//   browser --ws--> bridge.js :8081 --tcp--> minecraft server :25565
//
// Usage: node bridge.js   (settings via env vars, see CONFIG below)

const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const CONFIG = {
  listenPort: Number(process.env.BRIDGE_PORT || 8081),
  mcHost: process.env.MC_HOST || '127.0.0.1',
  mcPort: Number(process.env.MC_PORT || 25565),
  serverName: process.env.SERVER_NAME || 'Donuts (School)',
  motd: (process.env.MOTD || 'Donuts (School)|Simple survival').split('|'),
  maxPlayers: Number(process.env.MAX_PLAYERS || 20),
  gameProtocol: 777, // Minecraft 26.3
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- small binary helpers ----------
function writeVarInt(n) {
  const out = [];
  n >>>= 0;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function readVarInt(buf, off) {
  let n = 0, shift = 0, b;
  do {
    if (off >= buf.length) return null;
    b = buf[off++];
    n |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  } while (b & 0x80);
  return { value: n | 0, off };
}
function mcString(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([writeVarInt(b.length), b]); }
function str8(s) { const b = Buffer.from(s, 'latin1'); return Buffer.concat([Buffer.from([b.length]), b]); }
function offlineUUID(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  return h;
}

let online = 0;
const playerNames = new Set();

// ---------- MOTD for the server list ----------
function motdJSON() {
  return JSON.stringify({
    name: CONFIG.serverName, brand: 'Donuts', vers: 'DonutsBridge/1.0', cracked: true,
    time: Date.now(), uuid: '6f1c3c8e-1b1e-4a5b-9d2e-0d0e0a0b0c0d', type: 'motd',
    data: { cache: false, motd: CONFIG.motd, icon: false, online, max: CONFIG.maxPlayers, players: [...playerNames].slice(0, 9) },
  });
}

// ---------- per-connection handler ----------
function handle(ws, req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let stage = 'version'; // version -> login -> profile -> game
  let username = null;
  let tcp = null, tcpBuf = Buffer.alloc(0), compression = -1, mcState = 'login';
  const pendingToServer = [];
  // The 26.3 Eagler client sends ClientIntention + Hello, then moves straight to the
  // configuration phase (an Eagler proxy normally finishes the login for it). So the
  // bridge finishes the vanilla login itself and holds client packets until then.
  let clientLoginPackets = 0;
  const heldUntilLogin = [];

  const fail = (msg) => {
    try { ws.send(Buffer.concat([Buffer.from([0xff, 0x08]), str8(msg)])); } catch (e) {}
    try { ws.close(); } catch (e) {}
  };

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const t = data.toString();
      if (/^accept:\s*motd/i.test(t)) { ws.send(motdJSON()); ws.close(); }
      return;
    }
    const b = Buffer.from(data);
    try {
      if (stage === 'game') return toServer(b);
      if (stage === 'version') return onClientVersion(b);
      if (stage === 'login') return onRequestLogin(b);
      if (stage === 'profile') return onProfile(b);
    } catch (e) { log('protocol error from', ip, e.message); fail('Bridge error: ' + e.message); }
  });
  ws.on('close', () => { if (tcp) tcp.destroy(); if (username) { online--; playerNames.delete(username); log(username, 'left'); } });
  ws.on('error', () => {});

  // 0x01 CLIENT_VERSION: [01][02][u16 n][u16 eaglerVers*n][u16 m][u16 gameVers*m][str8 brand][str8 version][u8 auth][str8 username]
  function onClientVersion(b) {
    if (b[0] !== 0x01 || b[1] !== 0x02) return fail('Outdated client');
    let o = 2;
    const n = b.readUInt16BE(o); o += 2;
    const eaglerVers = []; for (let i = 0; i < n; i++) { eaglerVers.push(b.readUInt16BE(o)); o += 2; }
    const m = b.readUInt16BE(o); o += 2;
    const gameVers = []; for (let i = 0; i < m; i++) { gameVers.push(b.readUInt16BE(o)); o += 2; }
    if (!eaglerVers.includes(3)) return fail('Unsupported Eaglercraft handshake');
    if (!gameVers.includes(CONFIG.gameProtocol)) return fail('This server needs Minecraft 26.3');
    // 0x02 SERVER_VERSION: [02][u16 eaglerVer][u16 gameVer][str8 brand][str8 version][u8 authMethod][u16 saltLen]
    ws.send(Buffer.concat([
      Buffer.from([0x02]), u16(3), u16(CONFIG.gameProtocol),
      str8('Donuts'), str8('1.0'), Buffer.from([0]), u16(0),
    ]));
    stage = 'login';
  }

  // 0x04 CLIENT_REQUEST_LOGIN: [04][str8 username][str8 requestedServer][str8 password]
  function onRequestLogin(b) {
    if (b[0] !== 0x04) return fail('Unexpected login packet');
    const len = b[1];
    const name = b.slice(2, 2 + len).toString('latin1');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return fail('Invalid username (3-16 letters, numbers or _)');
    if (playerNames.has(name)) return fail('Someone with that username is already online');
    if (online >= CONFIG.maxPlayers) return fail('Server is full');
    username = name; online++; playerNames.add(name);
    const uuid = offlineUUID(name);
    // 0x05 SERVER_ALLOW_LOGIN: [05][str8 username][16 byte uuid]
    ws.send(Buffer.concat([Buffer.from([0x05]), str8(name), uuid]));
    stage = 'profile';
    log(name, 'logging in from', ip);
    connectBackend();
  }

  // 0x07 CLIENT_PROFILE_DATA (skins etc, ignored) ... until 0x08 CLIENT_FINISH_LOGIN
  function onProfile(b) {
    if (b[0] === 0x07) return;
    if (b[0] === 0x08) {
      ws.send(Buffer.from([0x09])); // SERVER_FINISH_LOGIN
      stage = 'game';
      return;
    }
    fail('Unexpected handshake packet 0x' + b[0].toString(16));
  }

  function connectBackend() {
    tcp = net.connect(CONFIG.mcPort, CONFIG.mcHost);
    tcp.setNoDelay(true);
    tcp.on('connect', () => {
      for (const p of pendingToServer.splice(0)) writeServer(p);
    });
    tcp.on('data', onServerData);
    tcp.on('error', (e) => { log('backend error:', e.message); fail('The Minecraft server is offline'); });
    tcp.on('close', () => { try { ws.close(); } catch (e) {} });
  }

  // Client -> server: each WebSocket frame is one packet (id + payload, no length).
  function toServer(pkt) {
    if (mcState === 'play') return queueServer(pkt);
    if (clientLoginPackets === 0) {
      // If the client did not send its own intention/hello packets, make them.
      const first = readVarInt(pkt, 0);
      if (!first || first.value !== 0x00 || !looksLikeIntention(pkt, first.off)) {
        queueServer(Buffer.concat([writeVarInt(0x00), writeVarInt(CONFIG.gameProtocol), mcString(CONFIG.mcHost), u16(CONFIG.mcPort), writeVarInt(2)]));
        queueServer(Buffer.concat([writeVarInt(0x00), mcString(username), offlineUUID(username)]));
        clientLoginPackets = 2;
      }
    }
    if (clientLoginPackets < 2) { clientLoginPackets++; return queueServer(pkt); }
    heldUntilLogin.push(pkt);
  }
  function looksLikeIntention(pkt, off) {
    const pv = readVarInt(pkt, off);
    return pv && pv.value === CONFIG.gameProtocol;
  }
  function queueServer(p) { if (tcp && !tcp.connecting) writeServer(p); else pendingToServer.push(p); }
  function writeServer(p) {
    if (compression >= 0) p = Buffer.concat([writeVarInt(0), p]); // send uncompressed, allowed by protocol
    tcp.write(Buffer.concat([writeVarInt(p.length), p]));
  }

  // Login-phase packets from the server are handled by the bridge, never forwarded.
  function onServerLoginPacket(p) {
    const id = readVarInt(p, 0);
    switch (id.value) {
      case 0x00: { // Disconnect (JSON text)
        const r = readVarInt(p, id.off);
        const msg = textFromJSON(p.slice(r.off, r.off + r.value).toString('utf8'));
        log(username, 'kicked during login:', msg);
        if (ws.readyState === 1) ws.send(configDisconnect(msg));
        return ws.close();
      }
      case 0x01: // Encryption request = online mode
        log('Server is in online mode! Set online-mode=false in server.properties');
        if (ws.readyState === 1) ws.send(configDisconnect('Server misconfigured: online-mode must be false'));
        return ws.close();
      case 0x02: // Login Success -> acknowledge it ourselves, then release the client's packets
        writeServer(writeVarInt(0x03));
        mcState = 'play';
        for (const h of heldUntilLogin.splice(0)) writeServer(h);
        log(username, 'joined');
        return;
      case 0x03: // Set Compression
        compression = readVarInt(p, id.off).value;
        return;
      case 0x04: { // Custom query (mods/proxies) -> "not understood"
        const mid = readVarInt(p, id.off);
        return writeServer(Buffer.concat([writeVarInt(0x02), writeVarInt(mid.value), Buffer.from([0])]));
      }
      case 0x05: { // Cookie request -> no cookie
        const l = readVarInt(p, id.off);
        const key = p.slice(id.off, l.off + l.value);
        return writeServer(Buffer.concat([writeVarInt(0x04), key, Buffer.from([0])]));
      }
    }
  }

  // Server -> client: strip TCP length prefix (and compression), send one frame per packet.
  function onServerData(chunk) {
    tcpBuf = tcpBuf.length ? Buffer.concat([tcpBuf, chunk]) : chunk;
    for (;;) {
      const len = readVarInt(tcpBuf, 0);
      if (!len || tcpBuf.length < len.off + len.value) break;
      let p = tcpBuf.slice(len.off, len.off + len.value);
      tcpBuf = tcpBuf.slice(len.off + len.value);
      if (compression >= 0) {
        const dl = readVarInt(p, 0);
        p = dl.value === 0 ? p.slice(dl.off) : zlib.inflateSync(p.slice(dl.off));
      }
      if (mcState === 'login') { onServerLoginPacket(p); continue; }
      if (ws.readyState === 1) ws.send(p);
    }
  }
}

// Disconnect packet in the configuration phase (0x02) with a plain NBT string as the reason.
function configDisconnect(text) {
  const t = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(0x02), Buffer.from([0x08]), u16(t.length), t]);
}
function textFromJSON(s) {
  try {
    const flat = (c) => typeof c === 'string' ? c : (c.text || c.translate || '') + (c.extra || []).map(flat).join('');
    return flat(JSON.parse(s));
  } catch (e) { return s; }
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }

const wss = new WebSocketServer({ port: CONFIG.listenPort, perMessageDeflate: false });
wss.on('connection', handle);
log(`Donuts bridge listening on ws://0.0.0.0:${CONFIG.listenPort} -> ${CONFIG.mcHost}:${CONFIG.mcPort}`);
