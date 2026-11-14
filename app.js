const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error(`Node.js ${process.versions.node} is too old. This bot needs Node 20 or newer (set it in your host's settings).`);
  process.exit(1);
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  generateMessageIDV2,
  proto,
} = require('@whiskeysockets/baileys');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sent = require('./lib/sent');
const msgcache = require('./lib/msgcache');
const vocache = require('./lib/vocache');
const { isViewOnce } = require('./lib/utils');
const updates = require('./lib/updates');
const store = require('./lib/store');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const { loadPlugins, handle, handleGroupParticipants, handleReaction } = require('./lib/handler');
const scheduler = require('./lib/scheduler');
const { ensureBinaries } = require('./lib/bootstrap');
const { remote } = require('./lib/remote');

loadPlugins();

let announced = false;
let decryptFails = 0;
const groupCache = new Map(); // jid -> metadata (cuts down on rate-limited metadata fetches)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** DM the owner a message, then edit it into the "ready" message. */
async function announce(sock) {
  const me = (sock.user?.id || '').split('@')[0].split(':')[0];
  const jid = `${config.ownerNumber || me}@s.whatsapp.net`;
  const first = await sock.sendMessage(jid, { text: `hello its ${config.ownerName.toLowerCase()}\u{1F44B}\u{1F3FF}..` });
  await sleep(2000);
  await sock.sendMessage(jid, { text: `${config.botName.toLowerCase()} is ready..\u{1FAC0}`, edit: first.key });
}

/** Hosts with no persistent disk: restore the login from SESSION_ID (see .exportsession). */
function restoreSession() {
  const id = (process.env.SESSION_ID || '').trim();
  const file = path.join('session', 'creds.json');
  if (!id || fs.existsSync(file)) return;
  try {
    // accepts "VOLTRON:~<base64>", the old "volt:<base64>", or bare base64
    const json = Buffer.from(id.replace(/^[\w-]+:~?/, ''), 'base64').toString('utf8');
    JSON.parse(json);
    fs.mkdirSync('session', { recursive: true });
    fs.writeFileSync(file, json);
    console.log('Session restored from SESSION_ID.');
  } catch {
    console.error('SESSION_ID is not valid, ignoring it.');
  }
}

