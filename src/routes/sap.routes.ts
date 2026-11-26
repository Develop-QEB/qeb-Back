import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';

/**
 * Paso autenticado hacia el proxy de SAP.
 *
 * ANTES: el navegador de cada usuario llamaba a `https://sap.qeb.mx` directo
 * (VITE_SAP_URL en el front). Como el proxy no pide ningún token, cualquiera
 * en internet podía hacer `GET https://sap.qeb.mx/cuic` y bajarse el catálogo
 * completo de clientes de SAP — que además es el SAP de IMU, no nuestro.
 * Tampoco se podía cerrar con una lista de IPs permitidas, porque las llamadas
 * venían de los navegadores de los usuarios, que salen desde cualquier IP.
 *
 * AHORA: el front pide los catálogos aquí, con su sesión. El back es el único
 * que habla con el proxy. Eso deja el camino libre para que el proxy escuche
 * solo en 127.0.0.1 (en el droplet) o acepte solo la IP del back (en main),
 * sin dejar a nadie fuera.
 *
 * El destino se configura con SAP_PROXY_URL. El valor por omisión es el de
 * hoy (https://sap.qeb.mx) para que nada se rompa mientras se ajusta cada
 * ambiente; en el droplet conviene ponerlo en http://127.0.0.1:3010.
 */

const router = Router();

const SAP_PROXY_URL = (process.env.SAP_PROXY_URL || 'https://sap.qeb.mx').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.SAP_PROXY_TIMEOUT_MS) || 120_000;

const METODOS_PERMITIDOS = new Set(['GET', 'POST', 'PATCH']);

/**
 * Lista blanca de rutas del proxy. Sin esto, el endpoint sería un proxy
 * abierto hacia el host del proxy para cualquier usuario con sesión.
 * Si el proxy gana una ruta nueva, hay que agregarla aquí también.
 */
const RUTAS_PERMITIDAS: RegExp[] = [
  // Catálogo de clientes (CUIC) por compañía SAP.
  /^\/cuic(-test|-trade|-udc|-udc-test)?$/,
  // Catálogo de artículos por compañía SAP.
  /^\/articulos(-test|-trade|-udc|-udc-test)?$/,
  // Delivery notes: alta (POST) y consulta por compañía.
  /^\/delivery-notes(-test|-trade|-udc|-udc-test)?$/,
  // Delivery note puntual: /delivery-notes/<compañía>/<docEntry>
  /^\/delivery-notes\/[A-Za-z0-9_-]{1,40}\/\d{1,12}$/,
  // Búsqueda de delivery note por NumAtCard.
  /^\/delivery-note-by-numatcard\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_.\- ]{1,60}$/,
  // Order por DocNum.
  /^\/order-by-docnum\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]{1,40}$/,
  // Limpieza del caché del proxy (?key=cuic, cuic-test, ...).
  /^\/clear-cache$/,
];

function rutaPermitida(ruta: string): boolean {
  return RUTAS_PERMITIDAS.some((patron) => patron.test(ruta));
}

function armarQueryString(query: Request['query']): string {
  const partes = new URLSearchParams();
  for (const [clave, valor] of Object.entries(query)) {
    if (typeof valor === 'string') {
      partes.append(clave, valor);
    } else if (Array.isArray(valor)) {
      for (const item of valor) {
        if (typeof item === 'string') partes.append(clave, item);
      }
    }
  }
  const texto = partes.toString();
  return texto ? `?${texto}` : '';
}

// Toda la rama exige sesión: es el punto de todo el cambio.
router.use(authMiddleware);

router.use(async (req: Request, res: Response): Promise<void> => {
  // Dentro de un router montado, req.path ya viene sin el prefijo /api/sap.
  const ruta = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;

  if (!METODOS_PERMITIDOS.has(req.method)) {
    res.status(405).json({ success: false, code: 'METODO_NO_PERMITIDO', error: 'Método no permitido en SAP' });
    return;
  }

  if (!rutaPermitida(ruta)) {
    // 404 a propósito: no confirmamos qué rutas existen del otro lado.
    res.status(404).json({ success: false, code: 'RUTA_SAP_DESCONOCIDA', error: 'Ruta de SAP no disponible' });
    return;
  }

  const destino = `${SAP_PROXY_URL}${ruta}${armarQueryString(req.query)}`;

  const controlador = new AbortController();
  const reloj = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  try {
    // Solo reenviamos cuerpo si de verdad venía uno. express.json() deja {}
    // cuando no hay body, y mandar "{}" rompe los POST del proxy.
    const traeCuerpo =
      req.method !== 'GET' &&
      req.body !== undefined &&
      req.body !== null &&
      Object.keys(req.body as Record<string, unknown>).length > 0;

    const upstream = await fetch(destino, {
      method: req.method,
      // El header Authorization del usuario NO se reenvía: el proxy no lo usa
      // y no tiene por qué ver el token de sesión de QEB.
      headers: traeCuerpo ? { 'Content-Type': 'application/json' } : undefined,
      body: traeCuerpo ? JSON.stringify(req.body) : undefined,
      signal: controlador.signal,
    });

    const tipo = upstream.headers.get('content-type') || 'application/json';
    // fetch ya descomprimió la respuesta, así que no se reenvían
    // content-encoding ni content-length: serían mentira.
    const cuerpo = Buffer.from(await upstream.arrayBuffer());

    res.status(upstream.status);
    res.setHeader('Content-Type', tipo);
    res.setHeader('Cache-Control', 'no-store');
    res.send(cuerpo);
  } catch (error) {
    const abortado = error instanceof Error && error.name === 'AbortError';
    const detalle = error instanceof Error ? error.message : 'desconocido';
    console.error(`[SAP] ${req.method} ${ruta} falló: ${detalle}`);
    res.status(abortado ? 504 : 502).json({
      success: false,
      code: abortado ? 'SAP_TIMEOUT' : 'SAP_INALCANZABLE',
      error: abortado
        ? 'SAP no respondió a tiempo'
        : 'No se pudo contactar a SAP',
    });
  } finally {
    clearTimeout(reloj);
  }
});

export default router;
