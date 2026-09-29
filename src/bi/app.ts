import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { getBiConfig } from './config';
import { query } from './db';
import { login as authLogin, verificarToken, type Payload } from './auth';
import { listar as listarUsuarios, crear as crearUsuario, actualizar as actualizarUsuario, setPassword as setPasswordUsuario, verificarPasswordActual, sembrarDesdeProd } from './services/usuarios.service';
import { getAnios, getAsesores, getClientes, getResumenVentas } from './services/resumenVentas.service';
import { getPresupuesto, upsertPresupuesto } from './services/presupuesto.service';
import { getContexto, getEventos, getImpacto, getResumen } from './services/historial.service';
import { dimensionValida, getCampanias, getCatorcenas, getCiclo, getDistribucion, getEmbudo, getOpciones, getTarifas, getVentasPeriodo, getVentaTotal } from './services/reportes.service';
import type { FiltrosReporte } from './types';
import {
  getObjetivos,
  limpiarAsesores as limpiarObjAsesores,
  limpiarMensual as limpiarObjMensual,
  setAsesor as setObjAsesor,
  setAsesorBulk as setObjAsesorBulk,
  setMensual as setObjMensual,
  setMensualBulk as setObjMensualBulk,
} from './services/objetivos.service';
import type { BaseDatos, CategoriaAccion, FiltrosHistorial, FiltrosResumen } from './types';

/**
 * API del BI (QEBI), montada bajo /bi dentro del proceso de qeb-Back (ver ./index).
 * Este módulo solo se carga si BI_ENABLED=true y la config ya se validó. Tiene su propio
 * CORS, body parser, 404 y manejo de errores: nada de esto toca las rutas de qeb-Back.
 */

/**
 * Orígenes permitidos: la lista de BI_CORS_ORIGIN (para prod) + cualquier localhost/127.0.0.1
 * en dev, sin importar el puerto, + el front en Vercel (bi-qeb.vercel.app) y el dominio qeb.mx.
 * Sin Origin (curl/Postman/same-origin) se permite. Lo usan el CORS y el WebSocket.
 */
