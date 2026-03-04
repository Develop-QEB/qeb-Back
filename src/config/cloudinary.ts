import { isSpacesConfigured, uploadBufferToSpaces } from './spaces';

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  resource_type: string;
  format: string;
  width?: number;
  height?: number;
}

const DEFAULT_IMAGE_MIME = 'image/jpeg';
const DEFAULT_VIDEO_MIME = 'video/mp4';

const extensionFromMime = (mimeType: string): string => {
  const lower = mimeType.toLowerCase();
  if (lower === 'image/jpeg') return 'jpg';
  if (lower === 'image/png') return 'png';
  if (lower === 'image/webp') return 'webp';
  if (lower === 'image/gif') return 'gif';
  if (lower === 'video/mp4') return 'mp4';
  if (lower === 'video/quicktime') return 'mov';
  if (lower === 'video/webm') return 'webm';
  return 'bin';
};

const parseBase64 = (
  value: string,
  resourceType: 'image' | 'video' | 'auto'
): { buffer: Buffer; mimeType: string } => {
  const trimmed = value.trim();
  const dataUriMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/s);

  if (dataUriMatch) {
    const mimeType = dataUriMatch[1];
    const payload = dataUriMatch[2].replace(/\s+/g, '');
    return { buffer: Buffer.from(payload, 'base64'), mimeType };
  }

  const fallbackMime = resourceType === 'video' ? DEFAULT_VIDEO_MIME : DEFAULT_IMAGE_MIME;
  const payload = trimmed.replace(/\s+/g, '');
  return { buffer: Buffer.from(payload, 'base64'), mimeType: fallbackMime };
};

// Compat wrapper: legacy name, now backed by Spaces.
export function isCloudinaryConfigured(): boolean {
  return isSpacesConfigured();
}

export async function uploadToCloudinary(
  base64Data: string,
  folder: string,
  resourceType: 'image' | 'video' | 'auto' = 'auto'
): Promise<CloudinaryUploadResult | null> {
  if (
    base64Data.startsWith('http://') ||
    base64Data.startsWith('https://') ||
    base64Data.startsWith('/uploads/')
  ) {
    return {
      secure_url: base64Data,
      public_id: '',
      resource_type: resourceType,
      format: '',
    };
  }

  if (!isCloudinaryConfigured()) {
    throw new Error('Spaces no esta configurado. No se permite guardar base64 en BD.');
  }

  const parsed = parseBase64(base64Data, resourceType);
  const extension = extensionFromMime(parsed.mimeType);
  const uploaded = await uploadBufferToSpaces(parsed.buffer, {
    folder,
    originalName: `archivo-${Date.now()}.${extension}`,
    mimeType: parsed.mimeType,
  });

  return {
    secure_url: uploaded.url,
    public_id: uploaded.key,
    resource_type: resourceType,
    format: extension,
  };
}

export async function deleteFromCloudinary(
  publicId: string,
  resourceType: 'image' | 'video' = 'image'
): Promise<boolean> {
  void publicId;
  void resourceType;
  return false;
}
