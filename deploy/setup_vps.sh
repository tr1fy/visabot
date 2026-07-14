#!/usr/bin/env bash
# One-time VPS setup for running VFS-Bot-v2 with the pydoll backend.
# Target: fresh Ubuntu 24.04 server (e.g. Hetzner CX22).
# Run as root: bash setup_vps.sh
set -euo pipefail

echo "== Updating system =="
apt-get update -y
apt-get upgrade -y

echo "== Installing desktop + VNC (for the one-time manual login) =="
apt-get install -y xfce4 xfce4-goodies tigervnc-standalone-server tigervnc-common

echo "== Installing Google Chrome (pydoll drives this via CDP) =="
apt-get install -y wget gnupg
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb
rm /tmp/chrome.deb

echo "== Installing Python, git =="
apt-get install -y python3 python3-venv python3-pip git

echo "== Creating vfsbot system user =="
id -u vfsbot &>/dev/null || useradd -m -s /bin/bash vfsbot

echo "== Configuring VNC for vfsbot user =="
echo "You'll be prompted for a VNC password (used only for the one-time manual login step)."
sudo -u vfsbot mkdir -p /home/vfsbot/.vnc
sudo -u vfsbot vncpasswd

cat > /home/vfsbot/.vnc/xstartup <<'EOF'
#!/bin/sh
startxfce4 &
EOF
chmod +x /home/vfsbot/.vnc/xstartup
chown vfsbot:vfsbot /home/vfsbot/.vnc/xstartup

echo ""
echo "== Done. Next steps =="
echo "1. As the vfsbot user: git clone your repo into /home/vfsbot/VFS-Bot-v2"
echo "2. cd /home/vfsbot/VFS-Bot-v2 && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
echo "3. Copy your real config.ini into place (never commit it -- scp it over directly)"
echo "4. Start VNC:  sudo -u vfsbot vncserver :1 -geometry 1280x800"
echo "5. From your Mac:  ssh -L 5901:localhost:5901 root@<server-ip>"
echo "6. Open Screen Sharing (macOS) -> vnc://localhost:5901, log into VFS manually via login_setup.py"
echo "7. Stop VNC when done:  sudo -u vfsbot vncserver -kill :1"
echo "8. Install the systemd service: see deploy/vfsbot.service"
