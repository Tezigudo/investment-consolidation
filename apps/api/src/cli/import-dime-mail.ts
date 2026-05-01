// Usage:
//   bun run import:dime-mail -- --auth      # run OAuth flow, save token, exit
//   bun run import:dime-mail                # incremental import
//
// First run must include --auth so the loopback OAuth callback can
// capture the refresh token. After that, the HTTP route /import/dime/mail
// (triggered by the Sync DIME button in the web UI) works non-interactively.

import { importDimeMail, getLastDimeMailSyncTs } from '../services/dime-mail.js';
import { getGmailClient, isGmailAuthed } from '../services/gmail-client.js';

const argv = process.argv.slice(2);
const authOnly = argv.includes('--auth');

if (authOnly) {
  // Force interactive OAuth regardless of cached token. Useful to reset
  // the refresh token or if scopes changed.
  console.log('[import:dime-mail] starting OAuth flow…');
  await getGmailClient({ interactive: true });
  console.log('[import:dime-mail] auth complete. You can now run without --auth.');
  process.exit(0);
}

if (!isGmailAuthed()) {
  console.log('[import:dime-mail] no cached Gmail token — running OAuth first…');
}

const last = getLastDimeMailSyncTs();
const label = last
  ? ` (incremental, last sync: ${new Date(last).toISOString().slice(0, 19).replace('T', ' ')} UTC)`
  : ' (first run)';
console.log(`[import:dime-mail] starting${label}…`);

const start = Date.now();
const result = await importDimeMail({
  interactive: true,
  onProgress: (phase, detail) => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[+${elapsed}s] ${phase}${detail ? ` — ${detail}` : ''}`);
  },
});

console.log('\n=== DIME mail import complete ===');
const { counts, durationMs, debugDir } = result;
console.log(
  `  Deposits:      ${counts.deposits}\n` +
  `  Trades:        ${counts.trades}\n` +
  `  PDFs dumped:   ${counts.pdfsDumped}  (→ ${debugDir})\n` +
  `  Parse errors:  ${counts.parseErrors}\n` +
  `  PDF errors:    ${counts.pdfErrors}\n` +
  `  Mail errors:   ${counts.mailErrors}\n` +
  `  Duration:      ${(durationMs / 1000).toFixed(1)}s`,
);
