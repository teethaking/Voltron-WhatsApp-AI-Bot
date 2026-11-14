const config = require('../config');

/**
 * Minimal LLM client with tool use. Supports Anthropic's Messages API and any
 * OpenAI-compatible chat completions API (OpenAI, Groq, OpenRouter, Gemini's compat endpoint...).
 */

const MEDIA_TOOLS = [
  {
    name: 'play_song',
    description: 'Find a song by name and send it to the chat as an audio message.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Song title and artist, e.g. "Burna Boy Last Last"' } },
      required: ['query'],
    },
  },
  {
    name: 'download_video',
    description: 'Download a video from a link (YouTube, TikTok, Instagram, Facebook, X, Reddit...) and send it to the chat.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full http(s) link' } },
      required: ['url'],
    },
  },
  {
    name: 'download_audio',
    description: 'Download only the audio of a link and send it to the chat as mp3.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full http(s) link' } },
      required: ['url'],
    },
  },
  {
    name: 'text_to_speech',
    description: 'Say some text out loud and send it as a voice note.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say (max ~600 characters)' },
        lang: { type: 'string', description: 'Optional language code like en, fr, es, pt-BR' },
      },
      required: ['text'],
    },
  },
];

const WHO_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Who to act on. Use "tagged" for people the owner @tagged, "replied" for the person whose message the owner replied to, or a full phone number (digits, with country code) that the owner actually typed.',
};

/** Only ever offered to the bot owner, and re-checked in code before running. */
const OWNER_TOOLS = [
  {
    name: 'kick_members',
    description: 'Remove people from the current group. Only when the owner clearly orders it, never when they are just asking or chatting.',
    input_schema: { type: 'object', properties: { who: WHO_SCHEMA }, required: ['who'] },
  },
  {
    name: 'temp_kick_members',
    description: 'Remove people from the group for a limited time, then add them back. Only when the owner clearly orders it.',
    input_schema: {
      type: 'object',
      properties: { who: WHO_SCHEMA, duration: { type: 'string', description: 'e.g. 30s, 10m, 2h, 1d (max 7 days)' } },
      required: ['who', 'duration'],
    },
  },
  {
    name: 'close_group',
    description: 'Close the group so only admins can send messages (mute it). Optional duration, after which it reopens by itself.',
    input_schema: {
      type: 'object',
      properties: { duration: { type: 'string', description: 'Optional, e.g. 30s, 10m, 2h' } },
    },
  },
  {
    name: 'open_group',
    description: 'Open the group so everyone can send messages. Optional duration, after which it closes again by itself.',
    input_schema: {
      type: 'object',
      properties: { duration: { type: 'string', description: 'Optional, e.g. 30s, 10m, 2h' } },
    },
  },
  {
    name: 'promote_members',
    description: 'Make people group admins. Only when the owner clearly orders it.',
    input_schema: { type: 'object', properties: { who: WHO_SCHEMA }, required: ['who'] },
  },
  {
    name: 'demote_members',
    description: 'Remove admin rights from people. Only when the owner clearly orders it.',
    input_schema: { type: 'object', properties: { who: WHO_SCHEMA }, required: ['who'] },
  },
];

const OWNER_TOOL_NAMES = new Set(OWNER_TOOLS.map((t) => t.name));

async function post(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || res.statusText;
    throw new Error(`AI request failed (${res.status}): ${String(msg).slice(0, 200)}`);
  }
  return data;
}

async function anthropicChat({ system, history, tools, runTool, shouldStop }) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  for (let round = 0; round < 4; round++) {
    const res = await post(
      `${config.aiBaseUrl}/v1/messages`,
      { 'x-api-key': config.aiKey, 'anthropic-version': '2023-06-01' },
      { model: config.aiModel, max_tokens: 700, system, messages, tools }
    );
    const blocks = res.content || [];
    const uses = blocks.filter((b) => b.type === 'tool_use');
    if (!uses.length) return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const u of uses) {
      results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(u.name, u.input || {}) });
    }
    messages.push({ role: 'user', content: results });
    if (shouldStop()) return null;
  }
  return '';
}

async function openaiChat({ system, history, tools, runTool, shouldStop }) {
  const messages = [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))];
  const toolDefs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  for (let round = 0; round < 4; round++) {
    const res = await post(
      `${config.aiBaseUrl}/chat/completions`,
      { authorization: `Bearer ${config.aiKey}` },
      { model: config.aiModel, max_tokens: 700, messages, tools: toolDefs }
    );
    const msg = res.choices?.[0]?.message || {};
    if (!msg.tool_calls?.length) return (msg.content || '').trim();

    messages.push(msg);
    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        /* model sent bad JSON, treat as empty input */
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: await runTool(tc.function.name, args) });
    }
    if (shouldStop()) return null;
  }
  return '';
}

/**
 * Run a conversation. `history` is [{role, content}] ending with the new user message.
 * `runTool(name, input)` must return a string result. If `shouldStop()` is true after a tool
 * round, the loop ends and null is returned (the caller already handled the reply).
 */
function chat(opts) {
  if (!config.aiKey) throw new Error('AI is not configured. Set AI_API_KEY in .env');
  const fn = config.aiProvider === 'openai' ? openaiChat : anthropicChat;
  // History must start with a user turn.
  const history = [...opts.history];
  while (history.length && history[0].role !== 'user') history.shift();
  return fn({ tools: MEDIA_TOOLS, ...opts, history });
}

module.exports = { chat, MEDIA_TOOLS, OWNER_TOOLS, OWNER_TOOL_NAMES };
