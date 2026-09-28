import 'dotenv/config';

/**
 * TODAS las variables de bi llevan prefijo BI_ para no chocar con las de qeb-Back
 * (mismo repo y misma app de App Platform). bi NUNCA lee PORT, JWT_SECRET,
 * CORS_ORIGIN, DATABASE_URL ni ninguna otra variable de qeb-Back, y qeb-Back no
 * lee ninguna BI_*. Este archivo es el único lugar de bi que toca process.env.
 */
function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.BI_PORT ?? 3001),
  corsOrigin: (process.env.BI_CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  db: {
    host: req('BI_DB_HOST'),
    port: Number(process.env.BI_DB_PORT ?? 25060),
    user: req('BI_DB_USER'),
    password: req('BI_DB_PASSWORD'),
    database: req('BI_DB_NAME', 'u658050396_QEB'),
    ssl: (process.env.BI_DB_SSL ?? 'true') === 'true',
  },
  /** Base donde se crea/lee la tabla editable bi_presupuesto (nueva, aislada). */
  writeDb: process.env.BI_WRITE_DB ?? process.env.BI_DB_NAME ?? 'u658050396_QEB',
  /** Si true, el back crea la tabla bi_presupuesto (única escritura). Default false = nada se crea. */
  allowCreate: (process.env.BI_ALLOW_CREATE ?? 'false') === 'true',
  /**
   * Base propia ESCRIBIBLE (Hostinger) — aquí SÍ creamos tablas y guardamos lo que
   * captura el equipo (objetivos/metas). Separada de la BD de QEB (solo lectura).
   */
  dbWrite: {
    host: process.env.BI_WDB_HOST ?? '',
    port: Number(process.env.BI_WDB_PORT ?? 3306),
    user: process.env.BI_WDB_USER ?? '',
    password: process.env.BI_WDB_PASSWORD ?? '',
    database: process.env.BI_WDB_NAME ?? '',
    enabled: Boolean(process.env.BI_WDB_HOST && process.env.BI_WDB_USER),
  },
  /** 'TOTAL' = todos los Monto Total; 'VENTA' = solo U_dscTAsig='Venta'. */
  ventaDef: (process.env.BI_VENTA_DEF ?? 'TOTAL').toUpperCase() as 'TOTAL' | 'VENTA',
  /**
   * Secreto para firmar/verificar los JWT del login del BI. OBLIGATORIO y sin valor
   * por defecto (antes había uno público en el código). Debe ser DISTINTO del
   * JWT_SECRET de qeb-Back para que los tokens de un sistema no sirvan en el otro.
   */
  jwtSecret: req('BI_JWT_SECRET'),
  /**
   * Llave del endpoint temporal POST /usuarios/_seed. Si no está definida (lo normal
   * en DO), el endpoint responde 404: queda apagado.
   */
  seedKey: process.env.BI_SEED_KEY ?? '',
} as const;
