// LiveTime WebSocket -> JSON bridge for OBS overlays
//
// Requirements:  npm install express cors ws
// Run:
//   set LT_HOST=192.168.68.38:54235
//   node livetime_bridge.js

const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');
const crypto    = require('crypto');
const zlib      = require('zlib');

const PORT    = Number(process.env.PORT   || 8000);
const LT_HOST = process.env.LT_HOST || '192.168.68.38:54235';
const DEBUG   = process.env.DEBUG === '1';

// ─── AES-256-CBC codec ────────────────────────────────────────────────────
const KEY = Buffer.from('3E12EE3C794642E68CFB6478D72B3938', 'utf8');

function decodePacket(packetBytes) {
  try {
    const raw      = Buffer.from(packetBytes, 'base64');
    const innerB64 = zlib.inflateRawSync(raw).toString('utf8').trim();
    const cipher   = Buffer.from(innerB64, 'base64');
    const iv       = cipher.slice(0, 16);
    const enc      = cipher.slice(16);
    const dec      = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
    dec.setAutoPadding(false);
    const plain = Buffer.concat([dec.update(enc), dec.final()])
                        .toString('utf8').replace(/\0+$/, '');
    return JSON.parse(plain);
  } catch (e) { return null; }
}

function encodePacket(obj) {
  const json   = JSON.stringify(obj);
  const padLen = 16 - (json.length % 16);
  const padded = Buffer.concat([Buffer.from(json), Buffer.alloc(padLen, 0)]);
  const iv     = crypto.randomBytes(16);
  const enc    = crypto.createCipheriv('aes-256-cbc', KEY, iv);
  enc.setAutoPadding(false);
  const encrypted  = Buffer.concat([iv, enc.update(padded), enc.final()]);
  const compressed = zlib.deflateRawSync(Buffer.from(encrypted.toString('base64'), 'utf8'));
  return compressed.toString('base64');
}

// ─── State ────────────────────────────────────────────────────────────────
let currentRaceLID = null;
let wsRef          = null;
let invocId        = 100;

const state = {
  connection: { status: 'disconnected', reconnects: 0, last_error: null },
  live: {
    setting:          null,
    event_state:      null,
    race_state:       null,
    race_time:        null,
    practice_state:   null,
    practice_time:    null,
    practice_session: null,
    race_entry:       null,
    live_race_entry:  null,
  },
};

function log(...a) { if (DEBUG) console.log(new Date().toISOString(), ...a); }

// ─── SSE clients ──────────────────────────────────────────────────────────
// When key state changes, we push an SSE event so the overlay reacts instantly
// instead of waiting for the next poll cycle.
const sseClients = new Set();

function pushSSE(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { sseClients.delete(res); }
  }
}

// ─── Express ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.get('/',           (_req, res) => res.json({ ok: true, status: state.connection.status }));
app.get('/api/health', (_req, res) => res.json({ ok: true, connection: state.connection }));
app.get('/api/state',  (_req, res) => res.json(state.live));

