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
  // Fail before any requests if credentials have not been scoped to this repository.
  const missing = REQUIRED.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing repository or environment GitHub Secrets: ${missing.join(', ')}`);
  const model = env.GROQ_MODEL || DEFAULT_MODEL;
  const checks = [];

  const bot = await requestJson(fetcher,
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
    {method:'GET'}, 'Telegram getMe');
  if (!bot?.ok || !bot?.result?.id || !bot?.result?.username) throw new Error('Telegram getMe: invalid bot token or response');
  checks.push('Telegram bot token verified');

  const models = await requestJson(fetcher,
    'https://api.groq.com/openai/v1/models',
    {headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`}}, 'Groq models');
  if (!Array.isArray(models?.data) || !models.data.some(item => item.id === model)) {
    throw new Error(`Groq model ${model} unavailable on this API key`);
  }
  checks.push(`Groq model ${model} listed`);

  const completion = await requestJson(fetcher,
    'https://api.groq.com/openai/v1/chat/completions', {
      method:'POST',
      headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`, 'Content-Type':'application/json'},
      body:JSON.stringify({model,messages:[{role:'user',content:'Напиши ровно одно слово: проверка'}],temperature:0,max_completion_tokens:40,reasoning_effort:'none'})
    }, 'Groq completion');
  if (!completion?.choices?.[0]?.message?.content?.trim()) throw new Error('Groq completion: empty reply');
  checks.push('Real Groq completion received');

  const accountId = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const accountHeaders = {Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`};
  const d1 = await requestJson(fetcher,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=1`,
    {headers:accountHeaders}, 'Cloudflare D1');
  if (d1?.success !== true || !Array.isArray(d1.result)) throw new Error('Cloudflare D1: invalid account or token permissions');
  checks.push('Cloudflare D1 API accessible');

  const workers = await requestJson(fetcher,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    {headers:accountHeaders}, 'Cloudflare Workers subdomain');
  if (workers?.success !== true || !workers?.result?.subdomain) throw new Error('Cloudflare Workers subdomain not configured');
  checks.push('Cloudflare workers.dev subdomain configured');

  checks.forEach(check => log(`PASS ${check}`));
  log('PREFLIGHT PASS: Real API credentials and live Groq completion verified. Not deployed. No Telegram group messages read or sent.');
  return {checks, botUsername: bot.result.username};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  preflight().catch(error => {console.error(`PREFLIGHT FAIL: ${error.message}`); process.exitCode = 1;});
}
