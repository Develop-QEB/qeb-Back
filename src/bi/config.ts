/**
 * Configuración del BI (QEBI). TODAS sus variables llevan prefijo BI_ para no chocar con
 * las de qeb-Back: el BI NUNCA lee PORT, JWT_SECRET, DATABASE_URL, FRONTEND_URL ni
 * CORS_ORIGIN, y qeb-Back no lee ninguna BI_*. El BI usa sus propias bases (ventas en
 * solo lectura + QEBI escribible), distintas de la de qeb-Back.
 *
 * Este módulo NO lanza errores al importarse: loadBiConfig() devuelve qué falta y el
 * interruptor (./index) decide no montar el BI. Así qeb-Back nunca se cae por el BI.
 */

export interface BiConfig {
  corsOrigin: string[];
  db: { host: string; port: number; user: string; password: string; database: string; ssl: boolean };
  /** Base donde se crea/lee la tabla editable bi_presupuesto (nueva, aislada). */
  writeDb: string;
  /** Si true, el BI crea la tabla bi_presupuesto (única escritura en la BD de ventas). */
  allowCreate: boolean;
  /** Base propia ESCRIBIBLE (Hostinger): usuarios del BI (qebi_usuario) y objetivos. */
  dbWrite: { host: string; port: number; user: string; password: string; database: string; enabled: boolean };
  /** 'TOTAL' = todos los Monto Total; 'VENTA' = solo U_dscTAsig='Venta'. */
  ventaDef: 'TOTAL' | 'VENTA';
  /** Secreto de los JWT del BI. Distinto del JWT_SECRET de qeb-Back. */
  jwtSecret: string;
  /** Llave del endpoint temporal POST /usuarios/_seed. Vacía = endpoint apagado. */
  seedKey: string;
}

/** Una variable vacía ("BI_X=") cuenta como no definida, para que aplique su default. */
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

export type BiConfigResult = { ok: true; cfg: BiConfig } | { ok: false; missing: string[] };

export function loadBiConfig(): BiConfigResult {
  const missing: string[] = [];
  const req = (name: string): string => {
    const v = opt(name);
    if (v === undefined) missing.push(name);
    return v ?? '';
  };

  const jwtSecret = req('BI_JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) missing.push('BI_JWT_SECRET (mínimo 32 caracteres)');

  const dbName = req('BI_DB_NAME');
  const cfg: BiConfig = {
    corsOrigin: (opt('BI_CORS_ORIGIN') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    db: {
      host: req('BI_DB_HOST'),
      port: Number(opt('BI_DB_PORT') ?? 25060),
      user: req('BI_DB_USER'),
      password: req('BI_DB_PASSWORD'),
      database: dbName,
      ssl: (opt('BI_DB_SSL') ?? 'true') === 'true',
    },
    writeDb: opt('BI_WRITE_DB') ?? dbName,
    allowCreate: (opt('BI_ALLOW_CREATE') ?? 'false') === 'true',
    dbWrite: {
      host: opt('BI_WDB_HOST') ?? '',
      port: Number(opt('BI_WDB_PORT') ?? 3306),
      user: opt('BI_WDB_USER') ?? '',
      password: opt('BI_WDB_PASSWORD') ?? '',
      database: opt('BI_WDB_NAME') ?? '',
      enabled: Boolean(opt('BI_WDB_HOST') && opt('BI_WDB_USER')),
    },
    ventaDef: (opt('BI_VENTA_DEF') ?? 'TOTAL').toUpperCase() === 'VENTA' ? 'VENTA' : 'TOTAL',
    jwtSecret,
    seedKey: opt('BI_SEED_KEY') ?? '',
  };
  const puertoValido = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
  if (!puertoValido(cfg.db.port)) missing.push('BI_DB_PORT (número inválido)');
  if (cfg.dbWrite.enabled && !puertoValido(cfg.dbWrite.port)) missing.push('BI_WDB_PORT (número inválido)');

  return missing.length ? { ok: false, missing } : { ok: true, cfg };
}

let actual: BiConfig | null = null;

export function setBiConfig(cfg: BiConfig): void {
  actual = cfg;
}

/** Config vigente. Solo se llama desde código del BI, que solo corre si el BI se montó. */
export function getBiConfig(): BiConfig {
  if (!actual) throw new Error('[BI] configuración no inicializada');
  return actual;
}
