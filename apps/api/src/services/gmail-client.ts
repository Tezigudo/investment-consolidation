// Gmail API client with one-time OAuth bootstrap.
//
// Two ways to provide credentials:
//   1. File on disk (local dev): GMAIL_CREDENTIALS_PATH / GMAIL_TOKEN_PATH
//      (default `secrets/gmail-{credentials,token}.json`). Interactive
//      `--auth` writes the token here.
//   2. Env-var JSON (Fly / production): GMAIL_CREDENTIALS_JSON /
//      GMAIL_TOKEN_JSON. Either raw JSON or base64-encoded JSON. Used
//      when you can't ship the secrets/ folder into a deploy artifact.
//      Env vars take precedence over file paths. Read-only — the
//      interactive auth flow still writes to the file path on the
//      machine running `--auth` (typically your laptop).
//
// Scope: gmail.readonly. We only list/read messages + attachments.

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { config } from '../config.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

// Env paths in .env are typically relative (e.g. ./secrets/...); the
// CWD when bun workspaces run a script is the package dir, not the
// repo root. Always resolve against REPO_ROOT for relative values.
function resolveFromRepoRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

function credentialsPath(): string {
  const envPath = config.GMAIL_CREDENTIALS_PATH;
  return envPath ? resolveFromRepoRoot(envPath) : path.join(REPO_ROOT, 'secrets/gmail-credentials.json');
}

function tokenPath(): string {
  const envPath = config.GMAIL_TOKEN_PATH;
  return envPath ? resolveFromRepoRoot(envPath) : path.join(REPO_ROOT, 'secrets/gmail-token.json');
}

// Accepts raw JSON or base64-encoded JSON. Sniffs the first non-whitespace
// char: '{' or '[' means raw, anything else triggers base64 decode.
function parseInbandJson<T>(value: string, label: string): T {
  const trimmed = value.trim();
  const looksRaw = trimmed.startsWith('{') || trimmed.startsWith('[');
  const text = looksRaw ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${label}: failed to parse JSON (${(e as Error).message})`);
  }
}

interface InstalledCredentials {
  installed: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

function loadCredentials(): InstalledCredentials['installed'] {
  if (config.GMAIL_CREDENTIALS_JSON) {
    const raw = parseInbandJson<InstalledCredentials>(
      config.GMAIL_CREDENTIALS_JSON,
      'GMAIL_CREDENTIALS_JSON',
    );
    if (!raw.installed) {
      throw new Error('GMAIL_CREDENTIALS_JSON: expected an "installed" OAuth client wrapper');
    }
    return raw.installed;
  }
  const p = credentialsPath();
  if (!fs.existsSync(p)) {
    throw new Error(
      `Gmail credentials not found at ${p}. Set GMAIL_CREDENTIALS_JSON (Fly secret) or GMAIL_CREDENTIALS_PATH, or place the OAuth "installed" client JSON at secrets/gmail-credentials.json.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as InstalledCredentials;
  if (!raw.installed) {
    throw new Error(`Expected "installed" OAuth client credentials at ${p}`);
  }
  return raw.installed;
}

function loadCachedToken(): Record<string, unknown> | null {
  if (config.GMAIL_TOKEN_JSON) {
    try {
      return parseInbandJson<Record<string, unknown>>(
        config.GMAIL_TOKEN_JSON,
        'GMAIL_TOKEN_JSON',
      );
    } catch {
      return null;
    }
  }
  const p = tokenPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function saveToken(token: Record<string, unknown>): void {
  // Interactive auth runs locally — always write to the file path so the
  // operator can `cat` it later to set the Fly secret. We never try to
  // overwrite GMAIL_TOKEN_JSON in-place; that's an env var the deploy
  // pipeline owns.
  const p = tokenPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function runInteractiveAuth(creds: InstalledCredentials['installed']): Promise<OAuth2Client> {
  // Allocate a port first so the redirect_uri embedded in the auth URL
  // matches the one we later exchange against. Google allows any
  // loopback port when the registered redirect is bare http://localhost.
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));

  // Use `localhost` (not 127.0.0.1) in the redirect URI string so it
  // matches the registered `http://localhost` redirect literally — some
  // Google projects are strict on hostname even for desktop clients.
  // The HTTP server still binds to 127.0.0.1; browsers resolve
  // localhost → 127.0.0.1 so the callback hits us.
  const redirectUri = `http://localhost:${port}`;
  const oAuth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);
  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('Open this URL in your browser to authorize Gmail read access:');
  console.log(`\n  ${authUrl}\n`);
  console.log(`(Waiting for redirect back to ${redirectUri} …)`);
  console.log('──────────────────────────────────────────────────────────────\n');

  const { code } = await new Promise<{ code: string; port: number }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      const c = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`OAuth error: ${err}. You can close this tab.`);
        server.close();
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      if (!c) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Missing ?code. You can close this tab.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Gmail linked. You can close this tab and return to the terminal.');
      server.close();
      resolve({ code: c, port });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1');
  });

  const { tokens } = await oAuth2.getToken(code);
  oAuth2.setCredentials(tokens);
  saveToken(tokens as Record<string, unknown>);
  console.log(`[gmail] token saved to ${tokenPath()}\n`);
  return oAuth2;
}

export async function getGmailClient(opts: { interactive?: boolean } = {}): Promise<OAuth2Client> {
  const creds = loadCredentials();
  const cached = loadCachedToken();
  if (cached) {
    const oAuth2 = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      // Redirect URI not used once we have a refresh token.
      creds.redirect_uris[0] ?? 'http://127.0.0.1',
    );
    oAuth2.setCredentials(cached);
    return oAuth2;
  }
  if (opts.interactive === false) {
    throw new Error(
      `No Gmail token at ${tokenPath()}. Run \`bun run import:dime-mail -- --auth\` first.`,
    );
  }
  return runInteractiveAuth(creds);
}

export function gmail(auth: OAuth2Client) {
  return google.gmail({ version: 'v1', auth });
}

export function isGmailConfigured(): boolean {
  try {
    loadCredentials();
    return true;
  } catch {
    return false;
  }
}

export function isGmailAuthed(): boolean {
  return isGmailConfigured() && loadCachedToken() != null;
}
