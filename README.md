<h1 align="center">⚡ Voltron</h1>
<p align="center"><b>WhatsApp AI bot</b> · AI assistant · group guard · stickers · downloader · games</p>
<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="Baileys" src="https://img.shields.io/badge/baileys-6.x-25D366?logo=whatsapp&logoColor=white">
  <img alt="CI" src="https://github.com/teethaking/Voltron-WhatsApp-AI-Bot/actions/workflows/ci.yml/badge.svg">
</p>

WhatsApp AI bot by Tobe, built on Baileys. It has an AI assistant (Riri) that chats like a person and asks the owner before doing anything for other people, plus group management, stickers, video and audio downloads, text to speech, view-once saving, anti-delete, games, sudo users and sticker-bound commands.

## 🎧 Songs and downloads

| Command | What it does |
|---|---|
| `.play <song>` | Finds the song and sends a now-playing card plus the audio. Works with names (`.play calm down rema`), "artist - title", or a YouTube/SoundCloud link. Reply to a message with `.play` to search its text |
| `.playdoc <song>` | Same, but the mp3 comes as a file |
| `.yts <query>` | Top YouTube results with duration, views and links |
| `.lyrics <song>` | Full lyrics (lrclib.net) |
| `.dl <name or link>` · `.audio <name or link>` | Video or mp3 from a link, or from the top YouTube hit for a name |

Riri can also send songs and downloads on request. How `.play` finds a song: YouTube search, then download with yt-dlp (kept up to date automatically). If YouTube blocks the server, it falls back to SoundCloud so you still get the track. For the best results on servers add YouTube cookies (see below). Songs longer than `MAX_SONG_MINUTES` (default 20) are skipped.

## 🚀 Deploy

Needs **Node.js 20 or newer**. ffmpeg and yt-dlp are set up automatically on first start (system ffmpeg if present, otherwise the npm build; yt-dlp is downloaded into `./bin` and updated daily). No git, Python or build tools needed on the host.

### Get a session first

1. Run the bot once anywhere (panel, VPS, your PC) with `OWNER_NUMBER` and `USE_PAIRING_CODE=true`.
2. The console prints `Pairing code: XXXX-XXXX`. On your phone: WhatsApp > Settings > Linked devices > Link a device > **Link with phone number instead**, then type it.
3. Once linked, send `.exportsession` to the bot in your own chat. It replies with `VOLTRON:~...`. That is your `SESSION_ID`. Keep it secret, it is your WhatsApp login.

### Bot hosting panel (Pterodactyl, Katabump, Bot-Hosting.net ...)

Upload the project (or the zip), set the start command to `npm start` (or `node index.js`), fill in the variables from `.env.example`, start. Make sure the panel uses Node 20+.

### Heroku

Fork this repo, then create an app from it (the `app.json` and `heroku.yml` are included, it builds with Docker and installs ffmpeg). Set `SESSION_ID` and `OWNER_NUMBER`. The bot answers a health check on `PORT`, so a web dyno stays up.

### Docker / VPS

```bash
docker build -t voltron .
docker run -d --name voltron --restart unless-stopped \
  -e OWNER_NUMBER=2348012345678 -e SESSION_ID='VOLTRON:~...' \
  -v $PWD/session:/app/session -v $PWD/data:/app/data voltron
```

Without Docker: `npm install`, `cp .env.example .env`, edit it, `npm start` (use pm2 or systemd to keep it alive).

### Keep your login between restarts

`session/` is the WhatsApp login and `data/` holds sudo users, sticker commands, timers, cookies and the menu image. Keep both on hosts with a disk. On hosts without one (Heroku, Koyeb, Render) set `SESSION_ID` and the bot restores the login on every boot. If the host gives the app a `PORT`, a tiny health page is served there.

### Common deploy errors

