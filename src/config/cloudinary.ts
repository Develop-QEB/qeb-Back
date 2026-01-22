import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary with environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  resource_type: string;
  format: string;
  width?: number;
  height?: number;
}

/**
 * Sube un archivo base64 a Cloudinary
 * @param base64Data - Datos en formato base64 (con o sin prefijo data:)
 * @param folder - Carpeta en Cloudinary donde guardar el archivo
 * @param resourceType - Tipo de recurso: 'image' | 'video' | 'auto'
 */
export async function uploadToCloudinary(
  base64Data: string,
  folder: string,
  resourceType: 'image' | 'video' | 'auto' = 'auto'
): Promise<CloudinaryUploadResult> {
  // Asegurar que el base64 tenga el prefijo correcto
  let uploadData = base64Data;
  if (!base64Data.startsWith('data:')) {
    // Si no tiene prefijo, intentar detectar el tipo
    uploadData = `data:application/octet-stream;base64,${base64Data}`;
  }

  const result = await cloudinary.uploader.upload(uploadData, {
    folder,
    resource_type: resourceType,
    // Para videos, permitir archivos grandes
    chunk_size: 6000000, // 6MB chunks para videos grandes
  });

  return {
    secure_url: result.secure_url,
    public_id: result.public_id,
    resource_type: result.resource_type,
    format: result.format,
    width: result.width,
    height: result.height,
  };
}

/**
 * Elimina un archivo de Cloudinary por su public_id
 */
export async function deleteFromCloudinary(
  publicId: string,
  resourceType: 'image' | 'video' = 'image'
): Promise<boolean> {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
    return result.result === 'ok';
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    return false;
  }
}

export default cloudinary;
