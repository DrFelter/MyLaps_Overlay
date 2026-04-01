# LiveTime OBS Overlay — Project Context

## What This Is
A Node.js bridge server + HTML overlay for streaming RC racing on Twitch/YouTube via OBS.
Connects to a LiveTime scoring engine via SignalR WebSocket, decrypts the packets,
and serves live race/practice data to an OBS browser source overlay.

## Repo
https://github.com/DrFelter/MyLaps_Overlay

## Key Files
- `livetime_bridge.js` — Node.js bridge server (port 8000)
- `obs_overlay.html` — OBS browser source (1920×1080, transparent bg)
- `grrclogo.jpg` — Track logo (must be in same folder as HTML)
- `package.json` — Node dependencies: express, cors, ws
- `install-service.sh` — Installs bridge as systemd service on Ubuntu
- `start.sh` — Manual start script

## Network
- Scoring engine IP: `10.1.10.70:54235`
- Bridge runs on Ubuntu box at track, port 8000
- OBS URL: `http://<ubuntu-ip>:8000/obs_overlay.html?api=http://<ubuntu-ip>:8000`

## Encryption
LiveTime uses AES-256-CBC with a hardcoded key found in `LiveTime.DeviceCenter.Service.Client.dll`:
```
KEY_STRING = "3E12EE3C794642E68CFB6478D72B3938"
```
Wire encoding: `JSON → null-pad to 16 bytes → AES-256-CBC (IV prepended) → base64 → deflateRaw → base64`

## SignalR Protocol
- Negotiate: `POST http://<host>/signalr/negotiate?negotiateVersion=1`
- WebSocket: `ws://<host>/signalr?id=<token>`
- Handshake: send `{"protocol":"json","version":1}\x1e`, wait for `{}\x1e`
- Messages delimited by `\x1e` (record separator)
- All requests use `type:1, target:"Request", arguments:[{packetType, packetBytes}]`

## Packet Types (subscriptions sent at startup)
| Request | Response | Notes |
|---------|----------|-------|
| LoginRequest | — | Auth token (static captured blob) |
| LiveStateRequest | LiveStateResponse | `LiveState: 0=practice, 1=race` |
| LiveSettingRequest | LiveSettingResponse | Sector/segment names |
| LiveRaceStateRequest | LiveRaceStateResponse | `RaceDisplayState: 1=staging, 3=racing` |
| LivePracticeStateRequest | LivePracticeStateResponse | Practice mode state |
| LivePracticeTimeSyncRequest | LivePracticeTimeSyncResponse | Practice timer |
| LivePracticeSessionRequest | LivePracticeSessionResponse | Per-driver practice laps (IsDelta support) |
| LiveRaceTimeSyncRequest | LiveRaceTimeSyncResponse | Race timer (IsTimerRunning always false — use elapsed>0 or RaceDisplayState===3) |
| — | LiveRaceEntryResponse | Auto-broadcast when race starts. Fields: Position, DriverName (full), Laps, LapTime (string→float), FastestLap (string→float), Pace (pre-formatted), IsFastestLapInRace, SortTimeBehindLeader |
| RaceEntryByRaceRequest | RaceEntryByRaceResponse | Requested dynamically when RaceLID changes. Fields: OrderNumber, DriverName, DriverLastName, CompletedLaps, FastestLap (float), StartMicrosecondsUTC |

## RaceEntryByRaceRequest — Dynamic
Sent when `LiveRaceStateResponse.RaceLID` changes. Bridge builds the packet dynamically:
```js
encodePacket({ RaceLID: raceLID })
```

## LiveRaceEntryResponse — Field Names
Different from RaceEntryByRaceResponse:
- `Position` (not OrderNumber)
- `Laps` (not CompletedLaps)  
- `LapTime` string (not LastLap)
- `FastestLap` string (bridge parses to float)
- `DriverName` = full name (no DriverLastName)
- `IsFastestLapInRace` = boolean (server-authoritative field best flag)
- `SortTimeBehindLeader` = gap in seconds (used for gap bar)
- `Pace` = pre-formatted string e.g. "23/5:00.124"
- `IsDelta` = true means only changed entries sent (bridge merges into cache)

## LivePracticeSessionResponse — Field Names
- `DriverName` = full name
- `NumberOfLaps` (not CompletedLaps)
- `FastestLap` = STRING (bridge parses to float)
- `AverageLap` = float
- `Overall` = "34/3:49.209" (used as Pace display)
- `LivePracticeSessionLaps[0]` = most recent lap `{LapTimeSeconds, LapNumber, IsValidLap}`
- `RaceClassName`, `RaceClassColor` = class info
- `IsDelta` = true means only changed drivers sent (bridge merges into cache)
- Bridge normalizes: `LastLap = LivePracticeSessionLaps[0].LapTimeSeconds`

## FlagType Enum
`1=green, 2=yellow, 3=red, 4=none/purple(pre-race), 5=white(last lap), 6=checkered`

## RaceDisplayState Enum
`0=idle, 1=pre-race/staging, 2=all checked in(unconfirmed), 3=racing, 4=finished`
Note: observed to jump 1→3 directly, state 2 may not appear.

## Bridge Architecture
- Express server on port 8000
- SSE endpoint `/api/events` — pushes state to overlay instantly on any packet
- `/api/state` — full JSON state (poll fallback)
- `/api/packets` — last 200 decoded packets (ring buffer)
- `/packets` — browser-based live packet monitor UI
- Separate caches: `liveRaceEntryCache` (keyed by RaceEntryLID), `practiceSessionCache` (keyed by LID)
- Both caches handle IsDelta merging
- `pushSSE('hotlap', {...})` fired when a lap beats field best in practice

## Overlay Architecture
- OBS Browser Source 1920×1080, transparent background
- SSE primary (instant mode switching) + 2s fallback poll
- **Practice mode**: `LiveState===0`, top bar shows "PRACTICE" left + logo right, no timer/pill/TQ
- **Race mode**: `LiveState===1`, full top bar with race info, heat pill, timer
- **Hot lap ticker**: rolling stock-market style strip below header in practice, one entry per class
- **Driver grid**: 5×2 = 10 slots. Practice shows LAPS/LAST/FAST. Race shows check-in pre-race, then LAST/FAST/PACE

## Hot Lap Detection Logic (bridge)
```js
// Before merging new delta into cache:
currentFieldBest = min(all cached FastestLaps)
// For each driver in delta:
isPersonalBest = abs(newLap.LapTimeSeconds - driver.FastestLap) < 0.005
beatsField = newLap.LapTimeSeconds < currentFieldBest
// Fire hotlap SSE only if BOTH true
```
Prevents false positives when a new driver's first lap trivially equals their own "best".

## Owner / Track
- John, Grand River RC, Grand Rapids MI
- Racing 1/12 scale 17.5 Masters class
- Target: Cleveland US Indoor Championships November 2026
- Training partners: Chuck Lonergan, Andrew Knapp
