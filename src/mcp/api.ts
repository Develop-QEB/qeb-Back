import { firmarJwt, type UsuarioMcp } from './auth';

/**
 * Cliente de la API de qeb-Back para el MCP.
 *
 * El MCP NO consulta la base de datos para obtener datos de negocio: llama a la misma
 * API REST que usa el front, con un JWT del usuario. Así los permisos, la visibilidad
 * por rol, el modo mantenimiento y los timeouts aplican igual que en la app.
 */

const TIMEOUT_MS = 20_000;

const baseUrl = () => `http://127.0.0.1:${process.env.PORT || 3000}/api`;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiGet<T = any>(
  usuario: UsuarioMcp,
  ruta: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const url = new URL(baseUrl() + ruta);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${firmarJwt(usuario)}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const nombre = (e as Error).name;
    throw new ApiError(504, nombre === 'TimeoutError' ? 'QEB tardó demasiado en responder' : 'No se pudo consultar QEB');
  }

  let cuerpo: any = null;
  try {
    cuerpo = await resp.json();
  } catch {
    /* respuesta sin JSON */
  }
  if (!resp.ok || cuerpo?.success === false) {
    throw new ApiError(resp.status, cuerpo?.error || cuerpo?.message || `QEB respondió ${resp.status}`);
  }
  return cuerpo as T;
}
