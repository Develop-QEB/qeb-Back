import prisma from '../utils/prisma';
import { emitToAll, SOCKET_EVENTS } from '../config/socket';
import { logHistorial } from '../utils/historial';
import { rolEnLista } from '../utils/permissions';
import { filtrarPorPreferenciasNotif } from '../utils/preferenciasNotif';

// Filtro Autorizacion "Quitar Posteo" — flujo:
//   Comercial (nota inicio) -> Filtro GC (check) -> Facturacion (aprueba/rechaza) -> TI (ejecuta unmarkPostedAPS)
//
// Cada intento crea una fila nueva en desposteo_solicitudes (auditoria por intento).
// El hilo de notas se acumula por (campania_id, aps) — se listan todas las notas
// de todas las solicitudes previas para el mismo par, en orden cronologico.
//
// Escalado por monto via desposteo_tabuladores (Fase 1: infra vacia, Jos define).

// ─── Tipos ───────────────────────────────────────────────────────────────

export type EstatusDesposteo =
  | 'solicitado'          // recien creado, esperando GC
  | 'filtro_aprobado'     // GC dio check, esperando facturacion
  | 'aprobado'            // facturacion aprobo, esperando TI ejecute
  | 'rechazado'           // rechazado por GC o facturacion (terminal)
  | 'ejecutado';          // TI ejecuto unmarkPostedAPS (terminal)

export type TipoNota =
  | 'inicio'
  | 'ajuste'
  | 'aprobacion_gerente'
  | 'rechazo_gerente'
  | 'aprobacion_facturacion'
  | 'rechazo_facturacion'
  | 'ejecucion';

export interface ActorInfo {
  id: number;
  nombre: string;
}

// ─── Roles ───────────────────────────────────────────────────────────────

// Espejo del filtro DG. Reusa los mismos roles ya que el GC "responsable
// del asesor" es el mismo actor comercial, aunque el proposito del equipo
// (filtro_desposteo vs filtro_autorizacion) sea distinto.
const GERENTE_COMERCIAL_ROLES = [
  'Gerente Comercial Vía Pública',
  'Gerente Comercial Via Publica',
  'Gerente Comercial Plazas',
  'Gerente Comercial (Plazas)',
  'Gerente Comercial',
];

// Facturacion — aprueba o rechaza el desposteo.
//
// Fix 2026-09-17: antes solo estaban los dos coordinadores, y ademas la
// comparacion en JS era byte-exacta. Eso rompia el flujo en PRODUCCION por
// DOS razones distintas (verificado contra las dos bases):
//   - En PROD los roles estan guardados SIN acento ('Coordinador de
//     Facturacion y Cobranza' x2, 'Analista de Facturacion y Cobranza' x1);
//     en PRUEBAS van CON acento. La lista de aqui solo tenia la variante
//     acentuada.
//   - Faltaban 'Analista de Facturación y Cobranza' y 'Especialista de
//     Facturación', que el resto del sistema si contempla (ver la lista
//     completa en solicitudes.controller.ts).
// El sintoma era especialmente confuso porque MySQL compara con colacion
// accent-insensitive: la tarea SI se creaba para el usuario, pero al darle
// aprobar el guard de JS lo rechazaba con 403. Por eso ahora todas las
// comparaciones de rol de este flujo pasan por rolEnLista().
const FACTURACION_ROLES = [
  'Coordinador de Facturación y Cobranza',
  'Coordinador de Facturación',
  'Analista de Facturación y Cobranza',
  'Especialista de Facturación',
];

const TI_ROLES = ['Gerente de TI', 'Especialista de TI', 'Analista de TI'];

const ASESOR_ROLES = ['Asesor Comercial', 'Asesor Comercial Aeropuerto'];
const ANALISTA_ROLES = ['Asesor Analista', 'Analista de Servicio al Cliente', 'Analista de Aeropuerto'];

// Roles que pueden iniciar el flujo (cuando este activo). Feedback Jos:
// asesores + analistas (analista rutea al mismo GC de su asesor en la red).
// Admin y TI quedan fuera intencionalmente.
const ROLES_SOLICITA_DESPOSTEO = [...ASESOR_ROLES, ...ANALISTA_ROLES];

const ROLES_BYPASS_TI = ['Administrador', 'DEV'];

// Lista de facturacion expuesta para que el controller use la MISMA fuente
// (antes tenia su propia copia y podian desincronizarse).
export const ROLES_FACTURACION_DESPOSTEO = FACTURACION_ROLES;
export const ROLES_GERENTE_COMERCIAL_DESPOSTEO = GERENTE_COMERCIAL_ROLES;

// Feature flag: si false, el endpoint /desposteo/solicitar rechaza a todos.
//
// PRENDIDO el 2026-09-17: ya estan los cuatro puntos que faltaban del paquete
// de Jos — ventana lateral con finalizar tarea, modal enriquecido con el
// desglose real (catorcenas/plaza/caras/tarifa/inversion), indicadores por
// APS y la matriz de roles (asesores + analistas solicitan; TI solo cancela
// con aprobacion de facturacion; admins solo emergencia).
//
// Lo unico que queda del paquete es el ESCALADO POR TABULADOR (routear a
// gerencia o direccion segun el monto). Mientras Jos no defina esos rangos,
// el flujo corre con el comportamiento actual: siempre pasa por el filtro del
// gerente comercial del asesor. La tabla desposteo_tabuladores existe pero
// esta vacia y ningun codigo la lee todavia — no se asume ningun rango.
//
// Nota: desposteo solo vive en stage y dev; main y release lo excluyen
// (ver c5b5d9e), asi que prenderlo aqui no afecta produccion.
export const FEATURE_SOLICITAR_DESPOSTEO_ACTIVE = true;

// Todos los guards de rol de este flujo usan rolEnLista() (insensible a
// acentos y mayusculas). Ver el porque en utils/permissions.ts.
export function puedeSolicitarDesposteo(rol: string | null | undefined): boolean {
  if (!FEATURE_SOLICITAR_DESPOSTEO_ACTIVE) return false;
  return rolEnLista(rol, ROLES_SOLICITA_DESPOSTEO);
}

export function esRolAsesor(rol: string | null | undefined): boolean {
  return rolEnLista(rol, ASESOR_ROLES);
}

export function esRolAnalista(rol: string | null | undefined): boolean {
  return rolEnLista(rol, ANALISTA_ROLES);
}

export function esRolTI(rol: string | null | undefined): boolean {
  return rolEnLista(rol, TI_ROLES);
}

export function puedeBypassearDesposteo(rol: string | null | undefined): boolean {
  return rolEnLista(rol, ROLES_BYPASS_TI);
}

export function esRolFacturacionDesposteo(rol: string | null | undefined): boolean {
  return rolEnLista(rol, FACTURACION_ROLES);
}

export function esRolGerenteComercialDesposteo(rol: string | null | undefined): boolean {
  return rolEnLista(rol, GERENTE_COMERCIAL_ROLES);
}

// ─── Resolucion de actores ───────────────────────────────────────────────

/**
 * Busca al Gerente Comercial responsable del asesor via equipos.
 * Estrategia:
 *   1. Equipos con proposito='filtro_desposteo' (nuevo, especifico para este flujo).
 *   2. Fallback: proposito='filtro_autorizacion' (reusa el mapeo del filtro DG).
 * Devuelve null si el asesor no tiene GC asignado en ninguno.
 */