export function origenPermitido(origin: string | undefined): boolean {
  if (!origin) return true;
  if (getBiConfig().corsOrigin.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return /^https:\/\/([a-z0-9-]+\.)*(vercel\.app|qeb\.mx)$/i.test(origin);
}

/**
 * Limita cuántas peticiones de un endpoint pesado corren a la vez; las demás esperan turno
 * en una cola con tope (si se llena: 503). Si el cliente se va mientras espera, sale de la
 * cola sin ocupar lugar, así nunca se "pierden" lugares.
 */
function limitar(max: number, maxCola = 20) {
  let activas = 0;
  const cola: { res: Response; correr: () => void }[] = [];
  const siguiente = () => {
    while (activas < max && cola.length) {
      const t = cola.shift()!;
      if (t.res.destroyed || t.res.writableEnded) continue; // el cliente ya se fue
      t.correr();
    }
  };
  return (_req: Request, res: Response, next: NextFunction) => {
    const correr = () => {
      activas++;
      let hecho = false;
      const fin = () => {
        if (hecho) return;
        hecho = true;
        activas--;
        siguiente();
      };
      res.once('finish', fin);
      res.once('close', fin);
      next();
    };
    if (activas < max) return correr();
    if (cola.length >= maxCola) {
      res.status(503).json({ error: 'Servidor ocupado, intenta de nuevo en un momento' });
      return;
    }
    const turno = { res, correr };
    cola.push(turno);
    res.once('close', () => {
      const i = cola.indexOf(turno);
      if (i >= 0) cola.splice(i, 1);
    });
  };
}

/**
 * Tope de intentos fallidos de login (en memoria): por correo y por IP, en una ventana.
 * bcrypt corre en el mismo hilo que qeb-Back, así que no conviene dejarlo abierto a fuerza bruta.
 */
const LOGIN_VENTANA_MS = 15 * 60 * 1000;
const LOGIN_MAX_POR_CORREO = 10;
const LOGIN_MAX_POR_IP = 30;
const fallosLogin = new Map<string, number[]>();
function recientes(clave: string, ahora: number): number[] {
  const v = (fallosLogin.get(clave) ?? []).filter((t) => ahora - t < LOGIN_VENTANA_MS);
  if (v.length) fallosLogin.set(clave, v);
  else fallosLogin.delete(clave);
  return v;
}
function ipCliente(req: Request): string {
  // Detrás del proxy de App Platform la IP real viene en X-Forwarded-For (primer valor).
  const xff = req.headers['x-forwarded-for'];
  const primera = (Array.isArray(xff) ? xff[0] : xff ?? '').split(',')[0].trim();
  return primera || req.socket.remoteAddress || '?';
}
const barrido = setInterval(() => {
  const ahora = Date.now();
  for (const clave of [...fallosLogin.keys()]) recientes(clave, ahora);
}, LOGIN_VENTANA_MS);
barrido.unref();
// Las consultas de historial/impacto traen miles de filas: comparten memoria con qeb-Back.
const pesado = limitar(2);

const app = express();
app.disable('x-powered-by');
app.use(
  cors({
    origin(origin, cb) {
      if (origenPermitido(origin)) return cb(null, true);
      cb(new Error(`CORS: origen no permitido (${origin})`));
    },
  })
);
app.use(express.json({ limit: '1mb' }));

const BASES = new Set<BaseDatos>(['CIMU', 'Trade', 'UDC']);
function parseBase(v: unknown): BaseDatos | null {
  if (typeof v !== 'string' || v === '' || v.toLowerCase() === 'todas') return null;
  const hit = [...BASES].find((b) => b.toLowerCase() === v.toLowerCase());
  return hit ?? null;
}
/** Lee un query param multi-valor: "a,b,c" (o repetido) → ['a','b','c']. Vacío = undefined. */
function parseLista(v: unknown): string[] | undefined {
  const arr = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  return arr.length ? arr : undefined;
}
function parseFiltros(req: Request): FiltrosResumen {
  const q = req.query;
  const anio = Number(q.anio);
  const bases = parseLista(q.bases);
  return {
    base: parseBase(q.base) ?? (bases && bases.length === 1 ? parseBase(bases[0]) : null),
    bases,
    tipos: parseLista(q.tipos),
    muebles: parseLista(q.muebles),
    digital: parseLista(q.digital),
    asesor: typeof q.asesor === 'string' && q.asesor && q.asesor.toLowerCase() !== 'todos' ? q.asesor : null,
    cliente: typeof q.cliente === 'string' && q.cliente && q.cliente.toLowerCase() !== 'todos' ? q.cliente : null,
    anio: Number.isInteger(anio) ? anio : new Date().getFullYear(),
    mes: q.mes != null && q.mes !== '' ? Number(q.mes) : null,
  };
}

const CATEGORIAS: CategoriaAccion[] = ['eliminacion', 'autorizacion', 'rechazo', 'cambio_estado', 'asignacion', 'creacion', 'post_sap', 'otro'];
function parseFiltrosHistorial(req: Request): FiltrosHistorial {
  const q = req.query;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const cat = s(q.categoria);
  return {
    categoria: cat && (CATEGORIAS as string[]).includes(cat) ? (cat as CategoriaAccion) : null,
    campaniaId: q.campaniaId ? Number(q.campaniaId) : null,
    usuario: s(q.usuario),
    tipo: s(q.tipo),
    soloImpacto: q.soloImpacto === 'true' || q.soloImpacto === '1',
    desde: s(q.desde),
    hasta: s(q.hasta),
    limit: q.limit ? Number(q.limit) : 100,
  };
}

/** Envuelve un handler async y manda errores al middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

app.get('/', (_req, res) =>
  res.json({
    service: 'bi-back',
    ok: true,
    // Sello para verificar qué build está vivo en prod (abrir <url>/bi/ ).
    version: '2026-09-29-diag',
    ventaDef: getBiConfig().ventaDef,          // 'VENTA' = Embudo/Variaciones cuentan solo U_dscTAsig='Venta' (igual que BI)
    mesRule: 'fecha_fin',                       // mes de la catorcena por Fecha Fin Periodo
    endpoints: ['/health', '/resumen-ventas', '/asesores', '/clientes', '/anios', '/presupuesto', '/historial/eventos', '/historial/resumen', 'ws:/ws/historial'],
  })
);

app.get('/health', wrap(async (_req, res) => {
  try {
    await query('SELECT 1');
  } catch (e) {
    // Público: sin detalle (el mensaje de mysql2 trae host/usuario de la BD). Solo al log.
    console.error('[BI] /health:', (e as Error).message);
    res.status(503).json({ ok: false });
    return;
  }
  res.json({ ok: true, ts: new Date().toISOString() });
}));

// DIAGNÓSTICO TEMPORAL (público, sin datos sensibles): corre las funciones REALES
// que alimentan BI (getResumenVentas) y Embudo (getDistribucion) para Julio 2026 con
// los mismos filtros, para ver por qué difieren. Quitar cuando se resuelva.
app.get('/_diag', wrap(async (_req, res) => {
  const fBI: FiltrosResumen = { base: null, bases: ['CIMU', 'Trade'], tipos: ['RT', 'BF', 'IN'], muebles: ['PARABUS', 'COLUMNA'], digital: ['Tradicional', 'Digital'], asesor: null, cliente: null, anio: 2026, mes: null };
  const fEmb: FiltrosReporte = { anio: 2026, mes: 7, plaza: null, formato: null, mueble: null, cliente: null, asesor: null, bases: ['CIMU', 'TRADE'], tipos: ['RT', 'BF', 'IN'], muebles: ['PARABUS', 'COLUMNA'], digital: ['Tradicional', 'Digital'] };
  const [resumen, plaza] = await Promise.all([getResumenVentas(fBI), getDistribucion('plaza', fEmb)]);
  const biJul = resumen.ventasMensuales.find((m) => m.mes === 7)?.aps ?? 0;
  const embudoJul = plaza.reduce((a, d) => a + d.monto, 0);
  res.json({
    ventaDef: getBiConfig().ventaDef,
    biJul, embudoJul, diff: embudoJul - biJul,
    biMensual: resumen.ventasMensuales.map((m) => ({ mes: m.mes, aps: Math.round(m.aps) })),
  });
}));

// --- Auth (login con los usuarios de QEB) ---
app.post('/auth/login', wrap(async (req, res) => {
  const { correo, email, password } = req.body ?? {};
  const correoNorm = String(correo ?? email ?? '').trim().toLowerCase();
  const ahora = Date.now();
  const claveCorreo = `c:${correoNorm}`;
  const claveIp = `ip:${ipCliente(req)}`;
  if (recientes(claveCorreo, ahora).length >= LOGIN_MAX_POR_CORREO || recientes(claveIp, ahora).length >= LOGIN_MAX_POR_IP) {
    res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.' });
    return;
  }
  try {
    const r = await authLogin(String(correo ?? email ?? ''), String(password ?? ''));
    fallosLogin.delete(claveCorreo);
    res.json(r);
  } catch {
    for (const clave of [claveCorreo, claveIp]) fallosLogin.set(clave, [...recientes(clave, ahora), ahora]);
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
}));

/** Middleware: exige un JWT válido (Authorization: Bearer …). */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'No autenticado' }); return; }
  try {
    (req as Request & { user?: unknown }).user = verificarToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada o inválida' });
  }
}

