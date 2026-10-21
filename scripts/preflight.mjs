import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'TELEGRAM_BOT_TOKEN', 'GROQ_API_KEY'];
export const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

async function requestJson(fetcher, url, options, service) {
  const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${service}: HTTP ${response.status}`);
  let result;
  try { result = await response.json(); } catch { throw new Error(`${service}: invalid JSON`); }
  return result;
}

export async function preflight({ env = process.env, fetcher = fetch, log = console.log } = {}) {
  const model = env.GROQ_MODEL || DEFAULT_MODEL;
  const checks = [];
  const problems = [];
  let botUsername = null;

  async function probe(name, keys, fn) {
    const missing = keys.filter(key => !env[key]?.trim());
    if (missing.length) {
      const reason = `missing secrets: ${missing.join(', ')}`;
      log(`BLOCKED ${name}: ${reason}`);
      problems.push(`${name} (${reason})`);
      return;
    }
    try {
      await fn();
      checks.push(name);
      log(`PASS ${name}`);
    } catch (error) {
      // Only print safe fixed-service diagnostic text; response bodies never logged.
      const reason = String(error.message).slice(0, 150);
      log(`FAIL ${name}: ${reason}`);
      problems.push(`${name} (${reason})`);
    }
  }

  await probe('Telegram getMe', ['TELEGRAM_BOT_TOKEN'], async () => {
    const bot = await requestJson(fetcher,
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
      {method:'GET'}, 'Telegram getMe');
    if (!bot?.ok || !bot?.result?.id || !bot?.result?.username) {
      throw new Error('invalid bot token or response');
    }
    botUsername = bot.result.username;
  });

  await probe('Groq model and completion', ['GROQ_API_KEY'], async () => {
    const models = await requestJson(fetcher,
      'https://api.groq.com/openai/v1/models',
      {headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`}}, 'Groq models');
    if (!Array.isArray(models?.data) || !models.data.some(item => item.id === model)) {
      throw new Error(`model ${model} unavailable on this API key`);
    }
    const completion = await requestJson(fetcher,
      'https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`, 'Content-Type':'application/json'},
        body:JSON.stringify({model,messages:[{role:'user',content:'Напиши ровно одно слово: проверка'}],temperature:0,max_completion_tokens:40,reasoning_effort:'none'})
      }, 'Groq completion');
    if (!completion?.choices?.[0]?.message?.content?.trim()) {
      throw new Error('empty completion');
    }
  });

  const keys = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID || 'missing');
  const headers = {Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN || ''}`};
  await probe('Cloudflare D1', keys, async () => {
    const d1 = await requestJson(fetcher,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=1`,
      {headers}, 'Cloudflare D1');
    if (d1?.success !== true || !Array.isArray(d1.result)) throw new Error('invalid account or token permissions');
  });
  await probe('Cloudflare Workers subdomain', keys, async () => {
    const workers = await requestJson(fetcher,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {headers}, 'Cloudflare Workers');
    if (workers?.success !== true || !workers?.result?.subdomain) throw new Error('workers.dev subdomain not configured');
  });

  if (problems.length) {
    log(`PREFLIGHT INCOMPLETE: ${checks.length} passed, ${problems.length} blocked/failed. No deployments or Telegram sends performed.`);
    throw new Error(`Preflight incomplete: ${problems.join('; ')}`);
  }
  log('PREFLIGHT PASS: Telegram, Groq, and Cloudflare tested against live APIs. Not deployed. No Telegram group messages read or sent.');
  return {checks, botUsername};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  preflight().catch(error => {console.error(`PREFLIGHT FAIL: ${error.message}`); process.exitCode = 1;});
}