export async function getGerenteDesposteoParaAsesor(asesorId: number): Promise<ActorInfo | null> {
  const buscarPorProposito = async (proposito: string): Promise<ActorInfo | null> => {
    const equipos = await prisma.usuario_equipo.findMany({
      where: {
        usuario_id: asesorId,
        equipo: { deleted_at: null, proposito },
      },
      select: { equipo_id: true },
    });
    for (const eq of equipos) {
      const gc = await prisma.usuario_equipo.findFirst({
        where: {
          equipo_id: eq.equipo_id,
          usuario: {
            deleted_at: null,
            user_role: { in: GERENTE_COMERCIAL_ROLES },
          },
        },
        include: { usuario: { select: { id: true, nombre: true } } },
      });
      if (gc?.usuario) return { id: gc.usuario.id, nombre: gc.usuario.nombre };
    }
    return null;
  };

  const propio = await buscarPorProposito('filtro_desposteo');
  if (propio) return propio;
  return await buscarPorProposito('filtro_autorizacion');
}

/**
 * Para un analista busca al asesor "dueño" de su red de trabajo. Estrategia:
 * cualquier equipo con proposito='red_trabajo' donde milite el analista, y
 * dentro de ese equipo el primer usuario con rol asesor. Es lo que hace el
 * resto del sistema (ver equipos.controller / campanas.controller).
 */
async function getAsesorParaAnalista(analistaId: number): Promise<{ id: number; nombre: string } | null> {
  const equipos = await prisma.usuario_equipo.findMany({
    where: {
      usuario_id: analistaId,
      equipo: { deleted_at: null, proposito: 'red_trabajo' },
    },
    select: { equipo_id: true },
  });
  for (const eq of equipos) {
    const asesor = await prisma.usuario_equipo.findFirst({
      where: {
        equipo_id: eq.equipo_id,
        usuario: {
          deleted_at: null,
          user_role: { in: ASESOR_ROLES },
        },
      },
      include: { usuario: { select: { id: true, nombre: true } } },
    });
    if (asesor?.usuario) return { id: asesor.usuario.id, nombre: asesor.usuario.nombre };
  }
  return null;
}

/**
 * Resuelve el GC de desposteo para cualquier usuario que pueda solicitar:
 * asesor -> GC directo por equipos filtro_desposteo/filtro_autorizacion.
 * analista -> primero busca su asesor en red_trabajo, luego el GC de ese asesor.
 * Devuelve null si en algun paso no hay match.
 */
export async function getGerenteDesposteoParaUsuario(
  userId: number,
  rol: string | null | undefined,
): Promise<ActorInfo | null> {
  if (esRolAsesor(rol) || puedeBypassearDesposteo(rol)) {
    return getGerenteDesposteoParaAsesor(userId);
  }
  if (esRolAnalista(rol)) {
    const asesor = await getAsesorParaAnalista(userId);
    if (!asesor) return null;
    return getGerenteDesposteoParaAsesor(asesor.id);
  }
  return null;
}

async function getUsuariosFacturacion(): Promise<ActorInfo[]> {
  const users = await prisma.usuario.findMany({
    where: { deleted_at: null, user_role: { in: FACTURACION_ROLES } },
    select: { id: true, nombre: true },
  });
  return users;
}

async function getUsuariosTI(): Promise<ActorInfo[]> {
  const users = await prisma.usuario.findMany({
    where: { deleted_at: null, user_role: { in: TI_ROLES } },
    select: { id: true, nombre: true },
  });
  return users;
}

// ─── Snapshot del APS a desposteo ────────────────────────────────────────

interface SnapshotAPS {
  aps: number;
  campania_id: number;
  campania_nombre: string;
  cliente_nombre: string | null;
  razon_social: string | null;
  post_log_id: number | null;
  posted_at: string | null;
  doc_entry: number | null;
  doc_num: number | null;
  monto_estimado: number;
  circuitos: Array<{
    id: number;
    articulo: string | null;
    formato: string | null;
    ciudad: string | null;
    costo: number;
    caras: number;
    tarifa_publica: number;
    inversion: number;
    tipo: string | null;
    inicio_periodo: string | null;
    catorcena_numero: number | null;
    catorcena_anio: number | null;
    grupo_masivo_id: number | null;
  }>;
}

/**
 * Congela los datos del APS al momento de solicitar. Si despues cambia la
 * campaña, gerente/facturacion siguen viendo lo que estaba al inicio.
 */
async function armarSnapshot(campaniaId: number, aps: number): Promise<{
  snapshot: SnapshotAPS;
  postLogId: number | null;
}> {
  const campania = await prisma.campania.findFirst({
    where: { id: campaniaId },
    select: { id: true, nombre: true, cliente_id: true },
  });
  if (!campania) throw new Error(`Campana #${campaniaId} no encontrada`);

  const cliente = await prisma.cliente.findFirst({
    where: { id: campania.cliente_id },
    select: { T0_U_Cliente: true, T0_U_RazonSocial: true },
  });

  // Ultimo POST exitoso para (campania, aps). El de mayor id es el activo.
  const postLog = await prisma.campania_post_log.findFirst({
    where: { campania_id: campaniaId, aps, success: true },
    orderBy: { id: 'desc' },
    select: {
      id: true, posted_at: true, doc_entry: true, doc_num: true,
      razon_social: true, cliente_nombre: true, solicitud_caras_ids: true,
    },
  });

  let circuitos: SnapshotAPS['circuitos'] = [];
  let monto = 0;
  // Fuente: las RESERVAS del APS, no el post_log. Ver getCircuitosDeAps().
  const rows = await getCircuitosDeAps(campaniaId, aps);
  if (rows.length > 0) {
    // Catalogo de catorcenas para mapear inicio_periodo -> Cat N/AAAA.
    const cats = await prisma.catorcenas.findMany({
      select: { a_o: true, numero_catorcena: true, fecha_inicio: true, fecha_fin: true },
    });
    const catFor = (fecha: Date): { numero: number | null; anio: number | null } => {
      const m = cats.find(cc => fecha >= cc.fecha_inicio && fecha <= cc.fecha_fin);
      return m ? { numero: m.numero_catorcena, anio: m.a_o } : { numero: null, anio: null };
    };
    circuitos = rows.map(r => {
      const caras = Number(r.caras || 0);
      const tarifa = Number(r.tarifa_publica || 0);
      const costo = Number(r.costo || 0);
      const inversion = tarifa * caras;
      const cat = r.inicio_periodo ? catFor(r.inicio_periodo) : { numero: null, anio: null };
      return {
        id: r.id,
        articulo: r.articulo || null,
        formato: r.formato || null,
        ciudad: r.ciudad || null,
        costo,
        caras,
        tarifa_publica: tarifa,
        inversion,
        tipo: r.tipo || null,
        inicio_periodo: r.inicio_periodo ? r.inicio_periodo.toISOString().slice(0, 10) : null,
        catorcena_numero: cat.numero,
        catorcena_anio: cat.anio,
        grupo_masivo_id: r.grupo_masivo_id ?? null,
      };
    });
    // Monto = inversion (tarifa * caras) — refleja lo que Jos ve en el listado.
    // Costo puede estar en 0 (sin captura) o negociado; inversion es tarifa lista.
    monto = circuitos.reduce((acc, c) => acc + (c.inversion || 0), 0);
  }

  const snapshot: SnapshotAPS = {
    aps,
    campania_id: campaniaId,
    campania_nombre: campania.nombre,
    cliente_nombre: postLog?.cliente_nombre || cliente?.T0_U_Cliente || null,
    razon_social: postLog?.razon_social || cliente?.T0_U_RazonSocial || null,
    post_log_id: postLog?.id ?? null,
    posted_at: postLog?.posted_at ? postLog.posted_at.toISOString() : null,
    doc_entry: postLog?.doc_entry ?? null,
    doc_num: postLog?.doc_num ?? null,
    monto_estimado: monto,
    circuitos,
  };

  return { snapshot, postLogId: postLog?.id ?? null };
}