| Error | Fix |
|---|---|
| `Node.js 18.x is too old` | Switch the panel/runtime to Node 20 or 22 |
| `npm ERR! git ... libsignal` | Already fixed: libsignal is vendored in `vendor/`. Upload that folder too |
| sharp / ffmpeg-static install errors | Both are optional now; the install succeeds and the bot uses ffmpeg instead |
| `Sign in to confirm you're not a bot` | Add YouTube cookies (below). `.play` still falls back to SoundCloud |
| `yt-dlp is not installed` | Wait a minute after the first start (it downloads in the background), or install yt-dlp and set `YTDLP_SKIP_DOWNLOAD=true` |
| Logged out / keeps asking to pair | Delete `session/`, link again and export a fresh `SESSION_ID` |

## Access

- **Owner**: the number in `OWNER_NUMBER`, plus the linked account itself.
- **Sudo**: people the owner adds. They can use the bot and the group tools, but not the owner-only commands below.
- **Mode**: `private` (default) means only the owner and sudo users get replies. `.mode public` opens it to everyone.

## Commands (prefix `.`)

**Media**
| Command | What it does |
|---|---|
| `.s` | Reply to an image/video/GIF to make a sticker. `.s crop`, `.s pack\|author` |
| `.toimg` | Reply to a sticker to get a PNG |
| `.dl <link>` | Download a video (YouTube, TikTok, Instagram, Facebook, X, Reddit...) |
| `.audio <link>` | Link to mp3 |
| `.play <song>` | Play any song (see Songs and downloads above) |
| `.vv` | Reply to a view-once to save it in the chat. `.vv me` sends it to your own DM |
| `.menu` | Styled menu. `.menu group` lists a category with descriptions, `.menu play` shows one command |
| `.tts hello` | Text to speech voice note. `.tts fr: bonjour` picks a language; reply to a message with `.tts` to read it out |

**Group** (group admins, sudo and owner; the bot must be admin)
| Command | What it does |
|---|---|
| `.kick @user` | Remove someone (reply, mention or number) |
| `.tempkick 10m @user` | Remove, then add back after the time (falls back to a DM invite link) |
| `.close` / `.mute` | Admins-only chat. `.close 30m` reopens automatically |
| `.open` / `.unmute` | Everyone can chat. `.open 5m` closes again afterwards |
| `.sort 14` | List members with no messages in 14 days |
| `.sort kick 14` | Owner only: remove them, 40 per run |

Times: `30s`, `10m`, `2h`, `1d`, `1h30m` (a bare number means minutes, max 7 days). Timers survive restarts.
Activity for `.sort` is tracked only while the bot is running in the group.

**Owner only**
| Command | What it does |
|---|---|
| `.addsudo` / `.delsudo` / `.sudolist` | Manage sudo users (reply, mention or number) |
| `.mode private\|public` | Who can use the bot |
| `.setcmd <command>` | Reply to a sticker to bind a command to it |
| `.delcmd` / `.listcmd` | Unbind a sticker / list bindings |
| `.setmenu` | Send or reply to an image (or pass a link) to show it on `.menu`. `.setmenu reset` removes it |
| `.antidelete on\|off` | Send messages people delete (text, photos, videos, voice notes, stickers, files up to 20MB) to your DM |
| `.antiedit on\|off` | Send the before and after of edited messages to your DM |
| `.setcookies` / `.delcookies` | Save or delete a YouTube cookies.txt (send the file with `.setcookies` as the caption) |

### Anti-delete and anti-edit

Both are off by default and work in every chat the bot's account is in, groups and private. Reports go to your DM with who sent it, which chat, when, and who deleted it if that was someone else (a group admin). WhatsApp keeps no copy of deleted or old messages, so the bot remembers what it sees while the feature is on. That means:

- It can only recover messages that arrived after you switched it on, and while the bot was running.
- Text is kept in memory for up to 24 hours, media (under 20MB, the latest 100 files) in `tmp/anti`. Everything is wiped when the bot restarts.
- View-once media is never kept by this feature, and your own messages are ignored.
- Set `TIMEZONE` in `.env` (default `Africa/Lagos`) for the times shown.