// SSE endpoint — overlay connects once and gets pushed updates immediately
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send full state immediately on connect
  res.write(`event: state\ndata: ${JSON.stringify(state.live)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/overlay/race', (_req, res) => {
  const rs = state.live.race_state  || {};
  const rt = state.live.race_time   || {};
  const re = state.live.race_entry  || {};
  res.json({
    connected:     state.connection.status === 'connected',
    race_name:     rs.RaceClassName        || '',
    heat_name:     rs.RaceClassInformation || '',
    flag_type:     rt.FlagType,
    timer_running: rt.IsTimerRunning,
    time_elapsed:  rt.TimeElapsed,
    race_length:   rt.RaceLength,
    laps_left:     rt.LapsLeft,
    in_caution:    rt.IsInCaution,
    entries: (re.RaceEntries || []).map(e => ({
      position: e.OrderNumber, number: e.Number,
      driver:   (e.DriverName || '') + ' ' + (e.DriverLastName || ''),
      laps:     e.CompletedLaps, best_lap: e.FastestLap,
      avg_lap:  e.AverageLap,   result:   e.Result,
    })),
  });
});

// ─── Dynamic race entry request ───────────────────────────────────────────
function requestRaceEntries(raceLID) {
  if (!wsRef || wsRef.readyState !== 1) return;
  wsRef.send(JSON.stringify({
    type: 1, invocationId: String(++invocId), target: 'Request',
    arguments: [{ packetType: 'RaceEntryByRaceRequest', packetBytes: encodePacket({ RaceLID: raceLID }) }],
  }) + '\x1e');
  console.log(`TX RaceEntryByRaceRequest RaceLID=${raceLID}`);
}

// ─── Packet handler ───────────────────────────────────────────────────────
function handlePacket(type, data) {
  switch (type) {

    case 'LiveSettingResponse':
      state.live.setting = data;
      break;

    case 'LiveStateResponse':
      state.live.event_state = data;
      // Push mode change immediately to all SSE clients
      pushSSE('state', state.live);
      console.log(`LiveState = ${data.LiveState} (0=practice, 1=race)`);
      break;

    case 'LiveModeResponse':
      // Explicit mode change broadcast from scoring engine.
      // Re-request LiveState to get the freshest value.
      if (wsRef && wsRef.readyState === 1) {
        wsRef.send(JSON.stringify({
          type: 1, invocationId: String(++invocId), target: 'Request',
          arguments: [{ packetType: 'LiveStateRequest',
                        packetBytes: 'C3SvNDCOyE80CCv0NHAsqfT3y0wODPVLsghNdExMMjf3zTMrKHAJcUoqcrQFAA==' }],
        }) + '\x1e');
        log('LiveModeResponse received → re-requesting LiveState');
      }
      break;

    case 'LiveRaceStateResponse':
      state.live.race_state = data;
      if (data.RaceLID && data.RaceLID !== currentRaceLID) {
        currentRaceLID = data.RaceLID;
        console.log(`Race changed → RaceLID=${currentRaceLID}, fetching entries`);
        setTimeout(() => requestRaceEntries(currentRaceLID), 200);
      }
      pushSSE('state', state.live);
      break;

    case 'LiveRaceTimeSyncResponse':
      state.live.race_time = data;
      pushSSE('time', { race_time: data });
      break;

    case 'LivePracticeStateResponse':
      state.live.practice_state = data;
      pushSSE('state', state.live);
      break;

    case 'LivePracticeTimeSyncResponse':
      state.live.practice_time = data;
      pushSSE('time', { practice_time: data });
      break;

    case 'LivePracticeSessionResponse':
      state.live.practice_session = data;
      pushSSE('state', state.live);
      break;

    case 'RaceEntryByRaceResponse':
      state.live.race_entry = data;
      if (data.Race?.LID) currentRaceLID = data.Race.LID;
      console.log(`RaceEntries received: ${(data.RaceEntries || []).length} drivers`);
      pushSSE('state', state.live);
      break;

    case 'LiveRaceEntryResponse':
      state.live.live_race_entry = data;
      pushSSE('state', state.live);
      break;
  }
}

// ─── SignalR client ───────────────────────────────────────────────────────
async function connectSignalR() {
  state.connection.status = 'connecting';

  const neg = await fetch(`http://${LT_HOST}/signalr/negotiate?negotiateVersion=1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  if (!neg.ok) throw new Error(`Negotiate HTTP ${neg.status}`);
  const { connectionToken, connectionId, id } = await neg.json();
  const token = connectionToken || connectionId || id;
  if (!token) throw new Error('No connection token');

  const ws = new WebSocket(`ws://${LT_HOST}/signalr?id=${encodeURIComponent(token)}`);
  wsRef = ws;
  let handshakeDone = false;

  function send(obj) { ws.send(JSON.stringify(obj) + '\x1e'); }
  function request(invId, packetType, packetBytes) {
    send({ type: 1, invocationId: String(invId), target: 'Request',
           arguments: [{ packetType, packetBytes }] });
    log('TX', packetType);
  }

  ws.on('open', () => {
    state.connection.status = 'connected';
    log('WS connected');
    send({ protocol: 'json', version: 1 });
  });

  ws.on('message', raw => {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    for (const part of text.split('\x1e').filter(Boolean)) {
      try {
        const msg = JSON.parse(part);

        if (!handshakeDone && Object.keys(msg).length === 0) {
          handshakeDone = true;
          log('Handshake OK');
          const REQ = [
            [1, 'LoginRequest',              'BcHJgoIgAADQD+oAhbkc5hApuU6Ja960wi0pGZXy6+c9pzUgl9mLq5/hTHiwgoHiJBLq2AJWR5J6D462XepNvc50FB+s3ZR7T9GqmYYp/Q0dUCKfzH6wHrPT+PRBrNgsIOGtuncHFUG7HqriPR779Ss7d38t+y32k0ZAjRBDGDlqzGL/4BE2M+aagQOWb/9Wsb0WaXmjqSX6AqYOziSQ3SmJN6SiO9dNahPkSm2YVEThVTp6qDWT8sKRmNeZJbBZ7ue/jg3j4qOLsilnl1s//w=='],
            [2, 'LiveStateRequest',           'C3SvNDCOyE80CCv0NHAsqfT3y0wODPVLsghNdExMMjf3zTMrKHAJcUoqcrQFAA=='],
            [3, 'LiveSettingRequest',          '89GOqiosDEkOLCg3LKg0CjfPK7QINvUyDdI2LgzIDwkMN9cPSosyyEyOyLYFAA=='],
            [4, 'LiveRaceStateRequest',        'Ky80KI8I83bLTvIsC4gyNnAyC0x2L8vLdEvKzjHPyPQudUn10S/TLsizTLYFAA=='],
            [5, 'LivePracticeStateRequest',    'S0mrrHIJKS038siMcgxNKYqMKndzyg2LMihKzDDzNnU0dHMudIsMD3d0CrUFAA=='],
            [6, 'LivePracticeTimeSyncRequest', 'Sy/KK7VICvM1S8lLzisydg/O9Q4pSowwSQ4PqwyOKsgvs/TP9yzNrfDLC7QFAA=='],
            [7, 'LivePracticeSessionRequest',  'K3NN8Q3NDk+tjLJIqwwy9AmqDA8tTnMvTdGOTDFO9zbwCTUyDjL0NXYMiLQFAA=='],
            [9, 'LiveRaceTimeSyncRequest',     'Ky80KI8I83bLTvIsC4gyNnAyC0x2L8vLdEvKzjHPyPQudUn10S/TLsizTLYFAA=='],
          ];
          REQ.forEach(([i, t, b], idx) => setTimeout(() => request(i, t, b), idx * 300));
          return;
        }

        if (msg.type === 1 && msg.target === 'Response') {
          const pkt = msg.arguments?.[0];
          if (!pkt) return;
          const decoded = decodePacket(pkt.packetBytes);
          if (decoded) {
            log('RX', pkt.packetType, JSON.stringify(decoded).slice(0, 120));
            handlePacket(pkt.packetType, decoded);
          }
        }
      } catch (e) { log('parse error', e.message); }
    }
  });

  ws.on('close', () => {
    state.connection.status = 'disconnected';
    state.connection.reconnects++;
    pushSSE('connection', { status: 'disconnected' });
    log('WS closed, reconnecting in 3s');
    setTimeout(() => connectSignalR().catch(err => {
      state.connection.status = 'error';
      state.connection.last_error = String(err.message || err);
    }), 3000);
  });

  ws.on('error', err => {
    state.connection.status = 'error';
    state.connection.last_error = err.message;
    log('WS error', err.message);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`LiveTime bridge  http://127.0.0.1:${PORT}`);
  console.log(`  /api/state   – full JSON state (poll)`);
  console.log(`  /api/events  – SSE stream (instant push)`);
  try {
    await connectSignalR();
  } catch (e) {
    state.connection.status = 'error';
    state.connection.last_error = String(e.message || e);
    console.error('Initial connect failed:', e.message);
  }
});
