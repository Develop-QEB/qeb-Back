// Capas de puntos de interes / poligonos KML de un circuito.
//
// Trafico arma circuitos en el Buscador de Formatos con pines (POI de Google,
// direcciones, coordenadas, KML de puntos) y poligonos KML: "Conservar con
// POIs" deja SOLO el inventario cercano/dentro; "Conservar sin POIs" deja SOLO
// el lejano/fuera. Hasta ahora eso vivia en memoria del navegador y se perdia
// al cerrar el modal. Aqui se persiste por circuito (solicitud_caras_id) para
// que la Vista Compartir (interna y publica) las muestre como capas
// activables y el cliente entienda por que el circuito quedo donde quedo.
//
// Por que solicitud_caras_id y no propuesta/campania: la Vista Compartir de
// una campaña es la MISMA pagina que la de la propuesta (todo se resuelve por
// solicitudCaras.idquote = propuesta.id), asi que anclar al circuito cubre
// ambas sin copiar nada en el pase a ventas. El modal de campaña ni siquiera
// conoce el id de propuesta: manda solo el circuito y aqui se deriva idquote.
//
// La geometria se guarda YA en el formato que consume @react-google-maps/api
// ({lat,lng}), sin mapper en ninguna punta. Los poligonos se decimán al
// guardar (no al leer) para que el mapa publico no herede el problema de
// peso de los miles de pines.
import prisma from '../utils/prisma';
import { isSpacesConfigured, uploadBufferToSpaces } from '../config/spaces';

export type ModoCapa = 'incluir' | 'excluir';
export type OrigenCapa = 'poi' | 'custom' | 'address' | 'kml' | 'mixto';

export interface PinCapa { lat: number; lng: number; name: string; range: number }
export interface PoligonoCapa { name: string; paths: { lat: number; lng: number }[] }
export interface GeometriaCapa { pines: PinCapa[]; poligonos: PoligonoCapa[] }

export interface CapaMapa {
  id: number;
  solicitud_caras_id: number;
  idquote: string;
  nombre: string;
  modo: ModoCapa;
  origen: OrigenCapa;
  geometria: GeometriaCapa;
  archivo_url: string | null;
  visible_cliente: boolean;
  total_pines: number;
  total_poligonos: number;
  creado_por: number | null;
  creado_por_nombre: string | null;
  created_at: Date;
}

export interface CrearCapaInput {
  solicitudCarasId: number;
  nombre: string;
  modo: ModoCapa;
  origen: OrigenCapa;
  geometria: GeometriaCapa;
  visibleCliente?: boolean;
  /** KML original (texto). Se sube a Spaces solo como respaldo. */
  kmlTexto?: string | null;
  kmlNombre?: string | null;
  usuarioId?: number;
  usuarioNombre?: string;
}

// Limites al guardar. Un KML de manchas urbanas puede traer decenas de miles
// de vertices; decimados a 2000 por poligono siguen viendose bien y el mapa
// publico no se arrastra.
export const MAX_VERTICES_POLIGONO = 2000;
export const MAX_PINES_CAPA = 1000;
export const MAX_POLIGONOS_CAPA = 200;
export const MAX_RANGO_PIN_M = 50_000;

const MODOS: ModoCapa[] = ['incluir', 'excluir'];
const ORIGENES: OrigenCapa[] = ['poi', 'custom', 'address', 'kml', 'mixto'];

// Cache del check de tabla. `true` es definitivo; `false` se reintenta cada
// minuto para que baste correr la migracion sin reiniciar el server.
let tablaOk: boolean | null = null;
let ultimoCheckFallido = 0;