### YouTube cookies (fixes "Sign in to confirm you're not a bot")

Hosting servers are often flagged by YouTube. Give yt-dlp a cookies file and it works again. Either:

- send your `cookies.txt` (Netscape format) to the bot with the caption `.setcookies`, then delete the file from the chat, or
- upload it to the project folder as `cookies.txt` (or `data/cookies.txt`) in the panel's File Manager.

It is picked up on the next download, no restart needed. Export it from a private/incognito window with a "cookies.txt" browser extension, and use a spare Google account if you can: it is a login, and YouTube can flag accounts used this way. Cookies expire after a while, so redo it if the error comes back.

### Sticker commands

Reply to a sticker with `.setcmd vv me`. From then on, whenever you (or a sudo user) send that sticker as a reply to a view-once photo or video, the bot runs `.vv me` and drops it in your personal DM. Works with any command, for example `.setcmd kick` or `.setcmd close 10m`.


## More features

**Emoji save.** React to any photo, video, voice note, view-once or status with 😍 🔥 💾 📥 👍 (only you and sudo users count) and the file arrives in your DM. `.reactsave on|off` switches it, `.setreact 😍 🔥` changes the emojis. The bot has to have seen the message while running (it remembers about 12 hours).

**Group management** (admins, sudo, owner; the bot must be admin where it deletes or removes)
| Command | What it does |
|---|---|
| `.promote` / `.demote @user` | Give or remove admin |
| `.add 234801...` | Add a number |
| `.tagall [text]` · `.hidetag text` · `.tagadmins` | Mention everyone / silently / admins |
| `.link` · `.resetlink` | Invite link / reset it |
| `.gname` · `.gdesc` · `.setgpp` | Group name, description, picture (reply to a photo) |
| `.welcome on\|off\|<text>` · `.goodbye ...` | Greetings. Use `@user`, `{group}`, `{count}` |
| `.antilink off\|delete\|warn\|kick` · `.antilink all` | Delete WhatsApp group links (or every link with `all`) from non-admins |
| `.antiword add\|del\|list\|off` | Banned words, deleted + warning |
| `.warn @user reason` · `.warnings` · `.resetwarn` | Warning system, removed at `WARN_LIMIT` (default 3) |
| `.filter word => reply` · `.stop word` · `.filters` | Auto-replies |
| `.poll Question \| a \| b` | Create a poll |

**Tools** (owner and sudo; `.mode public` opens them to everyone)
`.alive` `.runtime` `.calc` `.weather city` `.wiki` `.define` `.tr fr text` `.short` `.qr` `.ss url` `.github user` `.price btc` `.quote` `.joke` `.fact` `.dice` `.flip` `.pick a, b` `.password` `.time zone` `.fancy` `.base64` `.getpp` `.jid`
Owner only: `.setpp` `.setbio` `.block` `.unblock` `.afk reason` `.exportsession`

**Media:** `.tomp3` (video to mp3), `.voice`, `.bass` `.fast` `.slow` `.nightcore` `.reverse` `.echo` (audio effects, reply to audio), `.tovideo` (animated sticker to video), `.take Pack | Author` (re-pack a sticker). The weather, wiki, translate, price, quote, joke, fact, qr, ss and short commands use free public web APIs, so they need the host to allow outbound internet.

## Games 🎮

Anyone in the chat can play, even in private mode. One game runs per chat, any number of players.

| Command | Game |
|---|---|
| `.wcg` | Word Chain: say a word starting with the last letter of the previous one. 60s lobby (`.join`), host starts early with `.wcg go`. Timeouts eliminate you, last player wins |
| `.wordle [4-7]` | Word Guess: everyone shares one hidden word and the 🟩🟨⬛ board |
| `.hangman` | Guess letters (or the whole word) together |
| `.scramble [rounds]` | Race to unscramble words |
| `.trivia [rounds] [easy/medium/hard]` | Multiple choice quiz (online questions, built-in fallback) |
| `.games` · `.lb` · `.endgame` | List, per-chat leaderboard, stop (host / group admin / owner) |

