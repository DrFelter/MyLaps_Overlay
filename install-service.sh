#!/bin/bash
# Install livetime-bridge as a systemd service so it starts automatically on boot
# Run once with: sudo bash install-service.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="$SUDO_USER"
if [ -z "$SERVICE_USER" ]; then SERVICE_USER="$USER"; fi

echo "Installing livetime-bridge service..."
echo "  Directory: $SCRIPT_DIR"
echo "  User:      $SERVICE_USER"

# Install Node if missing
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

# Install npm deps
cd "$SCRIPT_DIR"
npm install

# Create systemd service
cat > /etc/systemd/system/livetime-bridge.service << UNIT
[Unit]
Description=LiveTime OBS Bridge
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SCRIPT_DIR
Environment=LT_HOST=10.1.10.70:54235
Environment=PORT=8000
ExecStart=/usr/bin/node livetime_bridge.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable livetime-bridge
systemctl start livetime-bridge

echo ""
echo "Done! Service status:"
systemctl status livetime-bridge --no-pager
echo ""
echo "Useful commands:"
echo "  sudo systemctl status livetime-bridge   # check status"
echo "  sudo systemctl restart livetime-bridge  # restart"
echo "  sudo journalctl -u livetime-bridge -f   # live logs"