// ─── Desglose enriquecido para modal (catorcenas → plaza/formato → APS → articulo) ────

export interface DesgloseArticulo {
  id: number;
  articulo: string | null;
  grupo_masivo_id: number | null;
  tipo: string | null;
  caras: number;
  tarifa_publica: number;
  inversion: number;
  costo: number;
}
export interface DesglosePlazaFormato {
  plaza: string;
  formato: string;
  caras_total: number;
  inversion_total: number;
  articulos: DesgloseArticulo[];
}
export interface DesgloseCatorcena {
  numero: number | null;
  anio: number | null;
  inicio_periodo: string | null;
  caras_total: number;
  inversion_total: number;
  plazas: DesglosePlazaFormato[];
}
export interface DesgloseAps {
  campania_id: number;
  campania_nombre: string;
  aps: number;
  razon_social: string | null;
  cliente_nombre: string | null;
  cuic: number | null;
  marca: string | null;
  post_log_id: number | null;
  posted_at: string | null;
  doc_entry: number | null;
  doc_num: number | null;
  caras_total: number;
  inversion_total: number;
  catorcenas: DesgloseCatorcena[];
}

/**
 * Arma el desglose vivo del APS con el formato del listado con APS:
 * agrupa por catorcena, dentro plaza+formato, dentro articulos. Se usa
 * en el modal de desposteo para complementar el snapshot historico.
 */
export async function armarDesgloseAps(
  campaniaId: number,
  aps: number,
): Promise<DesgloseAps | null> {
  const campania = await prisma.campania.findFirst({
    where: { id: campaniaId },
    select: { id: true, nombre: true, cliente_id: true },
  });
  if (!campania) return null;

  const cliente = await prisma.cliente.findFirst({
    where: { id: campania.cliente_id },
    select: { T0_U_Cliente: true, T0_U_RazonSocial: true },
  });

  const postLog = await prisma.campania_post_log.findFirst({
    where: { campania_id: campaniaId, aps, success: true },
    orderBy: { id: 'desc' },
    select: {
      id: true, posted_at: true, doc_entry: true, doc_num: true,
      razon_social: true, cliente_nombre: true, solicitud_caras_ids: true,
      cuic: true, marca: true,
    },
  });

  // Fuente: las RESERVAS del APS, no el post_log. Ver getCircuitosDeAps().
  const rows = await getCircuitosDeAps(campaniaId, aps);

  const cats = await prisma.catorcenas.findMany({
    select: { a_o: true, numero_catorcena: true, fecha_inicio: true, fecha_fin: true },
  });
  const catFor = (fecha: Date | null) => {
    if (!fecha) return { numero: null, anio: null, inicio: null };
    const m = cats.find(cc => fecha >= cc.fecha_inicio && fecha <= cc.fecha_fin);
    return m
      ? { numero: m.numero_catorcena, anio: m.a_o, inicio: m.fecha_inicio.toISOString().slice(0, 10) }
      : { numero: null, anio: null, inicio: fecha.toISOString().slice(0, 10) };
  };

  // Agrupar por catorcena -> plaza+formato -> articulos
  type KeyCat = string; // `${anio}-${numero}`
  const catorcenas = new Map<KeyCat, DesgloseCatorcena>();

  for (const r of rows) {
    const c = catFor(r.inicio_periodo || null);
    const keyCat: KeyCat = `${c.anio}-${c.numero}`;
    let bloqueCat = catorcenas.get(keyCat);
    if (!bloqueCat) {
      bloqueCat = {
        numero: c.numero,
        anio: c.anio,
        inicio_periodo: c.inicio,
        caras_total: 0,
        inversion_total: 0,
        plazas: [],
      };
      catorcenas.set(keyCat, bloqueCat);
    }

    const plazaKey = `${r.ciudad || '—'}||${r.formato || '—'}`;
    let bloquePlaza = bloqueCat.plazas.find(p =>
      p.plaza === (r.ciudad || '—') && p.formato === (r.formato || '—'));
    if (!bloquePlaza) {
      bloquePlaza = {
        plaza: r.ciudad || '—',
        formato: r.formato || '—',
        caras_total: 0,
        inversion_total: 0,
        articulos: [],
      };
      bloqueCat.plazas.push(bloquePlaza);
    }
    void plazaKey;

    const caras = Number(r.caras || 0);
    const tarifa = Number(r.tarifa_publica || 0);
    const costo = Number(r.costo || 0);
    const inversion = tarifa * caras;

    bloquePlaza.articulos.push({
      id: r.id,
      articulo: r.articulo || null,
      grupo_masivo_id: r.grupo_masivo_id ?? null,
      tipo: r.tipo || null,
      caras,
      tarifa_publica: tarifa,
      inversion,
      costo,
    });
    bloquePlaza.caras_total += caras;
    bloquePlaza.inversion_total += inversion;
    bloqueCat.caras_total += caras;
    bloqueCat.inversion_total += inversion;
  }

  const catorcenasArr = Array.from(catorcenas.values()).sort((a, b) => {
    if ((a.anio || 0) !== (b.anio || 0)) return (a.anio || 0) - (b.anio || 0);
    return (a.numero || 0) - (b.numero || 0);
  });

  const carasTotal = catorcenasArr.reduce((s, c) => s + c.caras_total, 0);
  const inversionTotal = catorcenasArr.reduce((s, c) => s + c.inversion_total, 0);

  return {
    campania_id: campaniaId,
    campania_nombre: campania.nombre,
    aps,
    razon_social: postLog?.razon_social || cliente?.T0_U_RazonSocial || null,
    cliente_nombre: postLog?.cliente_nombre || cliente?.T0_U_Cliente || null,
    cuic: postLog?.cuic || null,
    marca: postLog?.marca || null,
    post_log_id: postLog?.id ?? null,
    posted_at: postLog?.posted_at ? postLog.posted_at.toISOString() : null,
    doc_entry: postLog?.doc_entry ?? null,
    doc_num: postLog?.doc_num ?? null,
    caras_total: carasTotal,
    inversion_total: inversionTotal,
    catorcenas: catorcenasArr,
  };
}

// ─── Helpers internos ────────────────────────────────────────────────────

export interface CircuitoDeAps {
  id: number;
  articulo: string | null;
  formato: string | null;
  ciudad: string | null;
  costo: unknown;
  caras: unknown;
  tarifa_publica: unknown;
  tipo: string | null;
  inicio_periodo: Date | null;
  grupo_masivo_id: number | null;
}

/**
 * Circuitos que componen un APS, sacados de las RESERVAS.
 *
 * Por qué no se usa `campania_post_log.solicitud_caras_ids` (que era la fuente
 * original): ese log lo escribe el FRONT al postear, así que los APS marcados
 * con `mark-posted-aps`, o posteados antes de que existiera la bitácora, no
 * tienen fila. Cuando faltaba, el desglose salía vacío y el modal mostraba
 * "Monto estimado $0.00" — el bug que reportó Jos el 2026-09-17. No era un
 * error de cálculo: no había de dónde sacar los datos.
 *
 * Este es el mismo camino que usa el listado con APS de la campaña
 * (`getInventarioConAPS` en campanas.controller.ts), que no depende del log:
 *   solicitudCaras -> reservas -> espacio_inventario -> inventarios
 *
 * Dos detalles que corrigen de paso el monto:
 *  - `caras` es `COUNT(DISTINCT rsv.id)` de ESE APS, no `sc.caras`. `sc.caras`
 *    es el total del circuito, así que inflaba el monto cuando un circuito se
 *    reparte entre varios APS.
 *  - la tarifa cae a la del inventario si el circuito no trae
 *    `tarifa_publica` (columna con default 0), que era el otro motivo por el
 *    que la inversión salía en cero.
 */
