# LiveTime OBS Bridge — Grand River RC

Connects to the LiveTime scoring engine and serves a live OBS overlay.

## Files

| File | Description |
|------|-------------|
| `livetime_bridge.js` | Node.js bridge server |
| `obs_overlay.html` | OBS browser source overlay |
| `grrclogo.jpg` | Track logo (place in same folder as HTML) |
| `start.sh` | Manual start script |
| `install-service.sh` | Install as auto-start service |

## Quick Start (manual)

```bash
# 1. Install Node.js if not already installed
sudo apt install nodejs npm

# 2. Install dependencies (first time only)
npm install

# 3. Run the bridge
./start.sh
```

## Auto-start on boot (recommended)

```bash
sudo bash install-service.sh
```

After this the bridge starts automatically whenever the computer boots.

**Manage the service:**
```bash
sudo systemctl status livetime-bridge    # check it's running
sudo systemctl restart livetime-bridge   # restart after changes
sudo journalctl -u livetime-bridge -f    # watch live logs
```

## OBS Setup

1. In OBS, add a **Browser Source**
2. Set size to **1920 × 1080**
3. Check **"Transparent background"**
4. Set URL to:
   ```
   http://<ubuntu-ip>:8000/obs_overlay.html?api=http://<ubuntu-ip>:8000
   ```
   Example: `http://192.168.1.50:8000/obs_overlay.html?api=http://192.168.1.50:8000`

**Find the Ubuntu IP:**
```bash
ip addr show | grep "inet " | grep -v 127
```

## Diagnostic Tools

| URL | Description |
|-----|-------------|
| `http://<ip>:8000/packets` | Live packet monitor (browser) |
| `http://<ip>:8000/api/state` | Current decoded state (JSON) |
| `http://<ip>:8000/api/health` | Connection status |

## Config

Edit `LT_HOST` in `start.sh` or the systemd service if the scoring engine IP changes.


