import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = 'cherny-vestnik';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function provisionD1({token, accountId, fetcher = fetch, configPath = 'wrangler.jsonc'}) {
  if (!token || !accountId) throw new Error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID');
  const root = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database`;
  const request = async (url, options = {}) => {
    const response = await fetcher(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    // Never include response body or credentials in logs.
    if (!response.ok) throw new Error(`Cloudflare D1 API HTTP ${response.status}`);
    const body = await response.json();
    if (body?.success !== true) throw new Error('Cloudflare D1 API rejected the request');
    return body.result;
  };
  const found = await request(root + `?name=${NAME}`);
  if (!Array.isArray(found)) throw new Error('Cloudflare D1 returned unexpected list');
  let database = found.find(item => item?.name === NAME);
  if (!database) {
    database = await request(root, { method: 'POST', body: JSON.stringify({name: NAME}) });
  }
  if (!UUID.test(database?.uuid || '')) throw new Error('Cloudflare D1 did not return a valid database UUID');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const binding = config.d1_databases?.find(item => item.binding === 'DB');
  if (!binding) throw new Error('Missing DB binding in Wrangler config');
  binding.database_id = database.uuid;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return {id: database.uuid, created: !found.some(item => item?.name === NAME)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  provisionD1({token: process.env.CLOUDFLARE_API_TOKEN, accountId: process.env.CLOUDFLARE_ACCOUNT_ID})
    .then(result => console.log(result.created ? 'D1 database created and configured.' : 'Existing D1 database configured.'))
    .catch(error => {console.error(String(error.message)); process.exitCode = 1;});
}