const getUser = (req: Request): Payload => (req as Request & { user: Payload }).user;

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: getUser(req) });
});

// Cambiar la PROPIA contraseña.
app.post('/auth/cambiar-password', requireAuth, wrap(async (req, res) => {
  const { actual, nueva } = req.body ?? {};
  if (!nueva || String(nueva).length < 6) { res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' }); return; }
  const u = getUser(req);
  const ok = await verificarPasswordActual(u.userId, String(actual ?? ''));
  if (!ok) { res.status(400).json({ error: 'La contraseña actual es incorrecta' }); return; }
  await setPasswordUsuario(u.userId, String(nueva));
  res.json({ ok: true });
}));

/** Solo Admin. */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!getUser(req)?.esAdmin) { res.status(403).json({ error: 'Solo administradores' }); return; }
  next();
}

// --- Gestor de usuarios (solo Admin) ---
app.get('/usuarios', requireAuth, requireAdmin, wrap(async (_req, res) => {
  res.json(await listarUsuarios());
}));
app.post('/usuarios', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { nombre, correo, password, esAdmin, permisos } = req.body ?? {};
  if (!nombre || !correo || !password || String(password).length < 6) { res.status(400).json({ error: 'Nombre, correo y contraseña (mín. 6) requeridos' }); return; }
  await crearUsuario({ nombre: String(nombre), correo: String(correo).trim(), password: String(password), esAdmin: !!esAdmin, permisos });
  res.json({ ok: true });
}));
app.put('/usuarios/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'id inválido' }); return; }
  const { nombre, esAdmin, activo, permisos } = req.body ?? {};
  await actualizarUsuario(id, { nombre, esAdmin, activo, permisos });
  res.json({ ok: true });
}));
app.post('/usuarios/:id/password', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body ?? {};
  if (!Number.isInteger(id) || !password || String(password).length < 6) { res.status(400).json({ error: 'id/contraseña inválidos (mín. 6)' }); return; }
  await setPasswordUsuario(id, String(password));
  res.json({ ok: true });
}));

