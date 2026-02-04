// store.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, 'sessions.json');

export function loadSessions() {
  try {
    const data = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('Failed to load sessions.json (starting fresh):', e.message);
    }
    return [];
  }
}

export function saveSessions(sessions) {
  const tmp = STORE_PATH + '.tmp.' + crypto.randomUUID().slice(0, 8);
  try {
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.error('Failed to save sessions:', e.message);
  }
}