/**
 * Asesora(s) y analista(s) ligadas a una campaña.
 *
 * Feedback 2026-09-17 (Jos): cuando TI cancela el POST hay que avisarle a la
 * analista y a la asesora de la campaña. Antes `cerrarPorEjecucion` solo
 * notificaba al solicitante, al gerente del filtro y a facturación, así que si
 * la solicitud la había iniciado otra persona, la asesora dueña de la campaña
 * se enteraba de que le cancelaron el POST por fuera del sistema.
 *
 * Camino: campania -> cotizacion -> propuesta -> solicitud. Se juntan el
 * creador de la solicitud y los asignados de propuesta y solicitud (ambos CSV),
 * y se filtran por ROL para quedarse solo con asesores y analistas — si no, se
 * notificaría también a tráfico, diseño y quien más viva en esos campos.
 */
async function getAsesorYAnalistaDeCampania(campaniaId: number): Promise<ActorInfo[]> {
  const rows = await prisma.$queryRawUnsafe<{ ids: string | null }[]>(
    `SELECT CONCAT_WS(',',
              NULLIF(CAST(s.usuario_id AS CHAR), ''),
              NULLIF(pr.id_asignado, ''),
              NULLIF(s.id_asignado, '')
            ) AS ids
     FROM campania cm
       INNER JOIN cotizacion ct ON ct.id = cm.cotizacion_id
       INNER JOIN propuesta pr  ON pr.id = ct.id_propuesta
       LEFT  JOIN solicitud s   ON s.id = pr.solicitud_id
     WHERE cm.id = ?`,
    campaniaId
  );

  const ids = [...new Set(
    (rows[0]?.ids || '')
      .split(',')
      .map(t => Number(String(t).trim()))
      .filter(n => Number.isFinite(n) && n > 0)
  )];
  if (ids.length === 0) return [];

  const usuarios = await prisma.usuario.findMany({
    where: { id: { in: ids }, deleted_at: null },
    select: { id: true, nombre: true, user_role: true },
  });

  return usuarios
    .filter(u => rolEnLista(u.user_role, [...ASESOR_ROLES, ...ANALISTA_ROLES]))
    .map(u => ({ id: u.id, nombre: u.nombre }));
}

async function getCircuitosDeAps(campaniaId: number, aps: number): Promise<CircuitoDeAps[]> {
  return await prisma.$queryRawUnsafe<CircuitoDeAps[]>(
    `SELECT
       sc.id                                   AS id,
       MAX(sc.articulo)                        AS articulo,
       MAX(sc.formato)                         AS formato,
       COALESCE(MAX(sc.ciudad), MIN(i.plaza))  AS ciudad,
       MAX(sc.costo)                           AS costo,
       CAST(COUNT(DISTINCT rsv.id) AS SIGNED)  AS caras,
       COALESCE(MAX(sc.tarifa_publica), MIN(i.tarifa_publica), 0) AS tarifa_publica,
       MAX(sc.tipo)                            AS tipo,
       MAX(sc.inicio_periodo)                  AS inicio_periodo,
       MAX(sc.grupo_masivo_id)                 AS grupo_masivo_id
     FROM campania cm
       INNER JOIN cotizacion ct         ON ct.id = cm.cotizacion_id
       INNER JOIN solicitudCaras sc     ON sc.idquote = CAST(ct.id_propuesta AS CHAR)
       INNER JOIN reservas rsv          ON rsv.solicitudCaras_id = sc.id AND rsv.deleted_at IS NULL
       -- LEFT y no INNER a proposito: hay reservas cuyo inventario_id no
       -- resuelve a espacio_inventario (APS 81604 de la campana 80596 en
       -- PRUEBAS es un caso real). Con INNER esas reservas se caian del
       -- conteo y el APS volvia a salir en $0.00 — el mismo sintoma que
       -- este fix vino a corregir, por otra via. La tarifa cae entonces a
       -- sc.tarifa_publica via el COALESCE de arriba.
       LEFT JOIN espacio_inventario ep  ON ep.id = rsv.inventario_id
       LEFT JOIN inventarios i          ON i.id = ep.inventario_id
     WHERE cm.id = ? AND rsv.APS = ?
     GROUP BY sc.id`,
    campaniaId, aps
  );
}

function ahoraMx(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
}

function fechaFinDias(dias: number): Date {
  const f = ahoraMx();
  f.setDate(f.getDate() + dias);
  return f;
}

async function agregarNota(
  desposteoId: number,
  actor: ActorInfo,
  tipo: TipoNota,
  nota: string,
): Promise<void> {
  await prisma.desposteo_notas.create({
    data: {
      desposteo_id: desposteoId,
      usuario_id: actor.id,
      usuario_nombre: actor.nombre,
      tipo,
      nota,
    },
  });
}

interface CrearTareaInput {
  tipo: string;
  titulo: string;
  descripcion: string;
  responsable: ActorInfo;
  asignados: ActorInfo[];
  campaniaId: number;
  desposteoId: number;
}

/**
 * Cierra automaticamente las tareas del flujo desposteo asociadas a una
 * solicitud cuando el usuario ejecuta la accion desde el modal. Antes
 * quedaban en Pendiente aunque el modal ya no aceptara mas acciones.
 * - tipo: 'Filtro Desposteo' (gerente) o 'Autorización Desposteo' (facturacion)
 * - resultado: 'Atendido' cuando se aprobo / ejecuto, 'Rechazado' cuando se rechazo
 */
async function resolverTareasDesposteo(
  desposteoId: number,
  tipo: 'Filtro Desposteo' | 'Autorización Desposteo',
  resultado: 'Atendido' | 'Rechazado',
): Promise<void> {
  // El json de contenido guarda { "desposteoId": N }. Buscar coincidencia por
  // texto es suficiente para no depender de JSON functions del driver.
  const tareas = await prisma.tareas.findMany({
    where: {
      tipo,
      estatus: 'Pendiente',
      contenido: { contains: `"desposteoId":${desposteoId}` },
    },
    select: { id: true },
  });
  if (tareas.length === 0) return;
  await prisma.tareas.updateMany({
    where: { id: { in: tareas.map(t => t.id) } },
    data: { estatus: resultado },
  });
}

async function crearTareaDesposteo(input: CrearTareaInput): Promise<void> {
  const now = ahoraMx();
  await prisma.tareas.create({
    data: {
      tipo: input.tipo,
      titulo: input.titulo,
      descripcion: input.descripcion,
      estatus: 'Pendiente',
      id_responsable: input.responsable.id,
      responsable: input.responsable.nombre,
      id_solicitud: '',
      id_propuesta: null,
      campania_id: input.campaniaId,
      id_asignado: input.asignados.map(a => a.id).join(','),
      asignado: input.asignados.map(a => a.nombre).join(', '),
      contenido: JSON.stringify({ desposteoId: input.desposteoId }),
      fecha_inicio: now,
      fecha_fin: fechaFinDias(7),
    },
  });
}

