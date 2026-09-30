/**
 * Cloudflare R2 object storage for full session transcripts.
 *
 * R2 speaks the S3 API, so requests are SigV4-signed with aws4fetch rather than
 * pulling in the AWS SDK. The credentials live only in the server's .env: the
 * plugin uploads to this server, and this server writes to R2, so no Cloudflare
 * key ever reaches a developer machine.
 *
 * Unconfigured (any R2_* variable missing) is a normal state: `enabled` is
 * false and the transcript routes answer 503 so clients keep their copy.
 */

import { AwsClient } from 'aws4fetch';

export function makeStorage(env = process.env) {
  const accountId = env.R2_ACCOUNT_ID || '';
  const bucket = env.R2_BUCKET || '';
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';
  const enabled = Boolean(accountId && bucket && accessKeyId && secretAccessKey);

  // Overridable so tests can point at a local S3-compatible stand-in.
  const endpoint = (env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const client = enabled
    ? new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
    : null;

  const url = (key) => `${endpoint}/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

  async function check(res, what) {
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
    throw new Error(`R2 ${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  }

  return {
    enabled,
    bucket,

    async put(key, body, contentType = 'application/gzip') {
      if (!enabled) throw new Error('R2 is not configured');
      await check(await client.fetch(url(key), {
        method: 'PUT', body, headers: { 'content-type': contentType },
      }), 'upload');
    },

    /** Returns the fetch Response so the caller can stream it on. */
    async get(key) {
      if (!enabled) throw new Error('R2 is not configured');
      return check(await client.fetch(url(key), { method: 'GET' }), 'download');
    },

    async del(key) {
      if (!enabled) throw new Error('R2 is not configured');
      const res = await client.fetch(url(key), { method: 'DELETE' });
      // Deleting something already gone is success for retention purposes.
      if (res.status !== 404) await check(res, 'delete');
    },
  };
}
