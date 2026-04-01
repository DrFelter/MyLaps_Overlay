#!/bin/bash
# LiveTime Bridge startup script
# Edit LT_HOST below if the scoring engine IP changes

export LT_HOST=10.1.10.70:54235
export PORT=8000

echo "Starting LiveTime bridge..."
echo "  Scoring engine: $LT_HOST"
echo "  Bridge port:    $PORT"
echo "  Packet monitor: http://localhost:$PORT/packets"
echo ""

# Check node is installed
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not installed. Run: sudo apt install nodejs npm"
    exit 1
fi

# Install dependencies if node_modules missing
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

node livetime_bridge.js