async function notificarUsuarios(
  destinatarios: ActorInfo[],
  campaniaId: number,
  desposteoId: number,
  titulo: string,
  mensaje: string,
): Promise<void> {
  if (destinatarios.length === 0) return;
  // Dedup por id antes de crear filas (varias transiciones agregan al asesor
  // + GC + facturacion y si algun equipo se sobrepone hay repetidos).
  const seen = new Set<number>();
  const dedup: ActorInfo[] = [];
  for (const d of destinatarios) {
    if (!d || !d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    dedup.push(d);
  }
  // Opt-out por preferencias de usuario (canal=popup, categoria=desposteo).
  // Si alguien apago el master global o especificamente 'desposteo' no lo
  // molestamos con la notificacion; el registro en historial si queda.
  const activos = await filtrarPorPreferenciasNotif(dedup, {
    canal: 'popup',
    clase: 'notificacion',
    clave: 'desposteo',
  });
  if (activos.length === 0) return;
  const now = ahoraMx();
  await prisma.$transaction(
    activos.map(u =>
      prisma.tareas.create({
        data: {
          tipo: 'Notificación',
          categoria: 'desposteo',
          titulo,
          descripcion: mensaje,
          estatus: 'Pendiente',
          id_responsable: u.id,
          responsable: u.nombre,
          id_solicitud: '',
          id_propuesta: null,
          campania_id: campaniaId,
          id_asignado: String(u.id),
          asignado: u.nombre,
          contenido: JSON.stringify({ desposteoId }),
          fecha_inicio: now,
          fecha_fin: fechaFinDias(7),
        },
      })
    )
  );
  // Emitir un solo evento socket para que los conectados hagan refetch de sus
  // notificaciones. Como no hay canal por-usuario en el socket actual, mandamos
  // el evento global (que ya se usa en otros puntos del flujo).
  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: desposteoId, tipo: 'Notificación', campaniaId, categoria: 'desposteo',
    });
  } catch (e) {
    console.error('[desposteo.notificarUsuarios] emitToAll:', e);
  }
}

// Resuelve los destinatarios "de la campana" para las alertas de desposteo:
//   1. Los usuarios asignados a la propuesta origen (propuesta.id_asignado
//      es CSV de user IDs). Es la fuente de verdad de "quien trabaja esta
//      campana".
//   2. Para cada asignado: su gerente comercial (via equipos filtro_desposteo
//      / filtro_autorizacion).
//   3. Si el asignado es analista, tambien se agrega el asesor titular de su
//      red_trabajo — el analista suele operar en nombre del asesor.
//   4. (opcional, gated por opts.incluirRedTrabajo) miembros del red_trabajo
//      de cada asignado, para avisar al equipo cercano.
//
// Devuelve una lista deduplicada por id, sin filtrar por preferencias —
// eso lo hace notificarUsuarios al final.
async function resolverDestinatariosCampana(
  campaniaId: number,
  opts: { incluirRedTrabajo?: boolean } = {},
): Promise<ActorInfo[]> {
  // 1. Bajar de campania -> cotizacion -> propuesta.id_asignado.
  const campania = await prisma.campania.findFirst({
    where: { id: campaniaId },
    select: { cotizacion_id: true },
  });
  if (!campania?.cotizacion_id) return [];
  const cot = await prisma.cotizacion.findFirst({
    where: { id: campania.cotizacion_id },
    select: { id_propuesta: true },
  });
  if (!cot?.id_propuesta) return [];
  const prop = await prisma.propuesta.findFirst({
    where: { id: cot.id_propuesta, deleted_at: null },
    select: { id_asignado: true },
  });
  if (!prop?.id_asignado) return [];

  const asignadosIds = String(prop.id_asignado)
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);
  if (asignadosIds.length === 0) return [];

  // 2. Cargar datos de los asignados (nombre + rol).
  const asignados = await prisma.usuario.findMany({
    where: { id: { in: asignadosIds }, deleted_at: null },
    select: { id: true, nombre: true, user_role: true },
  });

  const acumulador = new Map<number, ActorInfo>();
  for (const a of asignados) {
    acumulador.set(a.id, { id: a.id, nombre: a.nombre });
  }

  // 3. Por cada asignado, resolver su GC + asesor (si es analista).
  for (const a of asignados) {
    if (esRolAnalista(a.user_role)) {
      const asesor = await getAsesorParaAnalista(a.id);
      if (asesor && !acumulador.has(asesor.id)) {
        acumulador.set(asesor.id, { id: asesor.id, nombre: asesor.nombre });
      }
      // GC del asesor titular del analista.
      if (asesor) {
        const gc = await getGerenteDesposteoParaAsesor(asesor.id);
        if (gc && !acumulador.has(gc.id)) acumulador.set(gc.id, gc);
      }
    } else if (esRolAsesor(a.user_role) || puedeBypassearDesposteo(a.user_role)) {
      const gc = await getGerenteDesposteoParaAsesor(a.id);
      if (gc && !acumulador.has(gc.id)) acumulador.set(gc.id, gc);
    }
  }

  // 4. (opt) Miembros del red_trabajo de cada asignado.
  if (opts.incluirRedTrabajo) {
    for (const a of asignados) {
      const equipos = await prisma.usuario_equipo.findMany({
        where: {
          usuario_id: a.id,
          equipo: { deleted_at: null, proposito: 'red_trabajo' },
        },
        select: { equipo_id: true },
      });
      if (equipos.length === 0) continue;
      const equipoIds = equipos.map(e => e.equipo_id);
      const miembros = await prisma.usuario_equipo.findMany({
        where: { equipo_id: { in: equipoIds }, usuario: { deleted_at: null } },
        include: { usuario: { select: { id: true, nombre: true } } },
      });
      for (const m of miembros) {
        if (m.usuario && !acumulador.has(m.usuario.id)) {
          acumulador.set(m.usuario.id, { id: m.usuario.id, nombre: m.usuario.nombre });
        }
      }
    }
  }

  return Array.from(acumulador.values());
}

// ─── Crear solicitud ─────────────────────────────────────────────────────

export interface CrearInput {
  campaniaId: number;
  aps: number;
  nota: string;
  asesor: ActorInfo;
  rol?: string | null;
}

