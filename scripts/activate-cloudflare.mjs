import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function activate({env = process.env, fetcher = fetch, putSecret = null}) {
  const required = ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','GROQ_API_KEY'];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing GitHub Actions secret: ${key}`);
  const cf = async (route) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}${route}`, {
      headers: {Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`}
    });
    if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.success) throw new Error('Cloudflare request failed');
    return data.result;
  };
  const runner = putSecret || (async (name, value) => {
    if (!value?.trim()) throw new Error(`Refusing to upload an empty secret: ${name}`);
    const result = spawnSync('npx', ['wrangler','secret','put',name], {
      input: value + '\n', encoding: 'utf8', env, stdio: ['pipe','pipe','pipe']
    });
    // Do not print the child output, which might contain sensitive data.
    if (result.status !== 0) throw new Error(`Worker secret ${name} upload failed (exit ${result.status})`);
  });
  const webhookSecret = randomBytes(24).toString('hex');
  await runner('TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN);
  await runner('GROQ_API_KEY', env.GROQ_API_KEY);
  await runner('TELEGRAM_WEBHOOK_SECRET', webhookSecret);
  const result = await cf('/workers/subdomain');
  if (!/^[a-z\d-]+$/i.test(result?.subdomain || '')) throw new Error('Cloudflare Workers subdomain is missing');
  const url = `https://cherny-vestnik.${result.subdomain}.workers.dev`;
  const health = await fetcher(url + '/healthz');
  if (!health.ok) throw new Error(`Deployed Worker health check failed: HTTP ${health.status}`);
  const telegram = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({url:url+'/webhook',secret_token:webhookSecret,
      allowed_updates:['message'],drop_pending_updates:false,max_connections:3})
  });
  const reply = await telegram.json();
  if (!telegram.ok || reply.ok !== true) throw new Error('Telegram setWebhook request failed');
  return {url, webhookConfigured: true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  activate({}).then(result => console.log(`Bot deployed and webhook registered: ${result.url}`))
    .catch(error => {console.error(String(error.message)); process.exitCode = 1;});
}
