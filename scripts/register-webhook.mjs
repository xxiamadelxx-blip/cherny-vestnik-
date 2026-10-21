const required = ['TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','WORKER_URL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
const {TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, WORKER_URL: base} = process.env;
const endpoint = `https://api.telegram.org/bot${token}/setWebhook`;
const response = await fetch(endpoint, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({url:`${base.replace(/\/$/,'')}/webhook`,secret_token:secret,
    allowed_updates:['message'],drop_pending_updates:false})
});
const data = await response.json();
if (!response.ok || !data.ok) {
  console.error(`Webhook registration failed: ${data.description || response.status}`);
  process.exit(1);
}
console.log('Webhook enabled on Worker URL. Token and secret are not printed.');
