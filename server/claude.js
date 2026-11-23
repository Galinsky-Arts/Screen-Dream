// Claude calls for every writing, planning, QC and research agent.
// Same request shape as Instrument Omega's research engine: structured JSON output, adaptive
// thinking, server-side refusal fallback, pause_turn continuation, and a cost per call.
const Anthropic = require('@anthropic-ai/sdk');
const keys = require('./keys');

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
// USD per million tokens / per web search (Claude Opus 5.5 list prices).
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, search: 0.01 };
const TIMEOUT_MS = 15 * 60 * 1000;

let client = null;
let clientKey = null;
function getClient() {
  const key = keys.get('anthropic');
  if (!key) return null;
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key, timeout: TIMEOUT_MS, maxRetries: 2 }); clientKey = key; }
  return client;
}

function costOf(usage) {
  if (!usage) return 0;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return ((usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output
    + (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (usage.cache_read_input_tokens || 0) * PRICE.cacheRead) / 1e6
    + searches * PRICE.search;
}

const SYSTEM = `You are part of ScreenDream, an AI film studio that turns one concept into a finished film. You play the crew role named in each request (writer, critic, casting director, director, editor and so on) and you hand your work to the next role as structured JSON.

Ground rules for every role:
- Serve the producer's concept, constraints and tone exactly as given. Constraints are hard rules.
- Every character is fictional and original unless the producer is cast as themself. Never base a character's look, name or voice on a real, identifiable person, living or dead.
- Never borrow characters, names, settings, plots or distinctive designs from existing films, books, games or board games.
- Write for what current AI image and video models can render well: clear staging, limited simultaneous action, few characters per shot.
- Be concrete and specific. No placeholders, no "TBD".`;

// content: a string, or an array of content blocks (for images).
async function call({ role, user, schema, effort = 'high', searches = 0, maxTokens = 16000 }) {
  const c = getClient();
  if (!c) throw Object.assign(new Error('No Claude (Anthropic) API key. Add ANTHROPIC_API_KEY on Render or in Settings.'), { code: 'NO_KEY', service: 'anthropic' });
  const tools = searches > 0 ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: searches }] : undefined;
  const first = { role: 'user', content: `Your role: ${role}\n\n${typeof user === 'string' ? user : ''}` };
  if (Array.isArray(user)) first.content = [{ type: 'text', text: `Your role: ${role}` }, ...user];
  let messages = [first];
  let cost = 0;
  let final = null;
  for (let i = 0; i < 6; i++) {
    const params = {
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    if (tools) params.tools = tools;
    const r = await c.beta.messages.create(params);
    cost += costOf(r.usage);
    if (r.stop_reason === 'pause_turn') {
      messages = [first, { role: 'assistant', content: r.content }];
      continue;
    }
    final = r;
    break;
  }
  if (!final) throw Object.assign(new Error('Claude did not finish (too many continuations)'), { cost });
  if (final.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this step. Change the concept or constraints, or do this step manually.'), { cost });
  if (final.stop_reason === 'max_tokens') throw Object.assign(new Error('Claude ran out of output space on this step'), { cost });
  const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('Could not parse Claude\'s answer'), { cost }); }
  return { data, cost };
}

module.exports = { call, MODEL };