export async function crearSolicitudDesposteo(input: CrearInput) {
  const { campaniaId, aps, nota, asesor, rol } = input;
  const notaLimpia = (nota || '').trim();
  if (!notaLimpia) throw new Error('La nota es obligatoria al iniciar el flujo');

  // Bloquear duplicados: si ya hay una solicitud "en vuelo" (no terminal)
  // para el mismo (campania, aps), no permitir otra.
  const enVuelo = await prisma.desposteo_solicitudes.findFirst({
    where: {
      campania_id: campaniaId,
      aps,
      deleted_at: null,
      estatus: { in: ['solicitado', 'filtro_aprobado', 'aprobado'] },
    },
    select: { id: true, estatus: true },
  });
  if (enVuelo) {
    throw new Error(
      `Ya existe una solicitud activa #${enVuelo.id} (estatus: ${enVuelo.estatus}) para APS ${aps} de la campana #${campaniaId}. Espera a que se cierre para iniciar otra.`
    );
  }

  const { snapshot, postLogId } = await armarSnapshot(campaniaId, aps);

  // Analistas resuelven GC via su asesor en red_trabajo; asesores directo.
  const gc = await getGerenteDesposteoParaUsuario(asesor.id, rol);

  // Sin gerente NO se crea la solicitud.
  //
  // Antes esto solo hacia console.warn y seguia: la solicitud nacia sin tarea
  // de filtro, asi que NADIE se enteraba, y encima el guard de duplicados de
  // arriba bloqueaba cualquier reintento para ese (campania, aps). El asesor
  // quedaba convencido de que ya la habia mandado y el APS atorado para
  // siempre. Al prender el flujo (2026-09-17) esto pasaba de ser un riesgo
  // teorico a una trampa real, asi que mejor fallar aqui, sin escribir nada,
  // con un mensaje que diga que hay que arreglar.
  if (!gc) {
    const quien = esRolAnalista(rol) ? 'del asesor al que estas asignada' : 'tuyo';
    throw new Error(
      `No se encontro el gerente comercial ${quien} para autorizar el desposteo. `
      + `Pide a TI que te agregue a un equipo con proposito 'filtro_desposteo' o 'filtro_autorizacion' que tenga un Gerente Comercial.`
    );
  }

  const solicitud = await prisma.desposteo_solicitudes.create({
    data: {
      campania_id: campaniaId,
      aps,
      post_log_id: postLogId,
      snapshot_aps: JSON.stringify(snapshot),
      estatus: 'solicitado',
      solicitado_por_id: asesor.id,
      solicitado_por_nombre: asesor.nombre,
    },
  });

  await agregarNota(solicitud.id, asesor, 'inicio', notaLimpia);

  await crearTareaDesposteo({
    tipo: 'Filtro Desposteo',
    titulo: `Filtro desposteo APS ${aps} - ${snapshot.campania_nombre}`,
    descripcion:
      `${asesor.nombre} solicito el desposteo del APS ${aps} de la campana "${snapshot.campania_nombre}"` +
      (snapshot.razon_social ? ` (${snapshot.razon_social})` : '') +
      `. Monto estimado $${snapshot.monto_estimado.toFixed(2)}. Da tu check o rechaza con motivo.`,
    responsable: gc,
    asignados: [gc],
    campaniaId,
    desposteoId: solicitud.id,
  });

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: campaniaId,
      accion: `Solicito desposteo APS ${aps} (solicitud #${solicitud.id})`,
      usuario: asesor.nombre,
      usuarioId: asesor.id,
      origen: 'desposteo',
      extras: { desposteoId: solicitud.id, aps, postLogId, estatus: 'solicitado' },
    });
  } catch (e) {
    console.error('[desposteo.crear] logHistorial fallo:', e);
  }

  // Notificar al equipo de la campana ademas del GC que recibe la tarea:
  // asignados + sus GCs + asesor titular (si es analista). Es la que abre el
  // ticket, entonces conviene que el resto del equipo se entere.
  try {
    const dest = await resolverDestinatariosCampana(campaniaId);
    // Excluir al propio solicitante (ya sabe que la abrio) y al GC (ya tiene tarea).
    const filtrado = dest.filter(u => u.id !== asesor.id && (!gc || u.id !== gc.id));
    await notificarUsuarios(
      filtrado,
      campaniaId,
      solicitud.id,
      `Se inicio desposteo - APS ${aps}`,
      `${asesor.nombre} solicito el desposteo del APS ${aps} de "${snapshot.campania_nombre}". Nota: ${notaLimpia}`,
    );
  } catch (e) {
    console.error('[desposteo.crear] notificar equipo campana:', e);
  }

  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: solicitud.id,
      tipo: 'Filtro Desposteo',
      campaniaId,
      aps,
    });
  } catch (e) {
    console.error('[desposteo.crear] emitToAll fallo:', e);
  }

  return solicitud;
}

// ─── Filtro GC ───────────────────────────────────────────────────────────

async function requireSolicitud(id: number) {
  const s = await prisma.desposteo_solicitudes.findFirst({
    where: { id, deleted_at: null },
  });
  if (!s) throw new Error(`Solicitud desposteo #${id} no encontrada`);
  return s;
}

export async function aprobarFiltroGerente(id: number, gc: ActorInfo, nota?: string | null) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'solicitado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'solicitado' (actual: ${s.estatus})`);
  }

  // Guard: sin destinatario en Facturacion el flujo queda huerfano (bug historico:
  // solicitud avanzaba a filtro_aprobado y ninguna tarea se creaba).
  const facturacion = await getUsuariosFacturacion();
  if (facturacion.length === 0) {
    throw new Error(
      'No hay usuarios activos con rol "Coordinador de Facturación" o "Coordinador de Facturación y Cobranza". ' +
      'Pide a soporte dar de alta a un usuario con ese rol antes de aprobar.'
    );
  }

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'filtro_aprobado',
      filtro_gc_id: gc.id,
      filtro_gc_nombre: gc.nombre,
      filtro_gc_at: ahoraMx(),
    },
  });

  await agregarNota(id, gc, 'aprobacion_gerente', (nota || '').trim() || 'Check gerente comercial');

  // Cierra la tarea Filtro Desposteo del gerente para que no quede huerfana.
  await resolverTareasDesposteo(id, 'Filtro Desposteo', 'Atendido');

  const snapshot = parseSnapshot(s.snapshot_aps);
  await crearTareaDesposteo({
    tipo: 'Autorización Desposteo',
    titulo: `Autorizacion desposteo APS ${s.aps} - ${snapshot?.campania_nombre || `campana #${s.campania_id}`}`,
    descripcion:
      `${gc.nombre} aprobo el filtro para desposteo del APS ${s.aps}. ` +
      (snapshot?.razon_social ? `Cliente: ${snapshot.razon_social}. ` : '') +
      `Monto $${(snapshot?.monto_estimado || 0).toFixed(2)}. ` +
      `Aprueba o rechaza con motivo.`,
    responsable: facturacion[0],
    asignados: facturacion,
    campaniaId: s.campania_id,
    desposteoId: id,
  });

  try {
    emitToAll(SOCKET_EVENTS.NOTIFICACION_NUEVA, {
      tareaId: id, tipo: 'Autorización Desposteo', campaniaId: s.campania_id, aps: s.aps,
    });
  } catch (e) { console.error('[desposteo.aprobarFiltroGerente] emitToAll:', e); }

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: s.campania_id,
      accion: `Filtro GC aprobo desposteo APS ${s.aps} (solicitud #${id})`,
      usuario: gc.nombre,
      usuarioId: gc.id,
      origen: 'desposteo',
      extras: { desposteoId: id, aps: s.aps, estatus: 'filtro_aprobado' },
    });
  } catch (e) {
    console.error('[desposteo.aprobarFiltroGerente] logHistorial:', e);
  }

  // Notificar al equipo de la campana: el asesor solicitante + sus companeros
  // (asignados a la propuesta) para que sepan que avanzo. Facturacion ya tiene
  // tarea explicita, no la duplicamos aca.
  try {
    const equipo = await resolverDestinatariosCampana(s.campania_id);
    const solicitante: ActorInfo = { id: s.solicitado_por_id, nombre: s.solicitado_por_nombre };
    const dest = [solicitante, ...equipo].filter(u => u.id !== gc.id);
    await notificarUsuarios(
      dest,
      s.campania_id,
      id,
      `Filtro GC aprobado - APS ${s.aps}`,
      `${gc.nombre} aprobo el filtro para el desposteo del APS ${s.aps}. Ya paso a facturacion.`,
    );
  } catch (e) {
    console.error('[desposteo.aprobarFiltroGerente] notificar equipo:', e);
  }

  return upd;
}

export async function rechazarFiltroGerente(id: number, gc: ActorInfo, nota: string) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'solicitado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'solicitado' (actual: ${s.estatus})`);
  }
  const notaLimpia = (nota || '').trim();
  if (!notaLimpia) throw new Error('La nota es obligatoria al rechazar');

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'rechazado',
      filtro_gc_id: gc.id,
      filtro_gc_nombre: gc.nombre,
      filtro_gc_at: ahoraMx(),
    },
  });

  await agregarNota(id, gc, 'rechazo_gerente', notaLimpia);

  await resolverTareasDesposteo(id, 'Filtro Desposteo', 'Rechazado');

  // Notificar al solicitante + al equipo asignado a la campana (el rechazo
  // afecta a todos, no solo al que abrio).
  const equipoRechFiltro = await resolverDestinatariosCampana(s.campania_id).catch(() => [] as ActorInfo[]);
  const destRechFiltro = [
    { id: s.solicitado_por_id, nombre: s.solicitado_por_nombre } as ActorInfo,
    ...equipoRechFiltro,
  ].filter(u => u.id !== gc.id);
  await notificarUsuarios(
    destRechFiltro,
    s.campania_id,
    id,
    `Desposteo rechazado por gerente - APS ${s.aps}`,
    `${gc.nombre} rechazo el desposteo del APS ${s.aps}. Motivo: ${notaLimpia}`,
  );

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: s.campania_id,
      accion: `Filtro GC rechazo desposteo APS ${s.aps} (solicitud #${id})`,
      usuario: gc.nombre,
      usuarioId: gc.id,
      origen: 'desposteo',
      extras: { desposteoId: id, aps: s.aps, estatus: 'rechazado', motivo: notaLimpia },
    });
  } catch (e) {
    console.error('[desposteo.rechazarFiltroGerente] logHistorial:', e);
  }

  return upd;
}