export async function tablaCapasDisponible(): Promise<boolean> {
  if (tablaOk === true) return true;
  if (tablaOk === false && Date.now() - ultimoCheckFallido < 60_000) return false;
  try {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'capa_mapa'`
    );
    tablaOk = Number(rows[0]?.n) === 1;
  } catch {
    tablaOk = false;
  }
  if (!tablaOk) {
    ultimoCheckFallido = Date.now();
    console.warn('[capas-mapa] tabla no encontrada; correr scripts/add_tabla_capa_mapa.cjs');
  }
  return tablaOk;
}

// ---------- Validacion / normalizacion de geometria ----------

const esCoord = (p: unknown): p is { lat: number; lng: number } => {
  if (!p || typeof p !== 'object') return false;
  const { lat, lng } = p as { lat?: unknown; lng?: unknown };
  return typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
};

/** Decimacion uniforme conservando primer y ultimo vertice. */
export function decimarPath<T>(paths: T[], max: number): T[] {
  if (paths.length <= max) return paths;
  const paso = paths.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(paths[Math.floor(i * paso)]);
  if (out[out.length - 1] !== paths[paths.length - 1]) out.push(paths[paths.length - 1]);
  return out;
}

/**
 * Deja la geometria limpia y acotada. Tira con mensaje claro si viene vacia o
 * mal formada: una capa sin pines ni poligonos no sirve de nada.
 */
export function normalizarGeometria(raw: unknown): GeometriaCapa {
  const g = (raw && typeof raw === 'object' ? raw : {}) as { pines?: unknown; poligonos?: unknown };
  const pinesRaw = Array.isArray(g.pines) ? g.pines : [];
  const polisRaw = Array.isArray(g.poligonos) ? g.poligonos : [];

  const pines: PinCapa[] = [];
  for (const p of pinesRaw) {
    if (!esCoord(p)) continue;
    const { name, range } = p as { name?: unknown; range?: unknown };
    const r = Number(range);
    pines.push({
      lat: p.lat,
      lng: p.lng,
      name: String(name ?? '').slice(0, 255) || 'POI',
      range: Number.isFinite(r) && r > 0 ? Math.min(r, MAX_RANGO_PIN_M) : 300,
    });
    if (pines.length >= MAX_PINES_CAPA) break;
  }

  const poligonos: PoligonoCapa[] = [];
  for (const po of polisRaw) {
    if (!po || typeof po !== 'object') continue;
    const { name, paths } = po as { name?: unknown; paths?: unknown };
    if (!Array.isArray(paths)) continue;
    const limpio = paths.filter(esCoord).map(c => ({ lat: c.lat, lng: c.lng }));
    if (limpio.length < 3) continue;
    poligonos.push({
      name: String(name ?? '').slice(0, 255) || `Polígono ${poligonos.length + 1}`,
      paths: decimarPath(limpio, MAX_VERTICES_POLIGONO),
    });
    if (poligonos.length >= MAX_POLIGONOS_CAPA) break;
  }

  if (pines.length === 0 && poligonos.length === 0) {
    throw new Error('La capa no tiene pines ni polígonos válidos');
  }
  return { pines, poligonos };
}

// ---------- Lectura ----------

interface CapaRow {
  id: number | bigint;
  solicitud_caras_id: number | bigint;
  idquote: string;
  nombre: string;
  modo: string;
  origen: string;
  geometria: string;
  archivo_url: string | null;
  visible_cliente: number | boolean;
  total_pines: number | bigint;
  total_poligonos: number | bigint;
  creado_por: number | bigint | null;
  creado_por_nombre: string | null;
  created_at: Date;
}

const SELECT_CAPA = `
  SELECT id, solicitud_caras_id, idquote, nombre, modo, origen, geometria, archivo_url,
         visible_cliente, total_pines, total_poligonos, creado_por, creado_por_nombre, created_at
    FROM capa_mapa`;

function mapRow(r: CapaRow): CapaMapa {
  let geometria: GeometriaCapa = { pines: [], poligonos: [] };
  try {
    const g = JSON.parse(r.geometria) as Partial<GeometriaCapa>;
    geometria = { pines: g.pines ?? [], poligonos: g.poligonos ?? [] };
  } catch {
    // Fila corrupta: se devuelve vacia en vez de tirar toda la lista.
  }
  return {
    id: Number(r.id),
    solicitud_caras_id: Number(r.solicitud_caras_id),
    idquote: r.idquote,
    nombre: r.nombre,
    modo: (MODOS.includes(r.modo as ModoCapa) ? r.modo : 'incluir') as ModoCapa,
    origen: (ORIGENES.includes(r.origen as OrigenCapa) ? r.origen : 'mixto') as OrigenCapa,
    geometria,
    archivo_url: r.archivo_url,
    visible_cliente: Boolean(Number(r.visible_cliente)),
    total_pines: Number(r.total_pines),
    total_poligonos: Number(r.total_poligonos),
    creado_por: r.creado_por === null ? null : Number(r.creado_por),
    creado_por_nombre: r.creado_por_nombre,
    created_at: r.created_at,
  };
}

/**
 * Capas vivas de una propuesta (idquote). `soloVisibles` = endpoint publico:
 * solo las que Trafico marco como visibles para el cliente.
 */
export async function listarCapasPropuesta(
  propuestaId: number,
  opts: { soloVisibles?: boolean } = {},
): Promise<CapaMapa[]> {
  if (!Number.isFinite(propuestaId) || propuestaId <= 0) return [];
  if (!(await tablaCapasDisponible())) return [];
  const rows = await prisma.$queryRawUnsafe<CapaRow[]>(
    `${SELECT_CAPA}
      WHERE idquote = ? AND deleted_at IS NULL${opts.soloVisibles ? ' AND visible_cliente = 1' : ''}
      ORDER BY solicitud_caras_id, created_at, id`,
    String(propuestaId),
  );
  return rows.map(mapRow);
}

export async function obtenerCapa(id: number): Promise<CapaMapa | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  if (!(await tablaCapasDisponible())) return null;
  const rows = await prisma.$queryRawUnsafe<CapaRow[]>(
    `${SELECT_CAPA} WHERE id = ? AND deleted_at IS NULL LIMIT 1`, id,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// ---------- Escritura ----------

export async function crearCapa(input: CrearCapaInput): Promise<CapaMapa> {
  if (!(await tablaCapasDisponible())) {
    throw new Error('Capas de mapa no disponibles (falta la tabla capa_mapa)');
  }
  const scId = Number(input.solicitudCarasId);
  if (!Number.isFinite(scId) || scId <= 0) throw new Error('solicitudCarasId inválido');
  if (!MODOS.includes(input.modo)) throw new Error('modo inválido (incluir | excluir)');
  const origen: OrigenCapa = ORIGENES.includes(input.origen) ? input.origen : 'mixto';
  const nombre = String(input.nombre ?? '').trim().slice(0, 255);
  if (!nombre) throw new Error('La capa necesita un nombre');

  // idquote se deriva del circuito: el front (sobre todo el modal de campaña)
  // no tiene por que saber a que propuesta pertenece.
  const sc = await prisma.solicitudCaras.findUnique({
    where: { id: scId }, select: { id: true, idquote: true },
  });
  if (!sc || !sc.idquote) throw new Error('Circuito no encontrado');

  const geometria = normalizarGeometria(input.geometria);

  // KML original a Spaces: solo respaldo. Si falla, la capa se guarda igual.
  let archivoUrl: string | null = null;
  if (input.kmlTexto && input.kmlTexto.trim() && isSpacesConfigured()) {
    try {
      const nombreArchivo = (input.kmlNombre || `capa_${scId}.kml`).replace(/[^\w.-]+/g, '_');
      const up = await uploadBufferToSpaces(Buffer.from(input.kmlTexto, 'utf8'), {
        folder: `capas-mapa/${sc.idquote}`,
        originalName: nombreArchivo.toLowerCase().endsWith('.kml') ? nombreArchivo : `${nombreArchivo}.kml`,
        mimeType: 'application/vnd.google-earth.kml+xml',
      });
      archivoUrl = up.url.slice(0, 500);
    } catch (err) {
      console.warn('[capas-mapa] no se pudo subir el KML a Spaces:', err instanceof Error ? err.message : err);
    }
  }

  const id = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO capa_mapa
         (solicitud_caras_id, idquote, nombre, modo, origen, geometria, archivo_url,
          visible_cliente, total_pines, total_poligonos, creado_por, creado_por_nombre)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scId, String(sc.idquote), nombre, input.modo, origen, JSON.stringify(geometria), archivoUrl,
      input.visibleCliente === false ? 0 : 1, geometria.pines.length, geometria.poligonos.length,
      input.usuarioId ?? null, input.usuarioNombre ?? null,
    );
    const idRows = await tx.$queryRawUnsafe<{ id: bigint | number }[]>('SELECT LAST_INSERT_ID() AS id');
    const nuevoId = Number(idRows[0]?.id);
    if (!nuevoId) throw new Error('No se obtuvo id de capa_mapa');
    return nuevoId;
  });

  const creada = await obtenerCapa(id);
  if (!creada) throw new Error('La capa se guardó pero no se pudo releer');
  return creada;
}

export interface ActualizarCapaPatch {
  nombre?: string;
  visibleCliente?: boolean;
}

export async function actualizarCapa(id: number, patch: ActualizarCapaPatch): Promise<CapaMapa | null> {
  const actual = await obtenerCapa(id);
  if (!actual) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.nombre !== undefined) {
    const nombre = String(patch.nombre).trim().slice(0, 255);
    if (!nombre) throw new Error('La capa necesita un nombre');
    sets.push('nombre = ?'); params.push(nombre);
  }
  if (patch.visibleCliente !== undefined) {
    sets.push('visible_cliente = ?'); params.push(patch.visibleCliente ? 1 : 0);
  }
  if (sets.length === 0) return actual;

  await prisma.$executeRawUnsafe(
    `UPDATE capa_mapa SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    ...params, id,
  );
  return obtenerCapa(id);
}

/** Soft delete. Devuelve la capa borrada (para el historial) o null si no existia. */
export async function eliminarCapa(id: number): Promise<CapaMapa | null> {
  const actual = await obtenerCapa(id);
  if (!actual) return null;
  await prisma.$executeRawUnsafe(
    `UPDATE capa_mapa SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`, id,
  );
  return actual;
}
