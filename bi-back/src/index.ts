import http from 'node:http';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { env } from './env.js';
import { pool } from './db.js';
import { login as authLogin, verificarToken, type Payload } from './auth.js';
import { listar as listarUsuarios, crear as crearUsuario, actualizar as actualizarUsuario, setPassword as setPasswordUsuario, verificarPasswordActual, sembrarDesdeProd } from './services/usuarios.service.js';
import { getAnios, getAsesores, getClientes, getResumenVentas } from './services/resumenVentas.service.js';
import { getPresupuesto, upsertPresupuesto } from './services/presupuesto.service.js';
import { getContexto, getEventos, getImpacto, getResumen } from './services/historial.service.js';
import { dimensionValida, getCampanias, getCatorcenas, getCiclo, getDistribucion, getEmbudo, getOpciones, getTarifas, getVentasPeriodo, getVentaTotal } from './services/reportes.service.js';
import type { FiltrosReporte } from './types.js';
import {
  getObjetivos,
  limpiarAsesores as limpiarObjAsesores,
  limpiarMensual as limpiarObjMensual,
  setAsesor as setObjAsesor,
  setAsesorBulk as setObjAsesorBulk,
  setMensual as setObjMensual,
  setMensualBulk as setObjMensualBulk,
} from './services/objetivos.service.js';
import { attachRealtime } from './realtime.js';
import type { BaseDatos, CategoriaAccion, FiltrosHistorial, FiltrosResumen } from './types.js';

const app = express();
// CORS: la lista de CORS_ORIGIN (para prod) + cualquier localhost/127.0.0.1 en dev,
// sin importar el puerto. Así abrir el front por localhost o por 127.0.0.1 funciona igual.
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl/Postman/same-origin
      if (env.corsOrigin.includes(origin)) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
      // El front vive en Vercel (bi-qeb.vercel.app) y en el dominio qeb.mx.
      if (/^https:\/\/([a-z0-9-]+\.)*(vercel\.app|qeb\.mx)$/i.test(origin)) return cb(null, true);
      cb(new Error(`CORS: origen no permitido (${origin})`));
    },
  })
);
app.use(express.json());

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
    endpoints: ['/health', '/resumen-ventas', '/asesores', '/clientes', '/anios', '/presupuesto', '/historial/eventos', '/historial/resumen', 'ws:/ws/historial'],
  })
);

app.get('/health', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, ts: new Date().toISOString() });
}));

// --- Auth (login con los usuarios de QEB) ---
app.post('/auth/login', wrap(async (req, res) => {
  const { correo, email, password } = req.body ?? {};
  try {
    const r = await authLogin(String(correo ?? email ?? ''), String(password ?? ''));
    res.json(r);
  } catch {
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
app.post('/usuarios/_seed', wrap(async (req, res) => {
  if (req.query.k !== 'seed_qebi_9f3c2x') { res.status(404).end(); return; }
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
app.get('/historial/eventos', wrap(async (req, res) => {
  res.json(await getEventos(parseFiltrosHistorial(req)));
}));

app.get('/historial/resumen', wrap(async (req, res) => {
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

app.get('/reportes/impacto', wrap(async (req, res) => {
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

// 404 + manejo de errores
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : 'error';
  console.error('❌', msg);
  res.status(500).json({ error: msg });
});

const server = http.createServer(app);
attachRealtime(server);
server.listen(env.port, () => {
  console.log(`🚀 bi-back en http://localhost:${env.port}  (CORS: ${env.corsOrigin.join(', ')})`);
});