// TEMPORAL: siembra inicial de usuarios QEBI desde los usuarios reales de QEB.
// Lista blanca de correos exactos (curada) para no arrastrar falsos positivos.
const SEED_CORREOS_QEBI = [
  'mario.salcido@deepia.dev', // admin
  'contacto@qeb.mx',          // Jos (admin)
  'mblancas@imu.com.mx',      // Miguel Ángel Blancas — Especialista BI (mike)
  'cenvila@imu.com.mx',       // María Cristina Díaz — Especialista BI
  'agonzalez@imu.com.mx',     // Ángel Antonio González
  'rlunal@imu.com.mx',        // Rodrigo Luna López
  'rmargain@imu.com.mx',      // Rodrigo Margain
  'gcandano@imu.com.mx',      // Gerardo Candano — Director General
  'jmlopez@imu.com.mx',       // Juan Manuel López Rodríguez (Gerente)
  'dcarbajal@imu.com.mx',     // Dulce Angélica Carbajal
];
const SEED_ADMINS_QEBI = ['mario.salcido@deepia.dev', 'contacto@qeb.mx'];
// Usuarios que NO están en la tabla de producción de QEB: se dan de alta a mano.
const SEED_MANUALES_QEBI: { nombre: string; correo: string }[] = [
  { nombre: 'Ángel Romo', correo: 'aromo@imu.com.mx' },
];
// Apagado salvo que BI_SEED_KEY esté definida (en DO no se define). La llave ya no
// vive en el código: la anterior quedó en el historial y por eso deja de servir.
app.post('/usuarios/_seed', wrap(async (req, res) => {
  const { seedKey } = getBiConfig();
  if (!seedKey || req.query.k !== seedKey) { res.status(404).end(); return; }
  const extra = Array.isArray(req.body?.correosExactos) ? req.body.correosExactos.map(String) : [];
  const adminCorreos = [...SEED_ADMINS_QEBI, ...(Array.isArray(req.body?.adminCorreos) ? req.body.adminCorreos.map(String) : [])];
  const sembrados = await sembrarDesdeProd({
    correosExactos: [...SEED_CORREOS_QEBI, ...extra],
    passwordInicial: 'admin123',
    permisos: { bi: true, variaciones: true, embudo: true, objetivos: false },
    adminCorreos,
  });
  // Altas manuales (no están en prod): idempotentes, no pisan contraseña.
  const manuales: { correo: string; nombre: string }[] = [];
  for (const m of SEED_MANUALES_QEBI) {
    await crearUsuario({
      nombre: m.nombre, correo: m.correo, password: 'admin123',
      esAdmin: false, permisos: { bi: true, variaciones: true, embudo: true, objetivos: false },
    });
    manuales.push({ correo: m.correo, nombre: m.nombre });
  }
  res.json({ total: sembrados.length + manuales.length, sembrados, manuales });
}));

// Todo lo de datos exige sesión (login seguro). /health, / y /auth/login son públicos.
app.use(['/resumen-ventas', '/asesores', '/clientes', '/anios', '/historial', '/reportes', '/objetivos', '/presupuesto'], requireAuth);