/** Tiny web server so "web service" hosts (Render, Koyeb, Heroku...) see the app as healthy. */
function healthServer() {
  const port = Number(process.env.PORT);
  if (!port) return;
  http
    .createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${config.botName} is running\n`);
    })
    .on('error', (e) => console.error('health server:', e.message))
    .listen(port, () => console.log(`Health server on :${port}`));
}

let current = null; // the live socket
let reconnectDelay = 2000;

async function start() {
  if (current) {
    // drop the old socket completely so listeners never double up
    try {
      current.ev.removeAllListeners();
      current.end(undefined);
    } catch {
      /* already closed */
    }
  }
  const { state, saveCreds } = await useMultiFileAuthState('./session');
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    // Answer retry requests, otherwise recipients can get stuck on "Waiting for this message".
    getMessage: async (key) => msgcache.get(key.remoteJid, key.id)?.message || msgcache.find(key.id)?.message || undefined,
    cachedGroupMetadata: async (jid) => groupCache.get(jid),
  });
  current = sock;

  // Tag every outgoing message with an id we remember, so the bot never reacts to itself.
  const rawSend = sock.sendMessage.bind(sock);
  // "SessionError: No sessions" means WhatsApp has no encryption keys for someone we are sending to
  // (stale session files, new device, LID/number mismatch). Fetch fresh keys and retry once.
  async function refreshSessions(jid) {
    let targets = [jid];
    if (jid.endsWith('@g.us')) {
      const meta = await sock.groupMetadata(jid);
      targets = meta.participants.map((p) => p.id);
    }
    await sock.assertSessions(targets, true);
  }

  sock.sendMessage = async (jid, content, opts = {}) => {
    const id = opts.messageId || generateMessageIDV2(sock.user?.id);
    sent.add(id);
    const o = { ...opts, messageId: id };
    let res;
    try {
      res = await rawSend(jid, content, o);
    } catch (e) {
      if (!/No sessions?|SessionError/i.test(String(e?.message || e))) throw e;
      console.error(`No encryption session for ${jid}, refreshing keys and retrying...`);
      await refreshSessions(jid);
      res = await rawSend(jid, content, o);
    }
    if (res?.message) msgcache.set(res); // so retries of our own messages can be answered
    return res;
  };

  // relayMessage is used directly for server-side copies; remember those too so their retries can be answered
  const rawRelay = sock.relayMessage.bind(sock);
  sock.relayMessage = async (jid, message, opts = {}) => {
    if (opts.messageId) msgcache.set({ key: { remoteJid: jid, id: opts.messageId, fromMe: true }, message });
    return rawRelay(jid, message, opts);
  };

  // keep group info cached, refreshed whenever a group changes
  const origMeta = sock.groupMetadata.bind(sock);
  sock.groupMetadata = async (jid) => {
    const hit = groupCache.get(jid);
    if (hit && Date.now() - (hit._at || 0) < 5 * 60 * 1000) return hit;
    const meta = await origMeta(jid);
    meta._at = Date.now();
    groupCache.set(jid, meta);
    return meta;
  };
  sock.ev.on('groups.update', (list) => list.forEach((g) => g.id && groupCache.delete(g.id)));
  sock.ev.on('group-participants.update', (ev) => {
    groupCache.delete(ev.id);
    handleGroupParticipants(sock, ev).catch((e) => console.error('group event error:', e.message));
  });

  sock.ev.on('creds.update', saveCreds);

  // Pairing code login (instead of QR)
  if (config.usePairingCode && !sock.authState.creds.registered) {
    if (!config.ownerNumber) {
      console.error('Set OWNER_NUMBER in .env to use a pairing code.');
      process.exit(1);
    }
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(config.ownerNumber);
        console.log(`\nPairing code: ${code}\nWhatsApp > Linked devices > Link with phone number\n`);
      } catch (e) {
        console.error('Could not get pairing code:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !config.usePairingCode) qrcode.generate(qr, { small: true });

    if (connection === 'open') {
      console.log(`${config.botName} connected to WhatsApp.`);
      scheduler.setSocket(sock); // re-arms saved close/open/temp-kick timers
      updates.start(sock); // DMs the owner when new commits land on GitHub
      if (config.startupMessage && !announced) {
        announced = true; // once per process, not on every reconnect
        announce(sock).catch((e) => console.error('startup message failed:', e.message));
      }
    }

    if (connection === 'open') reconnectDelay = 2000;

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out (or the link was removed on the phone). Delete the ./session folder and start again.');
        fs.rmSync('session', { recursive: true, force: true });
        remote.wipeSession().catch(() => {}).finally(() => process.exit(0));
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        console.log('Another instance of this bot is using the same login. Stop the other one. Retrying in 30s...');
        reconnectDelay = 30000;
      }
      console.log(`Connection closed (${code}), reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
      setTimeout(boot, reconnectDelay);
      if (code !== DisconnectReason.restartRequired) reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      msgcache.set(msg); // remember it (retries, emoji-save, statuses)
      if (type === 'notify' && !msg.key.fromMe && isViewOnce(msg.message)) {
        // grab the file now: WhatsApp deletes it from its servers once the phone opens it
        vocache.save(msg).then((ok) => ok && console.log(`view-once saved from ${msg.key.participant || msg.key.remoteJid}`)).catch((e) => console.error('view-once pre-download failed:', e.message));
      }
      if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && !msg.key.fromMe) {
        // WhatsApp shows "Waiting for this message" on the sender's phone until the retry below succeeds
        decryptFails++;
        console.warn(`Could not decrypt a message from ${msg.key.participant || msg.key.remoteJid} (${msg.messageStubParameters?.[0] || 'unknown'}); asked them to resend.`);
        if (decryptFails === 8) {
          console.warn('Many messages fail to decrypt. This usually means two copies of the bot share one login, or an old SESSION_ID / session folder. Keep ONE running copy, delete ./session (and unset SESSION_ID), and link again.');
        }
        continue;
      }
      // Messages you send from your own phone can arrive as "append"; accept only fresh ones
      // so sticker commands work from your own account without replaying old history.
      if (type !== 'notify') {
        const age = Date.now() / 1000 - Number(msg.messageTimestamp || 0);
        if (!(type === 'append' && msg.key.fromMe && age < 30)) continue;
      }
      const reaction = msg.message?.reactionMessage;
      if (reaction) {
        handleReaction(sock, msg, reaction).catch((e) => console.error('reaction error:', e.message));
        continue;
      }
      handle(sock, msg).catch((e) => console.error('handler error:', e));
    }
  });
}

restoreSession();
healthServer();
ensureBinaries();

function boot() {
  start().catch((e) => {
    console.error('Startup failed, retrying in 10s:', e.message);
    setTimeout(boot, 10_000);
  });
}
boot();

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.saveNow();
    msgcache.flush();
    Promise.race([remote.flush(), sleep(4000)]).finally(() => process.exit(0));
  });
}
