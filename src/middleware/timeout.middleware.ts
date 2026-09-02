import { Request, Response, NextFunction } from 'express';

/**
 * Timeout de request por ruta.
 *
 * Contexto (caídas de main con CPU 100%): cuando la BD se satura, las requests
 * se quedaban esperando indefinidamente (no existía ningún timeout HTTP), los
 * clientes reintentaban encima y el backlog acumulado tumbaba el proceso.
 * Con este middleware, una request que excede su límite responde 503 y libera
 * al cliente; la fila nunca crece más allá de unos segundos de profundidad.
 *
 * IMPORTANTE: Node no puede abortar el handler en curso — sigue corriendo por
 * debajo aunque ya respondimos 503. Por eso:
 *   1. Se neutralizan res.status/json/send/end tras el timeout, para que el
 *      res.json() tardío del handler no lance ERR_HTTP_HEADERS_SENT.
 *   2. El trabajo en la BD lo corta max_execution_time (configurado en el
 *      panel de DigitalOcean), no este middleware.
 *
 * Los límites son POR RUTA: las operaciones legítimamente largas (transacciones
 * de reservas con SELECT FOR UPDATE, uploads de artes/archivos en base64,
 * bulks de inventario, exports) tienen margen amplio para no cortarlas.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

// Patrones sobre req.path SIN el prefijo /api (el middleware se monta en /api).
// Se evalúan en orden; gana el primer match.
const LONG_ROUTES: Array<{ pattern: RegExp; ms: number; motivo: string }> = [
  // Creación/borrado/toggle de reservas: lotes de transacciones con lock que
  // esperan hasta 20s cada una por diseño (inventario-bloqueo.service.ts).
  { pattern: /^\/propuestas\/[^/]+\/reservas/, ms: 120_000, motivo: 'transacciones de reservas' },
  // Todo lo relacionado a artes: uploads de imágenes/videos en base64 grandes
  // (el límite de express.json está en 200mb por esto mismo).
  { pattern: /arte/, ms: 180_000, motivo: 'upload/gestión de artes' },
  // Uploads de archivos generales (multer) y foto de perfil.
  { pattern: /\/archivo$|\/upload-photo$/, ms: 180_000, motivo: 'upload de archivo' },
  // Cargas masivas y mantenimiento de inventario (admin, poco frecuentes).
  { pattern: /^\/inventarios\/(bulk|espacios\/poblar|reservas\/arreglar-huerfanas)/, ms: 300_000, motivo: 'bulk/mantenimiento de inventario' },
  // Exports (layouts de campañas, etc.).
  { pattern: /export/, ms: 120_000, motivo: 'export' },
];

function resolveTimeoutMs(path: string): number {
  for (const rule of LONG_ROUTES) {
    if (rule.pattern.test(path)) return rule.ms;
  }
  return DEFAULT_TIMEOUT_MS;
}

export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const limitMs = resolveTimeoutMs(req.path);

  const timer = setTimeout(() => {
    if (!res.headersSent) {
      console.warn(`[Timeout] ${req.method} ${req.originalUrl} excedió ${limitMs / 1000}s — respondiendo 503`);
      res.status(503).json({
        success: false,
        error: 'El servidor está saturado en este momento. Intenta de nuevo en unos segundos.',
        code: 'REQUEST_TIMEOUT',
      });
    }
    // Neutralizar escrituras posteriores del handler (sigue corriendo por
    // debajo): sin esto, su res.json() tardío lanzaría "Cannot set headers
    // after they are sent" como unhandledRejection.
    const keepStatus = () => res;
    res.status = keepStatus as unknown as typeof res.status;
    res.json = keepStatus as unknown as typeof res.json;
    res.send = keepStatus as unknown as typeof res.send;
  }, limitMs);

  const clear = () => clearTimeout(timer);
  res.on('finish', clear);
  res.on('close', clear);

  next();
}