app.get('/resumen-ventas', wrap(async (req, res) => {
  res.json(await getResumenVentas(parseFiltros(req)));
}));

app.get('/asesores', wrap(async (_req, res) => {
  res.json(await getAsesores());
}));

app.get('/clientes', wrap(async (_req, res) => {
  res.json(await getClientes());
}));

app.get('/anios', wrap(async (_req, res) => {
  res.json(await getAnios());
}));

// --- Historial de acciones ---
app.get('/historial/eventos', pesado, wrap(async (req, res) => {
  res.json(await getEventos(parseFiltrosHistorial(req)));
}));

app.get('/historial/resumen', pesado, wrap(async (req, res) => {
  const f = parseFiltrosHistorial(req);
  res.json(await getResumen({ desde: f.desde, hasta: f.hasta }));
}));

app.get('/historial/contexto', wrap(async (req, res) => {
  const refId = Number(req.query.refId);
  if (!Number.isInteger(refId) || refId <= 0) return res.status(400).json({ error: 'refId inválido' });
  res.json(await getContexto(refId));
}));

// --- Reportes ---
// Parsea la barra de filtros compartida (Embudo) desde el query string.
function parseFiltrosReporte(req: Request): FiltrosReporte {
  const str = (k: string) => (typeof req.query[k] === 'string' && (req.query[k] as string).trim() ? (req.query[k] as string).trim() : null);
  const nums = (k: string) => {
    const v = str(k);
    return v ? v.split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
  };
  const lista = (k: string) => {
    const v = str(k);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
  };
  const mes = Number(req.query.mes);
  return {
    anio: Number(req.query.anio) || new Date().getFullYear(),
    mes: Number.isInteger(mes) && mes >= 1 && mes <= 12 ? mes : null,
    plaza: str('plaza'),
    formato: str('formato'),
    mueble: str('mueble'),
    cliente: str('cliente'),
    asesor: str('asesor'),
    meses: nums('meses'),
    catorcenas: nums('catorcenas'),
    semanas: nums('semanas'),
    bases: lista('bases'),
    tipos: lista('tipos'),
    muebles: lista('muebles'),
    digital: lista('digital'),
  };
}

app.get('/reportes/opciones', wrap(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json(await getOpciones(anio));
}));

app.get('/reportes/venta-total', wrap(async (req, res) => {
  res.json({ total: await getVentaTotal(parseFiltrosReporte(req)) });
}));

app.get('/reportes/tarifas', wrap(async (req, res) => {
  res.json(await getTarifas(parseFiltrosReporte(req)));
}));

app.get('/reportes/catorcenas', wrap(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json(await getCatorcenas(anio));
}));

app.get('/reportes/embudo', wrap(async (req, res) => {
  res.json(await getEmbudo(parseFiltrosReporte(req)));
}));

app.get('/reportes/distribucion', wrap(async (req, res) => {
  const dim = String(req.query.dim ?? '');
  if (!dimensionValida(dim)) return res.status(400).json({ error: 'dim inválida' });
  res.json(await getDistribucion(dim, parseFiltrosReporte(req)));
}));

app.get('/reportes/ventas-periodo', wrap(async (req, res) => {
  const per = String(req.query.periodo ?? 'mes');
  if (per !== 'mes' && per !== 'catorcena' && per !== 'semana') return res.status(400).json({ error: 'periodo inválido' });
  res.json(await getVentasPeriodo(per, parseFiltrosReporte(req)));
}));

app.get('/reportes/ciclo', wrap(async (req, res) => {
  res.json(await getCiclo(parseFiltrosReporte(req)));
}));

app.get('/reportes/campanias', wrap(async (req, res) => {
  res.json(await getCampanias(Number(req.query.limit) || 120, parseFiltrosReporte(req)));
}));

app.get('/reportes/impacto', pesado, wrap(async (req, res) => {
  const anio = Number(req.query.anio) || null;
  const desde = typeof req.query.desde === 'string' ? req.query.desde : null;
  const hasta = typeof req.query.hasta === 'string' ? req.query.hasta : null;
  res.json(await getImpacto({ anio, desde, hasta }));
}));

