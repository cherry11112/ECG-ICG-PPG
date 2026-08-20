// Shared Cloudflare R2 (S3-compatible) client for storing patient documents.
//
// The existing Node-side R2 writer (saveToCloudflare in api/diagnostic/[...slug].js)
// signs requests with HTTP Basic auth, which R2's S3-compatible endpoint does not
// accept (it requires SigV4) — see backend/tools/r2.py for the working pattern this
// module mirrors, using the AWS SDK's SigV4 signing instead of hand-rolled auth.
//
// Env var names follow backend/config.py (the side that's actually configured and
// working today), since the Node-side names used elsewhere in this repo
// (R2_ACCESS_KEY / R2_SECRET_KEY) were never wired to a working client.
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_ENDPOINT_URL = process.env.R2_ENDPOINT_URL
  || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!R2_ENDPOINT_URL || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 is not configured (missing R2_ENDPOINT_URL/R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY)');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT_URL,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

function getBucket() {
  if (!R2_BUCKET_NAME) {
    throw new Error('R2_BUCKET_NAME is not configured');
  }
  return R2_BUCKET_NAME;
}

export async function putObject(key, body, contentType) {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { key };
}

export async function getPresignedGetUrl(key, expirySeconds = 300) {
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: key });
  return getSignedUrl(client, command, { expiresIn: expirySeconds });
}
