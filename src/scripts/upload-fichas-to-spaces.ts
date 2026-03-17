/**
 * Script para subir la carpeta "Fichas tecnicas" a DigitalOcean Spaces.
 * Preserva la estructura de carpetas tal cual.
 *
 * Uso: npx ts-node src/scripts/upload-fichas-to-spaces.ts
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const FICHAS_LOCAL_PATH = path.resolve(__dirname, '../../../Fichas tecnicas');
const SPACES_PREFIX = 'fichas-tecnicas'; // prefix in the bucket

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
};

function getAllFiles(dirPath: string, basePath: string): { localPath: string; relativePath: string }[] {
  const results: { localPath: string; relativePath: string }[] = [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_FILES.has(entry.name)) continue;

    const fullPath = path.join(dirPath, entry.name);
    const relPath = path.relative(basePath, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath, basePath));
    } else if (entry.isFile()) {
      results.push({ localPath: fullPath, relativePath: relPath });
    }
  }

  return results;
}

async function main() {
  if (!fs.existsSync(FICHAS_LOCAL_PATH)) {
    console.error(`No se encontró la carpeta: ${FICHAS_LOCAL_PATH}`);
    process.exit(1);
  }

  const region = process.env.SPACES_REGION || 'sfo3';
  const endpoint = process.env.SPACES_ENDPOINT || `https://${region}.digitaloceanspaces.com`;
  const bucket = process.env.SPACES_BUCKET;
  const accessKey = process.env.SPACES_ACCESS_KEY;
  const secretKey = process.env.SPACES_SECRET_KEY;

  if (!bucket || !accessKey || !secretKey) {
    console.error('Faltan variables de entorno: SPACES_BUCKET, SPACES_ACCESS_KEY, SPACES_SECRET_KEY');
    process.exit(1);
  }

  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: false,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });

  const files = getAllFiles(FICHAS_LOCAL_PATH, FICHAS_LOCAL_PATH);
  console.log(`Encontrados ${files.length} archivos para subir.\n`);

  let uploaded = 0;
  let errors = 0;

  for (const file of files) {
    const key = `${SPACES_PREFIX}/${file.relativePath}`;
    const ext = path.extname(file.localPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const body = fs.readFileSync(file.localPath);

      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ACL: 'public-read',
        CacheControl: 'public, max-age=31536000, immutable',
      }));

      uploaded++;
      console.log(`[${uploaded}/${files.length}] ✓ ${key}`);
    } catch (err) {
      errors++;
      console.error(`[ERROR] ${key}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nCompletado: ${uploaded} subidos, ${errors} errores.`);
}

main();