// --- Objetivos/metas (BD propia escribible, compartidos por el equipo) ---
const anioBody = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 2000 && Number(v) <= 2100 ? Number(v) : null);

app.get('/objetivos', wrap(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json(await getObjetivos(anio));
}));

app.put('/objetivos/mensual', wrap(async (req, res) => {
  const { anio, mes, monto } = req.body ?? {};
  const a = anioBody(anio);
  if (a === null || !(Number(mes) >= 1 && Number(mes) <= 12)) return res.status(400).json({ error: 'anio/mes inválido' });
  await setObjMensual(a, Number(mes), Number(monto));
  res.json({ ok: true });
}));

app.put('/objetivos/mensual-bulk', wrap(async (req, res) => {
  const { anio, montos } = req.body ?? {};
  const a = anioBody(anio);
  if (a === null || !Array.isArray(montos)) return res.status(400).json({ error: 'inválido' });
  await setObjMensualBulk(a, montos.map(Number));
  res.json({ ok: true });
}));

app.put('/objetivos/asesor', wrap(async (req, res) => {
  const { anio, asesor, monto } = req.body ?? {};
  const a = anioBody(anio);
  if (a === null || typeof asesor !== 'string' || !asesor.trim()) return res.status(400).json({ error: 'inválido' });
  await setObjAsesor(a, asesor.trim(), Number(monto));
  res.json({ ok: true });
}));

app.put('/objetivos/asesor-bulk', wrap(async (req, res) => {
  const { anio, montos } = req.body ?? {};
  const a = anioBody(anio);
  if (a === null || typeof montos !== 'object' || montos === null) return res.status(400).json({ error: 'inválido' });
  await setObjAsesorBulk(a, montos as Record<string, number>);
  res.json({ ok: true });
}));

app.delete('/objetivos/mensual', wrap(async (req, res) => {
  const a = anioBody(req.query.anio);
  if (a === null) return res.status(400).json({ error: 'anio inválido' });
  await limpiarObjMensual(a);
  res.json({ ok: true });
}));

app.delete('/objetivos/asesor', wrap(async (req, res) => {
  const a = anioBody(req.query.anio);
  if (a === null) return res.status(400).json({ error: 'anio inválido' });
  await limpiarObjAsesores(a);
  res.json({ ok: true });
}));

// --- Presupuesto (meta editable — el lapicito) ---
app.get('/presupuesto', wrap(async (req, res) => {
  const anio = Number(req.query.anio) || new Date().getFullYear();
  res.json(await getPresupuesto(anio, parseBase(req.query.base)));
}));

app.put('/presupuesto', wrap(async (req, res) => {
  const { anio, mes, base, monto } = req.body ?? {};
  const fila = await upsertPresupuesto(Number(anio), Number(mes), parseBase(base), Number(monto));
  res.json(fila);
}));

// 404 + manejo de errores (solo para /bi; qeb-Back conserva los suyos)
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const e = (err ?? {}) as { status?: number; statusCode?: number; code?: unknown; errno?: unknown; sqlMessage?: unknown };
  const msg = err instanceof Error ? err.message : 'error';
  console.error('[BI] ❌', msg);
  if (msg.startsWith('CORS:')) {
    res.status(403).json({ error: msg });
    return;
  }
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: msg }); // JSON inválido (400), cuerpo muy grande (413), etc.
    return;
  }
  // Errores de BD/red de mysql2: el mensaje trae host, usuario o SQL. Al cliente, genérico.
  const code = typeof e.code === 'string' ? e.code : '';
  if (e.errno !== undefined || e.sqlMessage !== undefined || /^(ER_|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|PROTOCOL_)/.test(code)) {
    res.status(500).json({ error: 'Error de base de datos' });
    return;
  }
  res.status(500).json({ error: msg });
});

/** App raíz: todo el BI cuelga de /bi (bi-front usa VITE_API_URL=https://<host>/bi). */
export function crearBiApp(): express.Express {
  const raiz = express();
  raiz.disable('x-powered-by');
  raiz.use('/bi', app);
  raiz.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return raiz;
}
