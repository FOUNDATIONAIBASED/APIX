#!/usr/bin/env bash
# ============================================================
#  ApiX Gateway — Server Management Console
#  Usage: ./apix.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.apix.pid"
LOG_FILE="$SCRIPT_DIR/logs/apix.log"
ENV_FILE="$SCRIPT_DIR/.env"
NODE_MIN_VERSION=18

# ── Colors ──────────────────────────────────────────────────
R='\033[0;31m'   G='\033[0;32m'   Y='\033[1;33m'
B='\033[0;34m'   C='\033[0;36m'   W='\033[1;37m'
D='\033[2m'      N='\033[0m'

# ── Helpers ──────────────────────────────────────────────────
header() {
    clear
    echo -e "${B}╔══════════════════════════════════════════════════════╗${N}"
    echo -e "${B}║${W}         ApiX Gateway  —  Server Control Centre       ${B}║${N}"
    echo -e "${B}╠══════════════════════════════════════════════════════╣${N}"
    echo -e "${B}║${D}  Self-hosted SMS/MMS Gateway  •  Enterprise Edition   ${B}║${N}"
    echo -e "${B}╚══════════════════════════════════════════════════════╝${N}"
    echo ""
}

ok()   { echo -e "  ${G}✔${N}  $*"; }
err()  { echo -e "  ${R}✖${N}  $*"; }
info() { echo -e "  ${C}ℹ${N}  $*"; }
warn() { echo -e "  ${Y}⚠${N}  $*"; }
sep()  { echo -e "${D}  ──────────────────────────────────────────────────${N}"; }

pause() { echo ""; read -rp "  Press Enter to continue..." _; }

# ── Detect current server status ─────────────────────────────
get_port() { get_env PORT 3000; }

# Check if our PID file process is alive
is_running() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# Kill any process listening on our port (orphaned or foreign)
kill_port_occupant() {
    local port; port=$(get_port)
    local pids=""
    if command -v lsof &>/dev/null; then
        pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    fi
    if [[ -z "$pids" ]] && command -v ss &>/dev/null; then
        pids=$(ss -tlnp 2>/dev/null | grep -E ":$port[^0-9]|:$port " | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+' | tr '\n' ' ' || true)
    fi
    if [[ -n "$pids" ]]; then
        warn "Port $port is in use by PID(s): $pids — stopping them..."
        for pid in $pids; do
            kill "$pid" 2>/dev/null || true
        done
        sleep 1
        # Force kill if still alive
        for pid in $pids; do
            kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        done
        ok "Port $port cleared."
    fi
    # Also clean up stale PID file
    if [[ -f "$PID_FILE" ]]; then
        local saved_pid; saved_pid=$(cat "$PID_FILE")
        kill -0 "$saved_pid" 2>/dev/null || rm -f "$PID_FILE"
    fi
}

status_badge() {
    if is_running; then
        echo -e "${G}● RUNNING${N}"
    else
        echo -e "${R}○ STOPPED${N}"
    fi
}

# ── Read config value from .env ───────────────────────────────
get_env() {
    local key="$1" default="${2:-}"
    if [[ -f "$ENV_FILE" ]]; then
        local val
        val=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
        echo "${val:-$default}"
    else
        echo "$default"
    fi
}

set_env() {
    local key="$1" value="$2"
    if [[ -f "$ENV_FILE" ]]; then
        if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
            sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
        else
            echo "${key}=${value}" >> "$ENV_FILE"
        fi
    else
        echo "${key}=${value}" > "$ENV_FILE"
    fi
}

# ── Get machine IP addresses ──────────────────────────────────
get_ip_addresses() {
    # Try multiple methods to get LAN IP
    local ips=""

    if command -v hostname &>/dev/null; then
        ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | grep -v '^::' | head -5)
    fi

    if [[ -z "$ips" ]] && command -v ip &>/dev/null; then
        ips=$(ip -4 addr show | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -5)
    fi

    if [[ -z "$ips" ]] && command -v ifconfig &>/dev/null; then
        ips=$(ifconfig 2>/dev/null | grep -oP 'inet \K[\d.]+' | grep -v '127.0.0.1' | head -5)
    fi

    echo "$ips"
}

# ── Node.js detection ─────────────────────────────────────────
check_node() {
    if ! command -v node &>/dev/null; then
        return 1
    fi
    local ver
    ver=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])" 2>/dev/null)
    [[ "$ver" -ge $NODE_MIN_VERSION ]] 2>/dev/null
}

