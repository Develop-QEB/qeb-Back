import crypto from 'crypto';
import { PUBLIC_SHARE_SECRET } from './secrets';

/**
 * Firma de las ligas públicas de propuesta (la vista que se manda al cliente).
 *
 * Antes la liga era `/cliente/propuesta/123` y el endpoint público aceptaba el
 * id tal cual. Como el id es un entero consecutivo, cualquiera podía recorrer
 * desde 1 y leer cliente, CUIC, asesor, precio de la cotización e inventario
 * con coordenadas de TODAS las propuestas. Ahora la liga lleva un token
 * firmado y con caducidad, atado a esa propuesta.
 *
 * Formato del token: `<expMs>.<hmac>` — `expMs` es la caducidad en epoch ms
 * (0 = sin caducidad) y `hmac` son los primeros 32 hex de
 * HMAC-SHA256(secreto, `${propuestaId}.${expMs}`).
 *
 * Es sin estado a propósito: no requiere columna nueva ni migración, y
 * rotar PUBLIC_SHARE_SECRET invalida de golpe todas las ligas emitidas.
 */

/** Vigencia por omisión de una liga nueva. */
export const SHARE_DIAS_POR_OMISION = 90;

function firma(propuestaId: number, expMs: number): string {
  return crypto
    .createHmac('sha256', PUBLIC_SHARE_SECRET)
    .update(`${propuestaId}.${expMs}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Emite un token para la propuesta. `dias = 0` genera una liga sin caducidad
 * (úsalo solo si el cliente necesita consultarla indefinidamente).
 */
export function firmarShareToken(
  propuestaId: number,
  dias: number = SHARE_DIAS_POR_OMISION
): { token: string; expiraMs: number } {
  const expMs = dias > 0 ? Date.now() + dias * 24 * 60 * 60 * 1000 : 0;
  return { token: `${expMs}.${firma(propuestaId, expMs)}`, expiraMs: expMs };
}

export type ShareTokenError = 'ausente' | 'malformado' | 'invalido' | 'expirado';

/**
 * Verifica el token contra la propuesta. Compara en tiempo constante para no
 * filtrar la firma byte por byte.
 */
export function verificarShareToken(
  propuestaId: number,
  token: unknown
): { ok: true } | { ok: false; error: ShareTokenError } {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: 'ausente' };
  }

  const partes = token.split('.');
  if (partes.length !== 2) {
    return { ok: false, error: 'malformado' };
  }

  const expMs = Number(partes[0]);
  if (!Number.isFinite(expMs) || expMs < 0) {
    return { ok: false, error: 'malformado' };
  }

  const esperado = firma(propuestaId, expMs);
  const recibido = partes[1];
  if (recibido.length !== esperado.length) {
    return { ok: false, error: 'invalido' };
  }
  if (!crypto.timingSafeEqual(Buffer.from(esperado, 'utf8'), Buffer.from(recibido, 'utf8'))) {
    return { ok: false, error: 'invalido' };
  }

  // La caducidad se revisa DESPUÉS de la firma: así un token inventado nunca
  // recibe de respuesta la pista de "expirado".
  if (expMs !== 0 && Date.now() > expMs) {
    return { ok: false, error: 'expirado' };
  }

  return { ok: true };
}
