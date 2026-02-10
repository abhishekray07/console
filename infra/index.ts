import * as pulumi from "@pulumi/pulumi";
import * as hcloud from "@pulumi/hcloud";
import * as tls from "@pulumi/tls";

const config = new pulumi.Config();
const serverType = config.get("serverType") ?? "cx53";
const location = config.get("location") ?? "nbg1";
const tailscaleAuthKey = config.requireSecret("tailscaleAuthKey");
const githubToken = config.requireSecret("githubToken");

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
const userData = pulumi
    .all([tailscaleAuthKey, githubToken])
    .apply(([tsAuthKey, ghToken]) => {
        return `#!/bin/bash
set -e

export DEBIAN_FRONTEND=noninteractive

# --- System ---
apt-get update
apt-get install -y git build-essential tmux ufw

# --- Dedicated user ---
useradd -m -s /bin/bash claude-dev || true
mkdir -p /home/claude-dev/.claude-console

# --- Node.js 22 ---
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# --- Claude CLI ---
npm install -g @anthropic-ai/claude-code

# --- Tailscale ---
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey="${tsAuthKey}" --ssh || echo "WARNING: Tailscale setup failed. Run 'sudo tailscale up' manually."

# --- Docker ---
curl -fsSL https://get.docker.com | sh || echo "WARNING: Docker install failed."
usermod -aG docker claude-dev

# --- UFW (only allow Tailscale for app ports) ---
ufw default deny incoming
ufw allow in on tailscale0 to any port 3000
ufw allow in on tailscale0 to any port 22
ufw allow in on tailscale0 to any port 8080
ufw --force enable

# --- Git credentials for claude-dev ---
sudo -u claude-dev git config --global credential.helper store
echo "https://x-access-token:${ghToken}@github.com" > /home/claude-dev/.git-credentials
chown claude-dev:claude-dev /home/claude-dev/.git-credentials
chmod 600 /home/claude-dev/.git-credentials

# --- Claude Console ---
sudo -H -u claude-dev git clone https://github.com/abhishekray07/console.git /home/claude-dev/claude-console
cd /home/claude-dev/claude-console
sudo -H -u claude-dev npm install

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
Environment=HOST=0.0.0.0
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable claude-console
systemctl start claude-console

echo "Claude Console setup complete!"
`;
    });

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