install_node_via_nvm() {
    info "Installing Node.js via nvm..."
    export NVM_DIR="$HOME/.nvm"
    if [[ ! -f "$NVM_DIR/nvm.sh" ]]; then
        info "Downloading nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    fi
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
    nvm install --lts
    nvm use --lts
    nvm alias default node
}

install_node_via_apt() {
    info "Installing Node.js via NodeSource (apt)..."
    if command -v curl &>/dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    else
        wget -qO- https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    fi
    sudo apt-get install -y nodejs
}

# ══════════════════════════════════════════════════════════════
#  MENU ACTIONS
# ══════════════════════════════════════════════════════════════

# ── 1. Install Dependencies ───────────────────────────────────
action_install() {
    header
    echo -e "  ${W}Installing ApiX Gateway Dependencies${N}"
    sep
    echo ""

    # ── Node.js ──
    if check_node; then
        ok "Node.js $(node --version) detected"
    else
        warn "Node.js $NODE_MIN_VERSION+ not found. Installing..."
        echo ""
        echo "  How would you like to install Node.js?"
        echo "  ${W}1${N}) nvm (recommended, no sudo required)"
        echo "  ${W}2${N}) apt/NodeSource (system-wide, requires sudo)"
        echo "  ${W}3${N}) Skip (I will install manually)"
        echo ""
        read -rp "  Choice [1-3]: " node_choice
        case "$node_choice" in
            1) install_node_via_nvm ;;
            2) install_node_via_apt ;;
            3) warn "Skipping Node.js install. Please install Node.js $NODE_MIN_VERSION+ manually." ;;
        esac
    fi

    # ── npm packages ──
    echo ""
    info "Installing npm packages..."
    cd "$SCRIPT_DIR"

    if [[ ! -f "package.json" ]]; then
        err "package.json not found in $SCRIPT_DIR"
        pause
        return
    fi

    if npm install; then
        ok "npm packages installed"
    else
        err "npm install failed. Check your internet connection."
        pause
        return
    fi

    # ── avahi-daemon for mDNS ──
    echo ""
    info "Checking mDNS (avahi-daemon) for auto-discovery..."
    if systemctl is-active --quiet avahi-daemon 2>/dev/null; then
        ok "avahi-daemon is running (mDNS broadcasts will work)"
    elif command -v avahi-daemon &>/dev/null; then
        warn "avahi-daemon installed but not running. Starting..."
        sudo systemctl enable avahi-daemon 2>/dev/null || true
        sudo systemctl start avahi-daemon 2>/dev/null || warn "Could not start avahi-daemon (non-critical)"
    else
        warn "avahi-daemon not found. Android auto-discovery via mDNS may not work."
        echo -e "  ${D}Install with: sudo apt install avahi-daemon${N}"
    fi

    # ── Create default .env if missing ──
    echo ""
    if [[ ! -f "$ENV_FILE" ]]; then
        info "Creating default .env configuration..."
        cp "$SCRIPT_DIR/.env.example" "$ENV_FILE" 2>/dev/null || cat > "$ENV_FILE" <<EOF
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || date | md5sum | head -c 64)
HMAC_SECRET=$(openssl rand -hex 32 2>/dev/null || date | md5sum | head -c 64)
MDNS_NAME=ApiX Gateway
AUTO_APPROVE_DEVICES=false
LOG_LEVEL=info
EOF
        ok ".env created with default settings"
    else
        ok ".env already exists"
    fi

    # ── Create logs dir ──
    mkdir -p "$SCRIPT_DIR/logs"
    ok "Logs directory ready: $SCRIPT_DIR/logs/"

    echo ""
    sep
    ok "Installation complete!"
    echo ""
    info "Next: Start the server with option ${W}2${N}"
    pause
}

