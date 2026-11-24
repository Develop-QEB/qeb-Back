/**
 * Secretos de firma, con validación al arrancar.
 *
 * Antes cada archivo hacía `process.env.JWT_SECRET || 'default-secret-change-me'`.
 * Si la variable faltaba en un deploy, los tokens quedaban firmados con un
 * secreto que está en el repositorio: cualquiera podía forjarse un token con
 * rol DEV. Ahora el proceso no arranca sin el secreto, que es el modo correcto
 * de fallar: mejor un deploy que no sube que un deploy abierto.
 *
 * Variables requeridas en todos los ambientes (stage, release, demo, prod):
 *   JWT_SECRET            — firma de los access tokens
 *   JWT_REFRESH_SECRET    — firma de los refresh tokens (opcional: cae a JWT_SECRET)
 *   PUBLIC_SHARE_SECRET   — firma de las ligas públicas de propuesta (opcional: cae a JWT_SECRET)
 */

const PLACEHOLDERS = [
  'default-secret-change-me',
  'default-refresh-secret',
  'your-super-secret-jwt-key-change-this-in-production',
  'your-super-secret-refresh-key-change-this-in-production',
  'changeme',
  'secret',
];

function requerir(nombre: string, valor: string | undefined): string {
  if (!valor || valor.trim().length === 0) {
    throw new Error(
      `[Config] Falta la variable de entorno ${nombre}. El proceso no arranca sin ella: ` +
      `sin secreto de firma cualquiera podría emitir tokens válidos.`
    );
  }
  if (PLACEHOLDERS.includes(valor.trim().toLowerCase())) {
    throw new Error(
      `[Config] ${nombre} tiene un valor de ejemplo ("${valor}"). Genera uno real, por ejemplo con ` +
      `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))".`
    );
  }
  if (valor.trim().length < 32) {
    console.warn(
      `[Config] ${nombre} mide ${valor.trim().length} caracteres. Se recomiendan 48 o más.`
    );
  }
  return valor;
}

export const JWT_SECRET: string = requerir('JWT_SECRET', process.env.JWT_SECRET);

export const JWT_REFRESH_SECRET: string =
  process.env.JWT_REFRESH_SECRET && process.env.JWT_REFRESH_SECRET.trim().length > 0
    ? requerir('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET)
    : JWT_SECRET;

export const PUBLIC_SHARE_SECRET: string =
  process.env.PUBLIC_SHARE_SECRET && process.env.PUBLIC_SHARE_SECRET.trim().length > 0
    ? requerir('PUBLIC_SHARE_SECRET', process.env.PUBLIC_SHARE_SECRET)
    : JWT_SECRET;
