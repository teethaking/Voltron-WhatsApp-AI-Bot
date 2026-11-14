require('dotenv').config();

const digits = (s) => (s || '').replace(/\D/g, '');

const botName = process.env.BOT_NAME || 'Voltron';
const ownerName = process.env.OWNER_NAME || 'Tobe';

const aiProvider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase() === 'openai' ? 'openai' : 'anthropic';

module.exports = {
  botName,
  ownerName,
  prefix: process.env.PREFIX || '.',
  ownerNumber: digits(process.env.OWNER_NUMBER),
  // private: only the owner and sudo users can use the bot. public: everyone.
  mode: (process.env.MODE || 'private').toLowerCase() === 'public' ? 'public' : 'private',
  usePairingCode: process.env.USE_PAIRING_CODE === 'true',
  stickerPack: process.env.STICKER_PACK || botName,
  stickerAuthor: process.env.STICKER_AUTHOR || ownerName,
  autoSaveViewOnce: process.env.AUTO_SAVE_VIEWONCE === 'true',
  maxMb: Number(process.env.MAX_MB) || 60,
  maxSongMinutes: Number(process.env.MAX_SONG_MINUTES) || 20,
  ttsLang: process.env.TTS_LANG || 'en',
  timezone: process.env.TIMEZONE || 'Africa/Lagos',
  warnLimit: Math.max(1, Number(process.env.WARN_LIMIT) || 3),
  startupMessage: process.env.STARTUP_MESSAGE !== 'false',
  // DM the owner when a new commit is pushed to the bot's GitHub repo
  updateNotify: process.env.UPDATE_NOTIFY !== 'false',
  updateRepo: process.env.UPDATE_REPO || 'teethaking/Voltron-WhatsApp-AI-Bot',
  updateBranch: process.env.UPDATE_BRANCH || 'main',

  // AI assistant
  aiName: process.env.AI_NAME || 'Riri',
  aiProvider, // "anthropic" or "openai" (any OpenAI-compatible API: OpenAI, Groq, OpenRouter, Gemini...)
  aiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || (aiProvider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001'),
  aiBaseUrl: (process.env.AI_BASE_URL || (aiProvider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com')).replace(/\/+$/, ''),
};