# ── 2. Start Server ───────────────────────────────────────────
action_start() {
    header
    echo -e "  ${W}Starting ApiX Gateway Server${N}"
    sep
    echo ""

    if is_running; then
        warn "Server is already running (PID $(cat "$PID_FILE"))"
        local port; port=$(get_port)
        local ips; ips=$(get_ip_addresses)
        echo ""
        ok "Server accessible at:"
        while IFS= read -r ip; do
            [[ -n "$ip" ]] && echo -e "    ${C}http://$ip:$port${N}"
        done <<< "$ips"
        pause
        return
    fi

    if ! check_node; then
        err "Node.js $NODE_MIN_VERSION+ not found. Run option 1 (Install) first."
        pause
        return
    fi

    if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
        err "node_modules not found. Run option 1 (Install) first."
        pause
        return
    fi

    # Clear any orphaned process holding the port
    kill_port_occupant

    mkdir -p "$SCRIPT_DIR/logs"

    info "Launching server in background..."
    cd "$SCRIPT_DIR"
    nohup node src/index.js >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    sleep 2

    if is_running; then
        ok "Server started (PID $pid)"
        echo ""
        local port; port=$(get_env PORT 3000)
        local ips; ips=$(get_ip_addresses)
        echo -e "  ${W}Server endpoints:${N}"
        sep
        while IFS= read -r ip; do
            if [[ -n "$ip" ]]; then
                echo -e "    ${C}REST API   →  http://$ip:$port/api/v1/${N}"
                echo -e "    ${C}WebSocket  →  ws://$ip:$port/ws${N}"
                echo -e "    ${C}Web UI     →  http://$ip:$port/${N}"
                echo ""
            fi
        done <<< "$ips"
        echo -e "  ${D}mDNS broadcast: _apix._tcp.local (Android auto-discovery)${N}"
        echo -e "  ${D}Log file: $LOG_FILE${N}"
    else
        err "Server failed to start. Check logs: $LOG_FILE"
        tail -20 "$LOG_FILE" 2>/dev/null || true
    fi
    pause
}

# ── 3. Stop Server ────────────────────────────────────────────
action_stop() {
    header
    echo -e "  ${W}Stopping ApiX Gateway Server${N}"
    sep
    echo ""

    if ! is_running; then
        warn "Server is not running."
        pause
        return
    fi

    local pid; pid=$(cat "$PID_FILE")
    info "Sending SIGTERM to PID $pid..."
    kill "$pid" 2>/dev/null || true
    sleep 2

    if kill -0 "$pid" 2>/dev/null; then
        warn "Process still alive, sending SIGKILL..."
        kill -9 "$pid" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    ok "Server stopped."
    pause
}

# ── 4. Restart Server ─────────────────────────────────────────
action_restart() {
    header
    echo -e "  ${W}Restarting ApiX Gateway Server${N}"
    sep
    echo ""

    if is_running; then
        local pid; pid=$(cat "$PID_FILE")
        info "Stopping server (PID $pid)..."
        kill "$pid" 2>/dev/null || true
        sleep 2
        kill -9 "$pid" 2>/dev/null || true
        rm -f "$PID_FILE"
        ok "Server stopped."
    fi

    # Ensure port is free even if server was started outside apix.sh
    kill_port_occupant

    sleep 1
    info "Starting server..."
    cd "$SCRIPT_DIR"
    mkdir -p "$SCRIPT_DIR/logs"
    nohup node src/index.js >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    sleep 1

    if is_running; then
        ok "Server restarted (PID $pid)"
    else
        err "Server failed to restart. Check logs: $LOG_FILE"
    fi
    pause
}

# ── 5. Status & Info ──────────────────────────────────────────
action_status() {
    header
    echo -e "  ${W}Server Status & Connection Info${N}"
    sep
    echo ""

    local status_txt; status_txt=$(status_badge)
    echo -e "  Status     :  $status_txt"

    if is_running; then
        local pid; pid=$(cat "$PID_FILE")
        echo -e "  PID        :  ${W}$pid${N}"

        local started
        started=$(stat -c %y "$PID_FILE" 2>/dev/null | cut -d. -f1 || echo "unknown")
        echo -e "  Started    :  ${D}$started${N}"
    fi

    local port; port=$(get_env PORT 3000)
    echo -e "  Port       :  ${C}$port${N}"

    echo ""
    echo -e "  ${W}Network Interfaces:${N}"
    sep

    local ips; ips=$(get_ip_addresses)
    local found=0
    while IFS= read -r ip; do
        if [[ -n "$ip" ]]; then
            found=1
            echo -e "    IP       :  ${C}$ip${N}"
            echo -e "    REST API :  ${W}http://$ip:$port/api/v1/${N}"
            echo -e "    WebSocket:  ${W}ws://$ip:$port/ws${N}"
            echo -e "    Web UI   :  ${W}http://$ip:$port/${N}"
            echo ""
        fi
    done <<< "$ips"

    if [[ $found -eq 0 ]]; then
        warn "No network interfaces detected"
    fi

    # mDNS status
    echo -e "  ${W}mDNS Auto-Discovery:${N}"
    sep
    local mdns_name; mdns_name=$(get_env MDNS_NAME "ApiX Gateway")
    if systemctl is-active --quiet avahi-daemon 2>/dev/null; then
        ok "avahi-daemon running  •  service: _apix._tcp.local"
        echo -e "    Name: ${C}$mdns_name${N}"
    else
        warn "avahi-daemon not running  •  Android auto-discovery disabled"
    fi

    echo ""
    echo -e "  ${W}Configuration:${N}"
    sep
    echo -e "    Config file : ${D}$ENV_FILE${N}"
    echo -e "    Log file    : ${D}$LOG_FILE${N}"
    echo -e "    Data dir    : ${D}$SCRIPT_DIR/data/${N}"

    if [[ -f "$SCRIPT_DIR/data/apix.db" ]]; then
        local db_size; db_size=$(du -h "$SCRIPT_DIR/data/apix.db" 2>/dev/null | cut -f1)
        echo -e "    Database    : ${D}$SCRIPT_DIR/data/apix.db ($db_size)${N}"
    fi

    pause
}

