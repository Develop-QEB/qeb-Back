import 'dotenv/config';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const REGION = process.env.SPACES_REGION || 'sfo3';
const ENDPOINT = process.env.SPACES_ENDPOINT || `https://${REGION}.digitaloceanspaces.com`;
const ACCESS_KEY = process.env.SPACES_ACCESS_KEY || '';
const SECRET_KEY = process.env.SPACES_SECRET_KEY || '';

const BUCKETS = ['qeb-media-dev', 'qeb-media-main'];

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:3000',
  'https://app.qeb.mx',
  'https://front-qeb.vercel.app',
  'https://front-qeb-pi.vercel.app',
  'https://*.vercel.app',
];

const CORS_RULES = [
  {
    AllowedOrigins: ALLOWED_ORIGINS,
    AllowedMethods: ['GET', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['ETag', 'Content-Length', 'Content-Type'],
    MaxAgeSeconds: 3600,
  },
];

async function main() {
  if (!ACCESS_KEY || !SECRET_KEY) {
    console.error('Faltan SPACES_ACCESS_KEY / SPACES_SECRET_KEY en el .env');
    process.exit(1);
  }

  const client = new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: false,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });

  for (const bucket of BUCKETS) {
    console.log(`\n=== ${bucket} ===`);
    try {
      const put = new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: { CORSRules: CORS_RULES },
      });
      await client.send(put);
      console.log(`  ✓ CORS aplicado`);

      const get = new GetBucketCorsCommand({ Bucket: bucket });
      const result = await client.send(get);
      console.log(`  Reglas activas:`);
      result.CORSRules?.forEach((rule, i) => {
        console.log(`    [${i}] AllowedOrigins: ${(rule.AllowedOrigins || []).join(', ')}`);
        console.log(`        AllowedMethods: ${(rule.AllowedMethods || []).join(', ')}`);
      });
    } catch (e: any) {
      console.error(`  ✗ Error: ${e?.name || ''} ${e?.message || e}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
