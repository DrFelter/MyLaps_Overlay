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
const LT_HOST = process.env.LT_HOST || '10.1.10.70:54235';
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

app.get('/packets', (_req, res) => res.type('html').send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>LiveTime Packet Monitor</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b1020; color: #c8d4e0; font-family: 'Courier New', monospace; font-size: 13px; }
  header { background: #0f1828; border-bottom: 2px solid #18b4d4; padding: 14px 20px;
           display: flex; align-items: center; gap: 20px; position: sticky; top: 0; z-index: 10; }
  h1 { font-size: 18px; font-weight: 700; color: #18b4d4; letter-spacing: .06em; font-family: sans-serif; }
  .badge { background: #18b4d4; color: #0b1020; font-size: 11px; font-weight: 800;
           padding: 2px 8px; border-radius: 3px; letter-spacing: .06em; }
  .badge.off { background: #e03030; }
  label { font-family: sans-serif; font-size: 12px; color: #8fa8bf; }
  input[type=text] { background: #1a2538; border: 1px solid #2a3a50; color: #fff;
                     padding: 4px 8px; border-radius: 3px; font-size: 12px; width: 200px; }
  #log { padding: 12px; display: flex; flex-direction: column; gap: 6px; }
  .entry { background: #0f1828; border: 1px solid #1a2a40; border-left: 3px solid #18b4d4;
           border-radius: 4px; padding: 8px 12px; transition: border-color .2s; }
  .entry.flash { border-left-color: #f5c542; }
  .entry-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; }
  .ptype { color: #18b4d4; font-weight: 700; font-size: 13px; }
  .ptime { color: #4a6070; font-size: 11px; }
  .pdata { color: #8fa8bf; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
  .pdata.expanded { color: #c8d4e0; }
  .toggle { cursor: pointer; color: #18b4d4; font-size: 11px; margin-left: auto; user-select: none; }
  .count { font-family: sans-serif; font-size: 12px; color: #4a6070; margin-left: auto; }
</style>
</head>
<body>
<header>
  <h1>⚡ LiveTime Packet Monitor</h1>
  <span class="badge off" id="status">CONNECTING</span>
  <label>Filter: <input type="text" id="filter" placeholder="e.g. RaceEntry"></label>
  <span class="count" id="count">0 packets</span>
  <label><input type="checkbox" id="pause"> Pause</label>
</header>
<div id="log"></div>
<script>
const log     = document.getElementById('log');
const filterEl= document.getElementById('filter');
const pauseEl = document.getElementById('pause');
const countEl = document.getElementById('count');
const statusEl= document.getElementById('status');
let total = 0;

function ts(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false }) + '.' +
         String(d.getMilliseconds()).padStart(3,'0');
}

function addEntry(pkt) {
  if (pauseEl.checked) return;
  const f = filterEl.value.trim().toLowerCase();
  if (f && !pkt.type.toLowerCase().includes(f)) return;
  total++;
  countEl.textContent = total + ' packets';

  const el = document.createElement('div');
  el.className = 'entry flash';
  setTimeout(() => el.classList.remove('flash'), 400);

  const summary = JSON.stringify(pkt.data).slice(0, 120);
  el.innerHTML = \`
    <div class="entry-head">
      <span class="ptype">\${pkt.type}</span>
      <span class="ptime">\${ts(pkt.at)}</span>
      <span class="toggle" onclick="toggleExpand(this)">▼ expand</span>
    </div>
    <div class="pdata">\${summary}\${pkt.data && JSON.stringify(pkt.data).length > 120 ? '…' : ''}</div>
  \`;
  el._full = JSON.stringify(pkt.data, null, 2);
  log.prepend(el);
  // Keep DOM lean
  while (log.children.length > 150) log.removeChild(log.lastChild);
}

window.toggleExpand = function(btn) {
  const entry = btn.closest('.entry');
  const pdata = entry.querySelector('.pdata');
  if (btn.textContent.startsWith('▼')) {
    pdata.textContent = entry._full;
    pdata.classList.add('expanded');
    btn.textContent = '▲ collapse';
  } else {
    pdata.textContent = JSON.stringify(JSON.parse(entry._full)).slice(0, 120) + '…';
    pdata.classList.remove('expanded');
    btn.textContent = '▼ expand';
  }
};

// Load recent packets on open
fetch('/api/packets?n=50')
  .then(r => r.json())
  .then(pkts => pkts.reverse().forEach(addEntry));

// Then stream live
const es = new EventSource('/api/packets/stream');
es.onopen = () => { statusEl.textContent = 'LIVE'; statusEl.classList.remove('off'); };
es.onerror = () => { statusEl.textContent = 'DISCONNECTED'; statusEl.classList.add('off'); };
es.onmessage = e => { try { addEntry(JSON.parse(e.data)); } catch(_) {} };
</script>
</body>
</html>`));


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

// ─── Raw packet log ───────────────────────────────────────────────────────
const packetLog = [];          // ring buffer, last 200 packets
const packetSseClients = new Set();

function logPacket(type, decoded) {
  const entry = { at: new Date().toISOString(), type, data: decoded };
  packetLog.unshift(entry);
  if (packetLog.length > 200) packetLog.length = 200;
  // Push to any watching SSE clients
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of packetSseClients) {
    try { res.write(payload); } catch (e) { packetSseClients.delete(res); }
  }
}

// GET /api/packets         – last N decoded packets as JSON
app.get('/api/packets', (req, res) => {
  const n = Math.min(parseInt(req.query.n || 50), 200);
  res.json(packetLog.slice(0, n));
});

// GET /api/packets/stream  – SSE stream of every decoded packet as it arrives
app.get('/api/packets/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`: connected\n\n`);
  packetSseClients.add(res);
  req.on('close', () => packetSseClients.delete(res));
});


// ─── Live race entry cache (handles IsDelta merging) ─────────────────────
let liveRaceEntryCache = {};  // keyed by RaceEntryLID

function mergeLiveRaceEntries(data) {
  const entries = data.LiveRaceEntries || [];
  if (!data.IsDelta) {
    liveRaceEntryCache = {};
    entries.forEach(e => { liveRaceEntryCache[e.RaceEntryLID] = e; });
  } else {
    entries.forEach(e => { liveRaceEntryCache[e.RaceEntryLID] = e; });
  }
  return Object.values(liveRaceEntryCache).sort((a, b) => a.Position - b.Position);
}

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
        liveRaceEntryCache = {};  // reset for new race
        state.live.live_race_entry = null;
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

    case 'LiveRaceEntryResponse': {
      const sorted = mergeLiveRaceEntries(data);
      // Normalize to consistent field names the overlay expects
      state.live.live_race_entry = {
        IsDelta: data.IsDelta,
        LiveRaceEntries: sorted.map(e => ({
          RaceEntryLID:            e.RaceEntryLID,
          Position:                e.Position,
          Number:                  e.Number,
          DriverName:              e.DriverName,
          Laps:                    e.Laps,
          LapTime:                 e.LapTime   ? parseFloat(e.LapTime)   : null,
          FastestLap:              e.FastestLap? parseFloat(e.FastestLap): null,
          Pace:                    e.Pace,
          SortTimeBehindLeader:    e.SortTimeBehindLeader,
          SortTimeBehindPositionAbove: e.SortTimeBehindPositionAbove,
          IsFastestLapInRace:      e.IsFastestLapInRace,
          IsDriverTransponderCheckedIn: e.IsDriverTransponderCheckedIn,
          IsBroken:                e.IsBroken,
          IsDisqualified:          e.IsDisqualified,
          IsDidNotFinish:          e.IsDidNotFinish,
          IsComplete:              e.IsComplete,
          LiveEstimatedQualifyingPosition: e.LiveEstimatedQualifyingPosition,
          RaceClassColor:          e.RaceClassColor,
          RaceClassName:           e.RaceClassName,
        })),
      };
      console.log(`LiveRaceEntry: ${sorted.length} drivers, IsDelta=${data.IsDelta}`);
      pushSSE('state', state.live);
      break;
    }
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
            logPacket(pkt.packetType, decoded);
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
  console.log(`  /api/state          – full JSON state (poll)`);
  console.log(`  /api/events         – SSE stream (instant push)`);
  console.log(`  /packets            – live packet monitor (browser)`);
  console.log(`  /api/packets        – last 50 decoded packets (JSON)`);
  console.log(`  /api/packets/stream – SSE stream of raw packets`);
  try {
    await connectSignalR();
  } catch (e) {
    state.connection.status = 'error';
    state.connection.last_error = String(e.message || e);
    console.error('Initial connect failed:', e.message);
  }
});