// ─── Facturacion ─────────────────────────────────────────────────────────

export async function aprobarFacturacion(id: number, actor: ActorInfo, nota?: string | null) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'filtro_aprobado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'filtro_aprobado' (actual: ${s.estatus})`);
  }

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'aprobado',
      facturacion_id: actor.id,
      facturacion_nombre: actor.nombre,
      facturacion_at: ahoraMx(),
    },
  });

  await agregarNota(id, actor, 'aprobacion_facturacion', (nota || '').trim() || 'Aprobado por facturacion');

  await resolverTareasDesposteo(id, 'Autorización Desposteo', 'Atendido');

  // Notificar a TI que hay solicitud aprobada pendiente de ejecutar.
  const ti = await getUsuariosTI();
  const snap = parseSnapshot(s.snapshot_aps);
  await notificarUsuarios(
    ti,
    s.campania_id,
    id,
    `Desposteo aprobado listo para ejecutar - APS ${s.aps}`,
    `Solicitud #${id} aprobada por ${actor.nombre}. ` +
      `Ya puedes cancelar el POST a SAP del APS ${s.aps} en la campana ${snap?.campania_nombre || `#${s.campania_id}`} desde el detalle de campana.`,
  );

  // Tambien avisar al asesor + GC + equipo de la campana que su solicitud
  // avanzo. Facturacion (actor) queda fuera para no auto-notificarse.
  const equipoAprFact = await resolverDestinatariosCampana(s.campania_id).catch(() => [] as ActorInfo[]);
  const otros: ActorInfo[] = [
    { id: s.solicitado_por_id, nombre: s.solicitado_por_nombre },
    ...equipoAprFact,
  ];
  if (s.filtro_gc_id && s.filtro_gc_nombre) {
    otros.push({ id: s.filtro_gc_id, nombre: s.filtro_gc_nombre });
  }
  await notificarUsuarios(
    otros.filter(u => u.id !== actor.id),
    s.campania_id,
    id,
    `Desposteo aprobado por facturacion - APS ${s.aps}`,
    `${actor.nombre} aprobo el desposteo. TI proximamente lo ejecutara.`,
  );

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: s.campania_id,
      accion: `Facturacion aprobo desposteo APS ${s.aps} (solicitud #${id})`,
      usuario: actor.nombre,
      usuarioId: actor.id,
      origen: 'desposteo',
      extras: { desposteoId: id, aps: s.aps, estatus: 'aprobado' },
    });
  } catch (e) {
    console.error('[desposteo.aprobarFacturacion] logHistorial:', e);
  }

  return upd;
}

export async function rechazarFacturacion(id: number, actor: ActorInfo, nota: string) {
  const s = await requireSolicitud(id);
  if (s.estatus !== 'filtro_aprobado') {
    throw new Error(`Solicitud #${id} no esta en estatus 'filtro_aprobado' (actual: ${s.estatus})`);
  }
  const notaLimpia = (nota || '').trim();
  if (!notaLimpia) throw new Error('La nota es obligatoria al rechazar');

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id },
    data: {
      estatus: 'rechazado',
      facturacion_id: actor.id,
      facturacion_nombre: actor.nombre,
      facturacion_at: ahoraMx(),
    },
  });

  await agregarNota(id, actor, 'rechazo_facturacion', notaLimpia);

  await resolverTareasDesposteo(id, 'Autorización Desposteo', 'Rechazado');

  const equipoRechFact = await resolverDestinatariosCampana(s.campania_id).catch(() => [] as ActorInfo[]);
  const otros: ActorInfo[] = [
    { id: s.solicitado_por_id, nombre: s.solicitado_por_nombre },
    ...equipoRechFact,
  ];
  if (s.filtro_gc_id && s.filtro_gc_nombre) {
    otros.push({ id: s.filtro_gc_id, nombre: s.filtro_gc_nombre });
  }
  await notificarUsuarios(
    otros.filter(u => u.id !== actor.id),
    s.campania_id,
    id,
    `Desposteo rechazado por facturacion - APS ${s.aps}`,
    `${actor.nombre} rechazo el desposteo. Motivo: ${notaLimpia}`,
  );

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: s.campania_id,
      accion: `Facturacion rechazo desposteo APS ${s.aps} (solicitud #${id})`,
      usuario: actor.nombre,
      usuarioId: actor.id,
      origen: 'desposteo',
      extras: { desposteoId: id, aps: s.aps, estatus: 'rechazado', motivo: notaLimpia },
    });
  } catch (e) {
    console.error('[desposteo.rechazarFacturacion] logHistorial:', e);
  }

  return upd;
}

// ─── TI / cierre por ejecucion ───────────────────────────────────────────

/**
 * Verifica si existe una solicitud aprobada (no ejecutada) para (campania, aps).
 * Usado por unmarkPostedAPS antes de permitir la cancelacion.
 */
export async function verificarAutorizacionEjecucion(
  campaniaId: number,
  aps: number,
): Promise<{ ok: true; solicitudId: number } | { ok: false; motivo: string }> {
  const s = await prisma.desposteo_solicitudes.findFirst({
    where: {
      campania_id: campaniaId,
      aps,
      deleted_at: null,
      estatus: 'aprobado',
    },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  if (!s) {
    return {
      ok: false,
      motivo: `No hay solicitud de desposteo aprobada para el APS ${aps} de la campana #${campaniaId}. Pide autorizacion primero (Comercial - Filtro Gerente - Facturacion).`,
    };
  }
  return { ok: true, solicitudId: s.id };
}

/**
 * Cierra una solicitud aprobada marcando la ejecucion. Se llama desde
 * unmarkPostedAPS cuando TI cancela el POST exitosamente.
 */
export async function cerrarPorEjecucion(
  solicitudId: number,
  ti: ActorInfo,
  notaAdicional?: string | null,
) {
  const s = await requireSolicitud(solicitudId);
  if (s.estatus !== 'aprobado') {
    console.warn(
      `[desposteo.cerrarPorEjecucion] Solicitud #${solicitudId} en estatus '${s.estatus}' (esperado 'aprobado'). No se cierra pero se registra ejecucion.`
    );
  }

  const upd = await prisma.desposteo_solicitudes.update({
    where: { id: solicitudId },
    data: {
      estatus: 'ejecutado',
      ti_ejecutor_id: ti.id,
      ti_ejecutor_nombre: ti.nombre,
      ti_ejecutor_at: ahoraMx(),
    },
  });

  await agregarNota(
    solicitudId,
    ti,
    'ejecucion',
    (notaAdicional || '').trim() || `Desposteo ejecutado en SAP por ${ti.nombre}`,
  );

  const equipoEjec = await resolverDestinatariosCampana(s.campania_id).catch(() => [] as ActorInfo[]);
  const dest: ActorInfo[] = [
    { id: s.solicitado_por_id, nombre: s.solicitado_por_nombre },
    ...equipoEjec,
  ];
  if (s.filtro_gc_id && s.filtro_gc_nombre) {
    dest.push({ id: s.filtro_gc_id, nombre: s.filtro_gc_nombre });
  }
  if (s.facturacion_id && s.facturacion_nombre) {
    dest.push({ id: s.facturacion_id, nombre: s.facturacion_nombre });
  }
  // Asesora y analista de la campana (feedback 2026-09-17, Jos): aunque no
  // hayan iniciado la solicitud, es SU campana la que se queda sin POST.
  // Best-effort: si la consulta falla no se cae la ejecucion, que ya ocurrio.
  try {
    dest.push(...await getAsesorYAnalistaDeCampania(s.campania_id));
  } catch (e) {
    console.error('[desposteo.cerrarPorEjecucion] no se pudo resolver asesora/analista:', e);
  }
  // Dedup: el solicitante suele ser tambien la asesora o la analista.
  const vistos = new Set<number>();
  const destUnicos = dest.filter(d => (vistos.has(d.id) ? false : (vistos.add(d.id), true)));

  await notificarUsuarios(
    destUnicos.filter(u => u.id !== ti.id),
    s.campania_id,
    solicitudId,
    `POST cancelado - APS ${s.aps}`,
    `${ti.nombre} cancelo el POST del APS ${s.aps} en SAP.`,
  );

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: s.campania_id,
      accion: `TI ejecuto desposteo APS ${s.aps} (solicitud #${solicitudId})`,
      usuario: ti.nombre,
      usuarioId: ti.id,
      origen: 'desposteo',
      extras: { desposteoId: solicitudId, aps: s.aps, estatus: 'ejecutado' },
    });
  } catch (e) {
    console.error('[desposteo.cerrarPorEjecucion] logHistorial:', e);
  }

  return upd;
}