# ── 6. View Logs ──────────────────────────────────────────────
action_logs() {
    header
    echo -e "  ${W}Server Logs${N}  ${D}(Ctrl+C to stop following)${N}"
    sep
    echo ""

    if [[ ! -f "$LOG_FILE" ]]; then
        warn "No log file found at $LOG_FILE"
        pause
        return
    fi

    echo -e "  ${D}──  Last 50 lines  ──────────────────────────────────${N}"
    tail -50 "$LOG_FILE"
    echo ""
    echo -e "  ${D}─────────────────────────────────────────────────────${N}"
    echo ""
    echo "  ${W}1${N}) Follow live (tail -f)"
    echo "  ${W}2${N}) Clear log file"
    echo "  ${W}3${N}) Back to menu"
    echo ""
    read -rp "  Choice [1-3]: " log_choice
    case "$log_choice" in
        1) echo ""; tail -f "$LOG_FILE" ;;
        2)
            echo "" > "$LOG_FILE"
            ok "Log file cleared."
            sleep 1
            ;;
    esac
}

# ── 7. Configure Server ───────────────────────────────────────
action_configure() {
    header
    echo -e "  ${W}Server Configuration${N}"
    sep
    echo ""

    local port; port=$(get_env PORT 3000)
    local host; host=$(get_env HOST 0.0.0.0)
    local mdns_name; mdns_name=$(get_env MDNS_NAME "ApiX Gateway")
    local auto_approve; auto_approve=$(get_env AUTO_APPROVE_DEVICES false)
    local log_level; log_level=$(get_env LOG_LEVEL info)

    echo -e "  Current settings:"
    echo -e "    ${D}1) Port             : ${W}$port${N}"
    echo -e "    ${D}2) Host/Interface   : ${W}$host${N}"
    echo -e "    ${D}3) mDNS Name        : ${W}$mdns_name${N}"
    echo -e "    ${D}4) Auto-approve     : ${W}$auto_approve${N}"
    echo -e "    ${D}5) Log level        : ${W}$log_level${N}"
    echo -e "    ${D}6) Regenerate secrets${N}"
    echo -e "    ${D}7) Back to menu${N}"
    echo ""
    read -rp "  Choose setting to change [1-7]: " cfg_choice

    case "$cfg_choice" in
        1)
            read -rp "  New port [$port]: " new_port
            [[ -n "$new_port" ]] && set_env PORT "$new_port" && ok "Port set to $new_port"
            ;;
        2)
            read -rp "  New host [$host]: " new_host
            [[ -n "$new_host" ]] && set_env HOST "$new_host" && ok "Host set to $new_host"
            ;;
        3)
            read -rp "  New mDNS name [$mdns_name]: " new_name
            [[ -n "$new_name" ]] && set_env MDNS_NAME "$new_name" && ok "mDNS name set to $new_name"
            ;;
        4)
            local new_approve
            read -rp "  Auto-approve devices? (true/false) [$auto_approve]: " new_approve
            [[ -n "$new_approve" ]] && set_env AUTO_APPROVE_DEVICES "$new_approve"
            ;;
        5)
            read -rp "  Log level (error/warn/info/debug) [$log_level]: " new_level
            [[ -n "$new_level" ]] && set_env LOG_LEVEL "$new_level"
            ;;
        6)
            set_env JWT_SECRET "$(openssl rand -hex 32 2>/dev/null || date | md5sum | head -c 64)"
            set_env HMAC_SECRET "$(openssl rand -hex 32 2>/dev/null || date | md5sum | head -c 64)"
            ok "Secrets regenerated"
            warn "All connected devices will need to re-authenticate."
            ;;
    esac

    if [[ "$cfg_choice" != "7" ]]; then
        if is_running; then
            warn "Server is running. Restart required for changes to take effect."
            read -rp "  Restart now? [y/N]: " do_restart
            [[ "${do_restart,,}" == "y" ]] && action_restart && return
        fi
        pause
    fi
}