## View-once note

The bot now also answers WhatsApp's delivery retries (this was a common cause of "Waiting for this message"). `.vv` and auto-save now re-send the file WhatsApp already holds instead of re-uploading it, and fall back to a re-upload if that fails. If "Waiting for this message" still appears, open the bot's own chat on your phone once, then run `.vv me` again; if it persists, delete `session/` and relink.

## AI assistant (Riri)

Turn it on per chat with `.ai on` (owner or sudo). Then, in that chat:

- In groups, people say `riri ...`, tag the bot, or reply to one of its messages. In private chats it answers every message.
- It chats like a person and keeps a short memory of the conversation (`.ai clear` resets it). `.ask <question>` works even when it is off.
- It can send a song, download a video or audio from a link, and send a voice note. Example: "riri download this song burna boy last last".

**Permission flow.** The owner and sudo users get what they ask for straight away. For anyone else, Riri says it needs the owner's permission and DMs you a request with a number:

| Command | What it does |
|---|---|
| `.allow` | Reply to Riri's permission message in the chat (or tag the person) to approve and run it |
| `.allow #3` | Approve request 3 from anywhere, for example from your DM |
| `.allow #3 1h` | Approve it and let that person use Riri's actions freely in that chat for 1 hour |
| `.deny #3` | Decline |
| `.revoke @user` / `.revoke all` | Take back timed permissions in this chat |
| `.aiperms` | Show pending requests and timed permissions |

Requests expire after 30 minutes. Permission is decided in code from who sent the message, never from what the message says.

**Group control (owner only).** When the message comes from the owner (your own number, the one the bot runs on, or `OWNER_NUMBER`), Riri also gets group tools in groups where it is an admin: remove people, remove them temporarily, close or open the group (with a timer), and make or remove admins. For example: "riri kick him" (tag or reply), "riri tempkick +234... for 1h", "riri close the group for 10 minutes", "riri make her admin".

- Other people, including sudo users and anyone you gave a timed `.allow`, never get these tools. They are not even shown to the model for them, and the code refuses them again if it is asked anyway.
- Targets are only taken from people you tagged, the person you replied to, or numbers you typed yourself. A number from someone else's message or one the AI makes up is ignored.
- It acts only on clear orders, asks who you mean if unsure, removes at most 10 people at once, and never removes itself or you.

Everything else Riri can do for other people stays limited to the four media actions above.

Setup: put a key in `.env` (`AI_API_KEY`). The default is Anthropic (`AI_PROVIDER=anthropic`, Haiku model). For OpenAI, Groq, OpenRouter or Gemini set `AI_PROVIDER=openai` plus `AI_BASE_URL` and `AI_MODEL`. Each AI reply costs API credits, so enable it only in chats where you want it.

## Adding a command

Create `plugins/hello.js`:

```js
module.exports = {
  commands: [{
    name: 'hello',
    aliases: ['hi'],
    cat: 'Fun',          // menu category
    owner: false,        // true = owner only
    desc: 'Say hello',
    async run(ctx) { await ctx.reply('Hello ' + ctx.sender.split('@')[0]); },
  }],
};
```

`ctx` has `sock`, `msg`, `jid`, `args`, `text`, `quoted`, `isOwner`, `isSudo`, `isGroup`, `reply()`.

## Notes

- Run it on a number you can afford to risk. Unofficial WhatsApp clients can get a number banned.
- View-once saving only works for messages your linked account receives. Use it on content people sent to you and respect their privacy.
- Newer WhatsApp accounts may appear as `@lid` ids in groups. Owner detection also works through the linked account itself, so if a sudo user is not recognised in a group, run `.addsudo` by replying to one of their messages in that group.