/**
 * Registra un desposteo ejecutado SIN solicitud previa (bypass DEV/Admin).
 * Crea la fila con sin_autorizacion=true y estatus='ejecutado' para dejar
 * rastro en la auditoria — nada de silenciar el bypass.
 */
export async function registrarBypass(
  campaniaId: number,
  aps: number,
  actor: ActorInfo,
  motivo: string,
) {
  const { snapshot, postLogId } = await armarSnapshot(campaniaId, aps);
  const now = ahoraMx();
  const s = await prisma.desposteo_solicitudes.create({
    data: {
      campania_id: campaniaId,
      aps,
      post_log_id: postLogId,
      snapshot_aps: JSON.stringify(snapshot),
      estatus: 'ejecutado',
      solicitado_por_id: actor.id,
      solicitado_por_nombre: actor.nombre,
      ti_ejecutor_id: actor.id,
      ti_ejecutor_nombre: actor.nombre,
      ti_ejecutor_at: now,
      sin_autorizacion: true,
    },
  });
  await agregarNota(
    s.id,
    actor,
    'ejecucion',
    `BYPASS ${actor.nombre} (${motivo || 'sin motivo especificado'}). Ejecucion sin flujo Comercial-GC-Facturacion.`,
  );

  try {
    await logHistorial({
      tipo: 'Desposteo',
      refId: campaniaId,
      accion: `BYPASS ${actor.nombre} ejecuto desposteo APS ${aps} sin flujo (solicitud #${s.id})`,
      usuario: actor.nombre,
      usuarioId: actor.id,
      origen: 'desposteo',
      extras: { desposteoId: s.id, aps, estatus: 'ejecutado', sin_autorizacion: true, motivo: motivo || null },
    });
  } catch (e) {
    console.error('[desposteo.registrarBypass] logHistorial:', e);
  }

  // Bypass es DEV/Admin; avisamos al equipo asignado a la campana para que
  // quede claro que se salto el flujo (asesor, sus companeros y GC).
  try {
    const equipo = await resolverDestinatariosCampana(campaniaId);
    await notificarUsuarios(
      equipo.filter(u => u.id !== actor.id),
      campaniaId,
      s.id,
      `BYPASS de desposteo - APS ${aps}`,
      `${actor.nombre} (Admin/DEV) ejecuto el desposteo del APS ${aps} sin pasar por el flujo normal. Motivo: ${motivo || 'sin motivo'}`,
    );
  } catch (e) {
    console.error('[desposteo.registrarBypass] notificar equipo:', e);
  }

  return s;
}

// ─── Listar / detalle ────────────────────────────────────────────────────

export async function listarSolicitudes(params: {
  campaniaId?: number;
  estatus?: EstatusDesposteo;
  incluirEjecutados?: boolean;
}) {
  const where: any = { deleted_at: null };
  if (params.campaniaId) where.campania_id = params.campaniaId;
  if (params.estatus) where.estatus = params.estatus;
  if (!params.incluirEjecutados && !params.estatus) {
    where.estatus = { notIn: ['ejecutado'] };
  }
  return prisma.desposteo_solicitudes.findMany({
    where,
    orderBy: { id: 'desc' },
  });
}

export async function getDetalle(id: number) {
  const s = await prisma.desposteo_solicitudes.findFirst({
    where: { id, deleted_at: null },
  });
  if (!s) return null;
  // Todas las notas del hilo (campania, aps) — no solo de esta solicitud.
  // Feedback: el hilo persiste entre intentos.
  const solicitudesHermanas = await prisma.desposteo_solicitudes.findMany({
    where: {
      campania_id: s.campania_id,
      aps: s.aps,
      deleted_at: null,
    },
    select: { id: true },
  });
  const notas = await prisma.desposteo_notas.findMany({
    where: { desposteo_id: { in: solicitudesHermanas.map(x => x.id) } },
    orderBy: { created_at: 'asc' },
  });
  return { solicitud: s, notas };
}

/**
 * Estado por APS para una campaña. Utilizado por el listado con APS del
 * detalle de campaña para pintar badges: en curso / aprobado / ejecutado.
 * Devuelve solo un estado por APS — el mas avanzado no-terminal, o el
 * ultimo ejecutado si no hay activos.
 */
export type EstadoAps =
  | { estatus: 'solicitado' | 'filtro_aprobado' | 'aprobado'; solicitud_id: number }
  | { estatus: 'ejecutado'; solicitud_id: number }
  | { estatus: 'rechazado'; solicitud_id: number };
export async function getEstadosAps(campaniaId: number): Promise<Record<number, EstadoAps>> {
  const rows = await prisma.desposteo_solicitudes.findMany({
    where: { campania_id: campaniaId, deleted_at: null },
    select: { id: true, aps: true, estatus: true },
    orderBy: { id: 'desc' },
  });
  // Prioridad de estatus para "cual mostrar por APS": activo > ejecutado > rechazado
  const rank: Record<string, number> = {
    aprobado: 5, filtro_aprobado: 4, solicitado: 3, ejecutado: 2, rechazado: 1,
  };
  const out: Record<number, EstadoAps> = {};
  for (const r of rows) {
    const prev = out[r.aps];
    const curRank = rank[r.estatus] ?? 0;
    const prevRank = prev ? (rank[prev.estatus] ?? 0) : -1;
    if (curRank > prevRank) {
      out[r.aps] = { estatus: r.estatus as EstadoAps['estatus'], solicitud_id: r.id };
    }
  }
  return out;
}

/**
 * Historial de notas por (campania, aps) — para mostrar en el modal aunque
 * no exista solicitud abierta (ej. al iniciar una nueva luego de rechazo).
 */
export async function getHistorialNotas(campaniaId: number, aps: number) {
  const solicitudes = await prisma.desposteo_solicitudes.findMany({
    where: { campania_id: campaniaId, aps, deleted_at: null },
    select: { id: true },
  });
  if (solicitudes.length === 0) return [];
  return prisma.desposteo_notas.findMany({
    where: { desposteo_id: { in: solicitudes.map(x => x.id) } },
    orderBy: { created_at: 'asc' },
  });
}

// ─── Utilidades ──────────────────────────────────────────────────────────

function parseSnapshot(raw: string | null): SnapshotAPS | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as SnapshotAPS; } catch { return null; }
}

export { parseSnapshot };
export type { SnapshotAPS };