# ── 8. Install systemd Service ────────────────────────────────
action_install_service() {
    header
    echo -e "  ${W}Install as systemd Service${N}"
    sep
    echo ""
    info "This will install ApiX Gateway as a systemd service so it starts automatically on boot."
    echo ""

    if [[ "$EUID" -ne 0 ]] && ! sudo -n true 2>/dev/null; then
        warn "This requires sudo privileges."
    fi

    local node_path; node_path=$(command -v node 2>/dev/null || echo "/usr/bin/node")
    local service_user; service_user=$(whoami)

    local service_content="[Unit]
Description=ApiX Gateway SMS/MMS Gateway Server
After=network.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$SCRIPT_DIR
ExecStart=$node_path $SCRIPT_DIR/src/index.js
Restart=always
RestartSec=5
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE
EnvironmentFile=$ENV_FILE

[Install]
WantedBy=multi-user.target
"

    echo "$service_content" | sudo tee /etc/systemd/system/apix-gateway.service > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable apix-gateway.service
    ok "systemd service installed and enabled"
    echo ""
    info "Commands:"
    echo -e "    ${W}sudo systemctl start apix-gateway${N}   — Start"
    echo -e "    ${W}sudo systemctl stop apix-gateway${N}    — Stop"
    echo -e "    ${W}sudo systemctl status apix-gateway${N}  — Status"
    echo -e "    ${W}journalctl -u apix-gateway -f${N}       — Live logs"
    pause
}

# ── 9. Uninstall ──────────────────────────────────────────────
action_uninstall() {
    header
    echo -e "  ${R}Uninstall ApiX Gateway${N}"
    sep
    echo ""
    warn "This will stop the server and remove all installed npm packages."
    warn "Your .env and database files will be kept."
    echo ""
    read -rp "  Continue? Type 'yes' to confirm: " confirm
    [[ "${confirm,,}" != "yes" ]] && { info "Cancelled."; pause; return; }

    # Stop server
    if is_running; then
        info "Stopping server..."
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        sleep 1
        rm -f "$PID_FILE"
    fi

    # Remove systemd service if exists
    if systemctl list-unit-files apix-gateway.service &>/dev/null; then
        info "Removing systemd service..."
        sudo systemctl disable apix-gateway.service 2>/dev/null || true
        sudo rm -f /etc/systemd/system/apix-gateway.service
        sudo systemctl daemon-reload
        ok "systemd service removed"
    fi

    # Remove node_modules
    if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
        info "Removing node_modules..."
        rm -rf "$SCRIPT_DIR/node_modules"
        ok "node_modules removed"
    fi

    ok "Uninstall complete."
    echo -e "  ${D}Config kept: $ENV_FILE${N}"
    echo -e "  ${D}Data kept  : $SCRIPT_DIR/data/${N}"
    pause
}

# ══════════════════════════════════════════════════════════════
#  MAIN MENU
# ══════════════════════════════════════════════════════════════
main_menu() {
    while true; do
        header

        local status_txt; status_txt=$(status_badge)
        local port; port=$(get_env PORT 3000)
        local ips; ips=$(get_ip_addresses | head -1)

        echo -e "  Status:  $status_txt   Port: ${C}$port${N}   IP: ${C}${ips:-not detected}${N}"
        echo ""
        sep
        echo ""
        echo -e "  ${W}1${N}  Install dependencies"
        echo -e "  ${W}2${N}  Start server"
        echo -e "  ${W}3${N}  Stop server"
        echo -e "  ${W}4${N}  Restart server"
        echo -e "  ${W}5${N}  Status & connection info"
        echo -e "  ${W}6${N}  View logs"
        echo -e "  ${W}7${N}  Configure"
        echo -e "  ${W}8${N}  Install as systemd service (auto-start on boot)"
        echo -e "  ${W}9${N}  Uninstall"
        echo -e "  ${W}0${N}  Exit"
        echo ""
        sep
        echo ""
        read -rp "  Choose an option [0-9]: " choice
        echo ""

        case "$choice" in
            1) action_install ;;
            2) action_start ;;
            3) action_stop ;;
            4) action_restart ;;
            5) action_status ;;
            6) action_logs ;;
            7) action_configure ;;
            8) action_install_service ;;
            9) action_uninstall ;;
            0) echo -e "  ${D}Goodbye.${N}"; echo ""; exit 0 ;;
            *) warn "Invalid option: $choice" ; sleep 1 ;;
        esac
    done
}

main_menu
