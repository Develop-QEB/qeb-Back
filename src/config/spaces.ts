import { PutObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const getSpacesRegion = (): string => process.env.SPACES_REGION || 'sfo3';
const getSpacesEndpoint = (): string => process.env.SPACES_ENDPOINT || `https://${getSpacesRegion()}.digitaloceanspaces.com`;

const getSpacesBucket = (): string => process.env.SPACES_BUCKET || '';

const getSpacesPublicBaseUrl = (): string => {
  if (process.env.SPACES_PUBLIC_BASE_URL) {
    return process.env.SPACES_PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  const bucket = getSpacesBucket();
  const region = getSpacesRegion();
  return `https://${bucket}.${region}.digitaloceanspaces.com`;
};

const sanitizeFilename = (filename: string): string => {
  const base = filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  return base || 'file';
};

const encodeKeyForUrl = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

export function isSpacesConfigured(): boolean {
  return !!(
    process.env.SPACES_ACCESS_KEY &&
    process.env.SPACES_SECRET_KEY &&
    getSpacesBucket()
  );
}

let spacesClient: S3Client | null = null;

const getSpacesClient = (): S3Client => {
  if (spacesClient) return spacesClient;

  spacesClient = new S3Client({
    region: getSpacesRegion(),
    endpoint: getSpacesEndpoint(),
    forcePathStyle: false,
    credentials: {
      accessKeyId: process.env.SPACES_ACCESS_KEY || '',
      secretAccessKey: process.env.SPACES_SECRET_KEY || '',
    },
  });

  return spacesClient;
};

export { ListObjectsV2Command };

export function getClient(): S3Client {
  return getSpacesClient();
}

export function getBucket(): string {
  return getSpacesBucket();
}

export function getPublicBaseUrl(): string {
  return getSpacesPublicBaseUrl();
}

export interface UploadToSpacesResult {
  key: string;
  url: string;
}

export async function uploadBufferToSpaces(
  buffer: Buffer,
  options: {
    folder: string;
    originalName: string;
    mimeType: string;
  }
): Promise<UploadToSpacesResult> {
  if (!isSpacesConfigured()) {
    throw new Error('Spaces no estÃ¡ configurado');
  }

  const bucket = getSpacesBucket();
  const sanitized = sanitizeFilename(options.originalName);
  const random = Math.random().toString(36).slice(2, 10);
  const key = `${options.folder}/${Date.now()}-${random}-${sanitized}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: options.mimeType,
    ACL: 'public-read',
    CacheControl: 'public, max-age=31536000, immutable',
  });

  await getSpacesClient().send(command);

  return {
    key,
    url: `${getSpacesPublicBaseUrl()}/${encodeKeyForUrl(key)}`,
  };
}

