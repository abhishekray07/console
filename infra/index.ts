import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as tls from "@pulumi/tls";

const config = new pulumi.Config("claude-console");
const serverType = config.get("serverType") ?? "cx53";
const location = config.get("location") ?? "fsn1";
const anthropicApiKey = config.requireSecret("anthropicApiKey");
const tailscaleAuthKey = config.requireSecret("tailscaleAuthKey");

// --- SSH Key ---
const sshKey = new tls.PrivateKey("claude-console-key", {
    algorithm: "ED25519",
});

const hcloudSshKey = new hcloud.SshKey("claude-console-ssh", {
    publicKey: sshKey.publicKeyOpenssh,
});

// --- Firewall ---
// Only allow SSH from public internet (for initial setup).
// Claude Console (3000) is only accessible via Tailscale.
const firewall = new hcloud.Firewall("claude-console-fw", {
    rules: [
        {
            direction: "in",
            protocol: "tcp",
            port: "22",
            sourceIps: ["0.0.0.0/0", "::/0"],
            description: "SSH access",
        },
    ],
});

// --- Cloud-Init User Data ---
// Installs all dependencies and starts Claude Console on first boot.
const userData = pulumi.interpolate`#!/bin/bash
set -euo pipefail

# --- System ---
apt-get update
apt-get install -y git build-essential tmux ufw

# --- Dedicated user ---
useradd -m -s /bin/bash claude-dev
mkdir -p /home/claude-dev/.claude-console

# --- Node.js 22 ---
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# --- Claude CLI ---
sudo -u claude-dev npm install -g @anthropic-ai/claude-code

# --- Tailscale ---
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey=${tailscaleAuthKey} --ssh

# --- Docker ---
apt-get install -y docker.io docker-compose-plugin
usermod -aG docker claude-dev

# --- UFW (only allow Tailscale for app ports) ---
ufw default deny incoming
ufw allow in on tailscale0 to any port 3000
ufw allow in on tailscale0 to any port 22
ufw allow in on tailscale0 to any port 8080
ufw --force enable

# --- Claude Console ---
sudo -u claude-dev git clone https://github.com/opslane/claude-console.git /home/claude-dev/claude-console
cd /home/claude-dev/claude-console
sudo -u claude-dev npm install

# --- Environment ---
mkdir -p /etc/claude-console
cat > /etc/claude-console/env <<'ENVEOF'
ANTHROPIC_API_KEY=${anthropicApiKey}
ENVEOF
chmod 600 /etc/claude-console/env
chown claude-dev:claude-dev /etc/claude-console/env

# --- systemd service ---
cat > /etc/systemd/system/claude-console.service <<'SVCEOF'
[Unit]
Description=Claude Console
After=network.target

[Service]
Type=simple
User=claude-dev
WorkingDirectory=/home/claude-dev/claude-console
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
EnvironmentFile=/etc/claude-console/env
Environment=HOST=0.0.0.0
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable claude-console
systemctl start claude-console
`;

// --- Server ---
const server = new hcloud.Server("claude-console", {
    serverType: serverType,
    location: location,
    image: "ubuntu-24.04",
    sshKeys: [hcloudSshKey.id],
    firewallIds: [firewall.id.apply((id) => Number(id))],
    userData: userData,
    labels: { purpose: "claude-console" },
});

// --- Outputs ---
export const ipv4Address = server.ipv4Address;
export const sshPrivateKey = sshKey.privateKeyOpenssh;
export const tailscaleCommand = pulumi.interpolate`tailscale status  # verify server appears on your tailnet`;
