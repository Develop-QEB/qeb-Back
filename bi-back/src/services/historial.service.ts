import { query } from '../db.js';
import { normalizaAsesor } from '../lib/asesores.js';
import { normalizaPlaza } from '../lib/plazas.js';
import type {
  CategoriaAccion,
  ConteoNombre,
  ContextoHistorial,
  EventoHistorial,
  FiltrosHistorial,
  Impacto,
  PuntoActividad,
  ResumenHistorial,
} from '../types.js';

/**
 * Lee y normaliza la tabla `historial` (historial de acciones) — SOLO SELECT.
 * `detalles` viene a veces como JSON y a veces como texto plano; parseamos ambos.
 * El impacto se mide en CARAS (± confiable): quitar reservas = negativo,
 * aprobar/agregar = positivo. El $ solo cuando el propio detalle lo trae.
 */

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v.replace(/[^\d.-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toISO = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

function categorizar(tipo: string, accion: string): CategoriaAccion {
  const t = (tipo || '').toLowerCase();
  const a = (accion || '').toLowerCase();
  if (t.includes('rechazo') || a.includes('rechazo')) return 'rechazo';
  if (t.startsWith('autorizacion') || a.startsWith('aprobación') || a.startsWith('aprobacion')) return 'autorizacion';
  // APS = marca de posteo (asignar/remover el # APS). NO es eliminación de reservas
  // ni suma/resta caras: es operativo. Va antes del check de eliminación/remoción.
  if (a.includes('aps')) return a.includes('post') ? 'post_sap' : 'asignacion';
  if (a.includes('eliminaci') || a.includes('remoci')) return 'eliminacion';
  if (a === 'cambio de estado') return 'cambio_estado';
  if (a.includes('asignaci')) return 'asignacion';
  if (a.includes('creaci') || a === 'inicio') return 'creacion';
  if (a.includes('post aps')) return 'post_sap';
  return 'otro';
}

/** Intenta separar "Nombre Apellido verbó ..." → nombre. */
function usuarioDeTexto(texto: string): string | null {
  const m = texto.match(
    /^([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ.'-]+){1,4})\s+(asignó|aprobó|creó|eliminó|posteó|removió|activó|rechazó|finalizó|editó|actualizó|bloqueó)/
  );
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

interface RowEvento {
  id: number | string;
  tipo: string;
  ref_id: number | null;
  accion: string;
  fecha_hora: Date | string;
  detalles: string | null;
  campania_nombre: string | null;
}

/** Normaliza una fila de historial (con detalles completo) a un evento legible. */
export function parseEvento(row: RowEvento): EventoHistorial {
  const categoria = categorizar(row.tipo, row.accion);
  let usuario: string | null = null;
  let caras = 0;
  let monto: number | null = null;
  let estadoAntes: string | null = null;
  let estadoDespues: string | null = null;
  let carasAntes: number | null = null;
  let carasDespues: number | null = null;
  let invAntes: number | null = null;
  let invDespues: number | null = null;
  let campania: string | null = row.campania_nombre ?? null;
  let descripcion = '';

  let caraIds: number[] | undefined;
  let cambioPeriodo = false;
  let hayTarifaEdit = false;
  let tieneCarasElim = false;
  const articuloSet = new Set<string>();
  let formatoDetalle: string | null = null;
  let tarifaAntes: number | null = null;   // tarifa_publica (precio unitario), NO el costo total
  let tarifaDespues: number | null = null;
  let cambioCaras = false;                  // cambió el # de caras
  let cambioTarifa = false;                 // cambió la tarifa pública (distinto de que cambie la inversión)

  let json: any = null;
  const raw = row.detalles ?? '';
  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    try { json = JSON.parse(raw); } catch { json = null; }
  }

  if (json && typeof json === 'object') {
    usuario = json.usuario ?? json.aprobadoPor ?? null;
    if (json['campaña']) campania = String(json['campaña']);
    else if (json.campania) campania = String(json.campania);

    if (typeof json.reservas_eliminadas === 'number') caras = -Math.abs(json.reservas_eliminadas);
    if (typeof json.carasAprobadas === 'number')
      caras = categoria === 'rechazo' ? -Math.abs(json.carasAprobadas) : Math.abs(json.carasAprobadas);

    // Eliminación de circuito COMPLETO desde el modal de propuesta: el detalle trae
    // `caras_eliminadas[]` (con caras y costo por circuito) en vez de `reservas_eliminadas`.
    // Sumamos caras (negativo) y costo (negativo) para que SÍ pese en Variaciones/inversión.
    if (Array.isArray(json.caras_eliminadas) && json.caras_eliminadas.length) {
      tieneCarasElim = true;
      let cE = 0, mE = 0;
      const ids: number[] = [];
      for (const c of json.caras_eliminadas) {
        cE += num(c?.caras);
        mE += num(c?.costo);
        const id = Number(c?.id);
        if (Number.isFinite(id) && id > 0) ids.push(id);
        if (c?.articulo) articuloSet.add(String(c.articulo).trim());
        if (c?.formato && !formatoDetalle) formatoDetalle = String(c.formato).trim();
      }
      if (cE > 0) caras = -Math.abs(cE);
      if (mE > 0) monto = -Math.abs(mE);
      if (ids.length) caraIds = [...new Set([...(caraIds ?? []), ...ids])];
    }

    // Circuitos (eliminación de reservas / de circuito desde campaña): trae articulo + formato.
    if (Array.isArray(json.circuitos)) {
      for (const c of json.circuitos) {
        if (c?.articulo) articuloSet.add(String(c.articulo).trim());
        if (c?.formato && !formatoDetalle) formatoDetalle = String(c.formato).trim();
      }
    }

    if (Array.isArray(json.cambios)) {
      const campoDe = (c: any) => String(c?.campo ?? c?.label ?? '');
      // caraId de cada cambio = solicitudCaras.id de la cara editada (atribución exacta).
      const ids = [...new Set(json.cambios.map((c: any) => Number(c?.caraId)).filter((n: number) => Number.isFinite(n) && n > 0))] as number[];
      if (ids.length) caraIds = ids;
      const est = json.cambios.find((c: any) => /estado/i.test(campoDe(c)));
      if (est) { estadoAntes = est.antes ?? null; estadoDespues = est.despues ?? null; }
      for (const c of json.cambios) if (c?.articulo) articuloSet.add(String(c.articulo).trim());

      // Una edición toca MUCHAS caras (una fila por cara y por campo). Agregamos
      // antes/después de todas para el ANTES→DESPUÉS real y el delta correcto.
      // OJO: 3 campos DISTINTOS e independientes → NO mezclar:
      //   • caras          = # de caras (unidad)
      //   • costo/Inversión = importe TOTAL (esto genera la Δ Inversión / impacto)
      //   • tarifa_publica  = precio unitario (la "tarifa" real; NO es la inversión)
      let cA = 0, cD = 0, iA = 0, iD = 0, hayCaras = false, hayInv = false;
      for (const c of json.cambios) {
        const campo = String(c?.campo ?? '').toLowerCase();
        const label = String(c?.label ?? '').toLowerCase();
        if (campo === 'caras' || label === 'caras') {
          cA += num(c.antes); cD += num(c.despues); hayCaras = true;
        } else if (campo === 'costo' || /inversi[oó]n/.test(label)) {
          iA += num(c.antes); iD += num(c.despues); hayInv = true;
        } else if (/per[ií]odo|catorcena/.test(campo) || /per[ií]odo|catorcena/.test(label)) {
          // OJO: el back de QEB escribe el campo como "Período" (con acento í), así que
          // el patrón debe aceptar i/í o no detecta los cambios de periodo.
          cambioPeriodo = true;
        } else if (/tarifa/.test(campo) || /tarifa/.test(label)) {
          // Tarifa pública (precio unitario). Tomamos el primer par como representativo
          // y marcamos cambioTarifa solo si de verdad cambió (antes ≠ después).
          const ta = num(c.antes), td = num(c.despues);
          if (tarifaAntes == null) { tarifaAntes = ta; tarifaDespues = td; }
          if (ta !== td) cambioTarifa = true;
        }
      }
      if (hayCaras) { carasAntes = cA; carasDespues = cD; caras = cD - cA; cambioCaras = cA !== cD; }
      if (hayInv) {
        invAntes = iA; invDespues = iD;
        const d = iD - iA;
        if (d !== 0) monto = d;
      }
      // "Edición de tarifa" = cambió la tarifa PÚBLICA (no cualquier cambio de inversión).
      hayTarifaEdit = cambioTarifa;
    }
    descripcion = describir(json, row, categoria, caras, campania, estadoAntes, estadoDespues);
  } else {
    descripcion = String(raw).trim();
    usuario = usuarioDeTexto(descripcion);
  }

  // Tipo de edición legible (para la columna "Tipo" del historial). Prioridad:
  // APS (operativo) > eliminación de circuito completo > baja de reservas > periodo >
  // caras > tarifa > estado/otro.
  const accLC = (row.accion || '').toLowerCase();
  // Remoción de APS: operativo (listo/no listo para postear), NO impacto.
  const esRemocionAps = accLC.includes('aps') && (accLC.includes('remoci') || accLC.includes('remov'));
  // Circuito COMPLETO eliminado: trae caras_eliminadas[] o la acción dice "circuito".
  const esElimCircuito = tieneCarasElim || accLC.includes('circuito');
  let tipoEdicion: string;
  if (esRemocionAps) tipoEdicion = 'Remoción de APS';
  else if (categoria === 'eliminacion' && esElimCircuito) tipoEdicion = 'Eliminar circuito';
  else if (categoria === 'eliminacion') tipoEdicion = 'Baja de reservas';
  else if (categoria === 'rechazo') tipoEdicion = 'Rechazo';
  else if (cambioPeriodo) tipoEdicion = 'Cambio de periodo';
  else if (carasAntes != null && caras > 0) tipoEdicion = 'Alza de caras';
  else if (carasAntes != null && caras < 0) tipoEdicion = 'Baja de caras';
  else if (hayTarifaEdit) tipoEdicion = 'Edición de tarifa';
  else if (categoria === 'autorizacion') tipoEdicion = 'Autorización';
  else if (categoria === 'cambio_estado') tipoEdicion = 'Cambio de estado';
  else if (categoria === 'creacion') tipoEdicion = 'Creación';
  else if (categoria === 'post_sap') tipoEdicion = 'POST a SAP';
  else tipoEdicion = 'Otro';

  // Unidad: 'impresiones' si TODOS los artículos tocados son de impresión (prefijo IM-);
  // si no, 'caras'. (El resto de circuitos se miden en caras.)
  const articulos = [...articuloSet];
  const esImpresion = articulos.length > 0 && articulos.every((a) => a.toUpperCase().startsWith('IM-') || a.toUpperCase() === 'IM');
  const unidad: 'caras' | 'impresiones' = esImpresion ? 'impresiones' : 'caras';

  return {
    id: Number(row.id),
    fecha: toISO(row.fecha_hora),
    tipo: row.tipo,
    accion: row.accion,
    categoria,
    usuario,
    refId: row.ref_id ?? null,
    campania,
    caras,
    monto,
    estadoAntes,
    estadoDespues,
    carasAntes,
    carasDespues,
    invAntes,
    invDespues,
    descripcion: descripcion || `${row.tipo} · ${row.accion}`,
    caraIds,
    articulos: articulos.length ? articulos : undefined,
    unidad,
    formatoDetalle,
    tarifaAntes,
    tarifaDespues,
    cambioCaras,
    cambioTarifa,
    viaAutorizacion: !!(json && typeof json === 'object' && json.via === 'autorización'),
    tipoEdicion,
  };
}

function describir(
  json: any,
  row: RowEvento,
  categoria: CategoriaAccion,
  caras: number,
  campania: string | null,
  antes: string | null,
  despues: string | null
): string {
  const quien = json.usuario ?? json.aprobadoPor ?? 'Alguien';
  const enCamp = campania ? ` de «${campania}»` : row.ref_id ? ` (${row.tipo} #${row.ref_id})` : '';
  switch (categoria) {
    case 'eliminacion':
      return `${quien} quitó ${Math.abs(caras)} cara(s)${enCamp}`;
    case 'autorizacion':
      return `${quien} aprobó ${Math.abs(caras)} cara(s)${json.tipo ? ` (${json.tipo})` : ''}${enCamp}`;
    case 'rechazo':
      return `${quien} rechazó ${Math.abs(caras)} cara(s)${enCamp}`;
    case 'cambio_estado':
      return `${quien} cambió estado: ${antes ?? '—'} → ${despues ?? '—'}${enCamp}`;
    case 'post_sap':
      return `${quien} posteó ${json.totalApsPosteados ?? (json.apsPosteados?.length ?? '')} APS a SAP${enCamp}`;
    case 'creacion':
      return `${quien} creó ${row.tipo}${enCamp}`;
    default:
      return `${quien} · ${row.accion}${enCamp}`;
  }
}

// Traduce categoría a un filtro SQL aproximado (para no traer de más).
function categoriaSql(cat: CategoriaAccion): string {
  switch (cat) {
    case 'eliminacion': return "(h.accion LIKE '%liminaci%' OR h.accion LIKE '%emoci%')";
    case 'autorizacion': return "(h.tipo LIKE 'autorizacion%' AND h.accion NOT LIKE '%echazo%')";
    case 'rechazo': return "(h.tipo LIKE '%rechazo%' OR h.accion LIKE '%echazo%')";
    case 'cambio_estado': return "h.accion = 'Cambio de estado'";
    case 'asignacion': return "h.accion LIKE '%signaci%'";
    case 'creacion': return "(h.accion LIKE '%reaci%' OR h.accion = 'Inicio')";
    case 'post_sap': return "h.accion LIKE '%POST APS%'";
    default: return '1=1';
  }
}

const SELECT_EVENTO = `
  SELECT h.id, h.tipo, h.ref_id, h.accion, h.fecha_hora, h.detalles,
         c.nombre AS campania_nombre
    FROM historial h
    LEFT JOIN campania c ON c.id = h.ref_id AND h.tipo = 'Campaña'`;

/**
 * Mapa ref_id → nombre de campaña. Una campaña se liga por `id` (evento de
 * Campaña) o por `cotizacion_id` = id de la propuesta (evento de Propuesta),
 * así que un id de propuesta también resuelve su campaña.
 */
async function resolverCampanias(refIds: (number | null)[]): Promise<Map<number, string>> {
  const ids = [...new Set(refIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  const inList = ids.join(','); // enteros seguros (ya validados)
  const rows = await query<{ id: number; cotizacion_id: number | null; nombre: string | null }>(
    `SELECT id, cotizacion_id, nombre FROM campania WHERE id IN (${inList}) OR cotizacion_id IN (${inList})`
  );
  const m = new Map<number, string>();
  for (const r of rows) {
    if (!r.nombre) continue;
    m.set(Number(r.id), r.nombre);
    if (r.cotizacion_id != null) m.set(Number(r.cotizacion_id), r.nombre);
  }
  return m;
}

/** Rellena `campania` en los eventos que no la traen, resolviendo por ref_id. */
async function enriquecerCampanias(eventos: EventoHistorial[]): Promise<void> {
  const faltan = eventos.filter((e) => !e.campania && e.refId).map((e) => e.refId as number);
  if (!faltan.length) return;
  const mapa = await resolverCampanias(faltan);
  for (const e of eventos) {
    if (!e.campania && e.refId && mapa.has(e.refId)) e.campania = mapa.get(e.refId) ?? null;
  }
}

/** Feed de eventos, más reciente primero, con filtros. */
export async function getEventos(f: FiltrosHistorial): Promise<EventoHistorial[]> {
  const cond: string[] = ['1=1'];
  const p: Record<string, unknown> = {};
  if (f.tipo) { cond.push('h.tipo = :tipo'); p.tipo = f.tipo; }
  if (f.campaniaId) { cond.push('h.ref_id = :cid'); p.cid = f.campaniaId; }
  if (f.usuario) { cond.push('h.detalles LIKE :usr'); p.usr = `%${f.usuario}%`; }
  if (f.desde) { cond.push('h.fecha_hora >= :desde'); p.desde = f.desde; }
  if (f.hasta) { cond.push('h.fecha_hora < :hasta'); p.hasta = f.hasta; }
  if (f.categoria) cond.push(categoriaSql(f.categoria));

  const lim = Math.min(Math.max(f.limit || 100, 1), 1000);
  // Si pide soloImpacto o filtra por categoría, escaneamos más filas recientes
  // (hay ráfagas de eventos sin impacto) para no quedarnos cortos tras filtrar en JS.
  const fetchN = f.soloImpacto || f.categoria ? Math.min(Math.max(lim * 10, 600), 5000) : lim;

  const rows = await query<RowEvento>(
    `${SELECT_EVENTO} WHERE ${cond.join(' AND ')} ORDER BY h.id DESC LIMIT ${fetchN}`,
    p
  );
  let eventos = rows.map(parseEvento);
  if (f.categoria) eventos = eventos.filter((e) => e.categoria === f.categoria);
  if (f.soloImpacto) eventos = eventos.filter((e) => e.caras !== 0 || e.monto);
  eventos = eventos.slice(0, lim);
  await enriquecerCampanias(eventos);
  return eventos;
}

/** Para el poller de tiempo real: eventos con id > lastId (ascendente). */
export async function getEventosDesdeId(lastId: number, cap = 200): Promise<EventoHistorial[]> {
  const rows = await query<RowEvento>(
    `${SELECT_EVENTO} WHERE h.id > :lastId ORDER BY h.id ASC LIMIT ${Math.min(cap, 500)}`,
    { lastId }
  );
  const eventos = rows.map(parseEvento);
  await enriquecerCampanias(eventos);
  return eventos;
}

export async function getMaxId(): Promise<number> {
  const [r] = await query<{ maxId: number | null }>('SELECT MAX(id) AS maxId FROM historial');
  return Number(r?.maxId ?? 0);
}

/** Resumen agregado del historial en un rango. Extrae los números vía JSON en SQL. */
export async function getResumen(f: Pick<FiltrosHistorial, 'desde' | 'hasta'>): Promise<ResumenHistorial> {
  const hasta = f.hasta ?? new Date().toISOString();
  const desde = f.desde ?? new Date(Date.now() - 45 * 864e5).toISOString();

  const rows = await query<{
    dia: string;
    tipoRegistro: string;
    accion: string;
    rem: number | null;
    apr: number | null;
    usuario: string | null;
    autTipo: string | null;
    campaniaId: number | null;
    campania: string | null;
  }>(
    `SELECT DATE(h.fecha_hora) AS dia,
            h.tipo AS tipoRegistro,
            h.accion AS accion,
            CASE WHEN JSON_VALID(h.detalles) THEN CAST(JSON_EXTRACT(h.detalles,'$.reservas_eliminadas') AS SIGNED) END AS rem,
            CASE WHEN JSON_VALID(h.detalles) THEN CAST(JSON_EXTRACT(h.detalles,'$.carasAprobadas') AS SIGNED) END AS apr,
            CASE WHEN JSON_VALID(h.detalles) THEN JSON_UNQUOTE(JSON_EXTRACT(h.detalles,'$.usuario')) END AS usuario,
            CASE WHEN JSON_VALID(h.detalles) THEN JSON_UNQUOTE(JSON_EXTRACT(h.detalles,'$.tipo')) END AS autTipo,
            c.id AS campaniaId,
            c.nombre AS campania
       FROM historial h
       LEFT JOIN campania c ON c.id = h.ref_id AND h.tipo = 'Campaña'
      WHERE h.fecha_hora >= :desde AND h.fecha_hora < :hasta`,
    { desde, hasta }
  );

  const dias = new Map<string, PuntoActividad>();
  const cat = new Map<string, number>();
  const usuarios = new Map<string, { valor: number; eventos: number }>();
  const quitadores = new Map<string, number>();
  const alzasUsuario = new Map<string, number>();
  const campanias = new Map<number, { nombre: string; valor: number }>();
  let carasAgregadas = 0, carasQuitadas = 0;
  const aut = { total: 0, dg: 0, dcm: 0, rechazos: 0, carasAprobadas: 0 };

  const diaStr = (d: string | Date) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

  for (const r of rows) {
    const categoria = categorizar(r.tipoRegistro, r.accion);
    const dk = diaStr(r.dia);
    const pd = dias.get(dk) ?? { fecha: dk, eventos: 0, carasAgregadas: 0, carasQuitadas: 0, neto: 0 };
    pd.eventos++;

    const rem = Number(r.rem) || 0;
    const apr = Number(r.apr) || 0;
    if (categoria === 'eliminacion' && rem > 0) { carasQuitadas += rem; pd.carasQuitadas += rem; }
    if (categoria === 'autorizacion' && apr > 0) { carasAgregadas += apr; pd.carasAgregadas += apr; }
    pd.neto = pd.carasAgregadas - pd.carasQuitadas;
    dias.set(dk, pd);

    cat.set(categoria, (cat.get(categoria) ?? 0) + 1);

    if (r.tipoRegistro === 'autorizacion_aprobacion') {
      aut.total++; aut.carasAprobadas += apr;
      if (r.autTipo === 'DG') aut.dg++;
      else if (r.autTipo === 'DCM') aut.dcm++;
    } else if (r.tipoRegistro === 'autorizacion_rechazo') {
      aut.rechazos++;
    }

    if (r.usuario) {
      const u = usuarios.get(r.usuario) ?? { valor: 0, eventos: 0 };
      u.eventos++; u.valor++;
      usuarios.set(r.usuario, u);
      if (categoria === 'eliminacion' && rem > 0) quitadores.set(r.usuario, (quitadores.get(r.usuario) ?? 0) + rem);
      if (categoria === 'autorizacion' && apr > 0) alzasUsuario.set(r.usuario, (alzasUsuario.get(r.usuario) ?? 0) + apr);
    }
    if (r.campania && r.campaniaId != null) {
      const ex = campanias.get(Number(r.campaniaId)) ?? { nombre: r.campania, valor: 0 };
      ex.valor++;
      campanias.set(Number(r.campaniaId), ex);
    }
  }

  const top = (m: Map<string, number>, n = 8): ConteoNombre[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([nombre, valor]) => ({ nombre, valor, eventos: valor }));

  return {
    actualizadoEn: new Date().toISOString(),
    desde, hasta,
    totalEventos: rows.length,
    carasAgregadas, carasQuitadas, netoCaras: carasAgregadas - carasQuitadas,
    autorizaciones: aut,
    porDia: [...dias.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)),
    porCategoria: top(cat, 10),
    topUsuarios: [...usuarios.entries()].sort((a, b) => b[1].eventos - a[1].eventos).slice(0, 8)
      .map(([nombre, v]) => ({ nombre, valor: v.eventos, eventos: v.eventos })),
    topQuitadores: top(quitadores, 8),
    topCampanias: [...campanias.entries()]
      .sort((a, b) => b[1].valor - a[1].valor)
      .slice(0, 8)
      .map(([id, v]) => ({ id, nombre: v.nombre, valor: v.valor, eventos: v.valor })),
    variacionPorUsuario: [...new Set([...alzasUsuario.keys(), ...quitadores.keys()])]
      .map((nombre) => {
        const alzas = alzasUsuario.get(nombre) ?? 0;
        const bajas = quitadores.get(nombre) ?? 0;
        return { nombre, alzas, bajas, neto: alzas - bajas };
      })
      .sort((a, b) => Math.abs(b.neto) - Math.abs(a.neto))
      .slice(0, 10),
  };
}

/**
 * Enriquece ediciones con atributos EXACTOS de las caras editadas — para los
 * filtros del dashboard del jefe. Cada `cambio` del historial trae `caraId`
 * (= solicitudCaras.id), así que sabemos exactamente qué caras se tocaron:
 *   • Plaza  ← solicitudCaras.estados  (p.ej. "GUADALAJARA", "Ciudad de México / AM")
 *   • Formato← solicitudCaras.tipo     (Tradicional / Digital)
 *   • Mueble ← solicitudCaras.formato  (PARABUS / COLUMNA / "PARABUS, MUPIS, …")
 * Cliente/asesor son de la campaña (propuesta→solicitud); el asesor se normaliza.
 *
 * ref_id de un evento de Propuesta ya es el idquote; el de Campaña se traduce a
 * su cotizacion_id (= idquote). Todo SOLO SELECT.
 */
async function enriquecerAtributos(eventos: EventoHistorial[]): Promise<void> {
  const refIds = [...new Set(eventos.map((e) => Number(e.refId)).filter((n) => Number.isFinite(n) && n > 0))];

  // ref_id de Campaña → cotizacion_id (idquote). Para Propuesta, ref_id ya es el idquote.
  const camp2cotiz = new Map<number, number>();
  if (refIds.length) {
    const camps = await query<{ id: number; cotizacion_id: number | null }>(
      `SELECT id, cotizacion_id FROM campania WHERE id IN (${refIds.join(',')})`
    );
    for (const c of camps) if (c.cotizacion_id != null) camp2cotiz.set(Number(c.id), Number(c.cotizacion_id));
  }
  const quoteDe = (refId: number | null): number | null => {
    const r = Number(refId);
    if (!Number.isFinite(r) || r <= 0) return null;
    return camp2cotiz.get(r) ?? r;
  };

  // Cliente / asesor (normalizado) de la propuesta (idquote = propuesta.id).
  const quoteIds = [...new Set(eventos.map((e) => quoteDe(e.refId)).filter((n): n is number => n != null))];
  const propMap = new Map<number, { cliente: string | null; asesor: string | null; marca: string | null; status: string | null; base: string | null }>();
  if (quoteIds.length) {
    const propRows = await query<{ q: number; cliente: string | null; asesor: string | null; marca: string | null; status: string | null; base: string | null }>(
      `SELECT p.id AS q, s.razon_social AS cliente, s.asesor AS asesor, s.marca_nombre AS marca, p.status AS status, s.sap_database AS base
         FROM propuesta p
         LEFT JOIN solicitud s ON s.id = p.solicitud_id
        WHERE p.id IN (${quoteIds.join(',')})`
    );
    for (const r of propRows) propMap.set(Number(r.q), { cliente: r.cliente ?? null, asesor: normalizaAsesor(r.asesor), marca: r.marca ?? null, status: r.status ?? null, base: r.base ?? null });
  }

  // Atributos EXACTOS por cara editada (solicitudCaras.id = caraId).
  const caraIds = [...new Set(eventos.flatMap((e) => e.caraIds ?? []).filter((n) => Number.isFinite(n) && n > 0))];
  const scMap = new Map<number, { plazas: string[]; formatos: string[]; muebles: string[] }>();
  if (caraIds.length) {
    const scRows = await query<{ id: number; estados: string | null; tipo: string | null; formato: string | null }>(
      `SELECT id, estados, tipo, formato FROM solicitudCaras WHERE id IN (${caraIds.join(',')})`
    );
    const lista = (v: string | null): string[] =>
      String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const r of scRows) {
      scMap.set(Number(r.id), {
        plazas: normalizaPlaza(r.estados),
        formatos: r.tipo && String(r.tipo).trim() ? [String(r.tipo).trim()] : [],
        muebles: lista(r.formato),
      });
    }
  }

  // ¿Qué caras ya tienen APS asignado? (posteado). reservas.APS no nulo, viva.
  const apsSet = new Set<number>();
  if (caraIds.length) {
    const apsRows = await query<{ cid: number }>(
      `SELECT DISTINCT solicitudCaras_id AS cid FROM reservas
        WHERE solicitudCaras_id IN (${caraIds.join(',')}) AND deleted_at IS NULL AND APS IS NOT NULL`
    );
    for (const r of apsRows) apsSet.add(Number(r.cid));
  }

  for (const e of eventos) {
    const q = quoteDe(e.refId);
    const p = q != null ? propMap.get(q) : undefined;
    if (p) { e.cliente = p.cliente; e.asesor = p.asesor; e.marca = p.marca; e.status = p.status; e.base = p.base; }
    // Posteado = alguna cara editada ya tiene APS asignado.
    e.tieneAps = (e.caraIds ?? []).some((id) => apsSet.has(id));
    // Unión de atributos sobre las caras realmente editadas.
    const plazas = new Set<string>(), formatos = new Set<string>(), muebles = new Set<string>();
    for (const id of e.caraIds ?? []) {
      const a = scMap.get(id);
      if (!a) continue;
      a.plazas.forEach((x) => plazas.add(x));
      a.formatos.forEach((x) => formatos.add(x));
      a.muebles.forEach((x) => muebles.add(x));
    }
    e.plazas = [...plazas];
    e.formatos = [...formatos];
    e.muebles = [...muebles];
  }
}

/**
 * Impacto en inversión: ediciones cuyo detalle trae delta de $ (tarifa/inversión).
 * Alimenta "impacto total/promedio/mayor", el scatter y el historial de ediciones.
 * Con `anio` acota a ese año completo (para los filtros de Mes/Plaza/etc. del jefe).
 */
export async function getImpacto(
  f: { anio?: number | null; desde?: string | null; hasta?: string | null }
): Promise<Impacto> {
  let desde: string, hasta: string;
  if (f.anio && Number.isFinite(f.anio)) {
    desde = `${f.anio}-01-01 00:00:00`;
    hasta = `${f.anio + 1}-01-01 00:00:00`;
  } else {
    hasta = f.hasta ?? new Date().toISOString();
    desde = f.desde ?? new Date(Date.now() - 45 * 864e5).toISOString();
  }
  const rows = await query<RowEvento>(
    `${SELECT_EVENTO}
      WHERE h.fecha_hora >= :desde AND h.fecha_hora < :hasta
        AND JSON_VALID(h.detalles)
        AND (
          (h.detalles LIKE '%"cambios"%'
            AND (h.detalles LIKE '%arifa%' OR h.detalles LIKE '%nversi%' OR h.detalles LIKE '%onto%' OR h.detalles LIKE '%otal%'
                 OR h.detalles LIKE '%"campo":"Per%odo"%' OR h.detalles LIKE '%"campo":"catorcena"%'))
          OR h.detalles LIKE '%caras_eliminadas%'
          OR h.accion LIKE '%liminaci%circuito%'
        )
      ORDER BY h.id DESC
      LIMIT 6000`,
    { desde, hasta }
  );
  // Mantenemos: ediciones con $ + eliminaciones de circuito completo + cambios de
  // periodo (estos dos pueden no mover $ pero se quieren ver en el historial/filtro rápido).
  const eventos = rows
    .map(parseEvento)
    // Ocultar eliminaciones ejecutadas VÍA AUTORIZACIÓN: el detalle las atribuye al gerente
    // que autorizó (no a quien la solicitó/hizo) y no traen $ → sólo generan ruido en el impacto.
    .filter((e) => !(e.tipoEdicion === 'Eliminar circuito' && e.viaAutorizacion))
    .filter((e) => (e.monto != null && e.monto !== 0) || e.tipoEdicion === 'Eliminar circuito' || e.tipoEdicion === 'Cambio de periodo');
  await enriquecerCampanias(eventos);

  const total = eventos.reduce((a, e) => a + (e.monto ?? 0), 0);
  const promedio = eventos.length ? total / eventos.length : 0;
  let mayor: EventoHistorial | null = null;
  for (const e of eventos) if (!mayor || Math.abs(e.monto ?? 0) > Math.abs(mayor.monto ?? 0)) mayor = e;

  // Devolvemos y enriquecemos hasta 1000 ediciones (para que los filtros del año
  // tengan todo el universo). El enriquecido corre 2 queries batch (~1–2s).
  const ediciones = eventos.slice(0, 2000);
  await enriquecerAtributos(ediciones);

  return {
    total,
    promedio,
    count: eventos.length,
    mayor,
    puntos: ediciones.map((e) => ({ monto: e.monto ?? 0, caras: e.caras, campania: e.campania, usuario: e.usuario, fecha: e.fecha })),
    ediciones,
  };
}

/** Detalle de una propuesta/campaña (por ref_id) + toda su línea de tiempo. */
export async function getContexto(refId: number): Promise<ContextoHistorial> {
  const mapa = await resolverCampanias([refId]);
  const campania = mapa.get(refId) ?? null;

  const [prop] = await query<{
    id: number;
    status: string | null;
    descripcion: string | null;
    inversion: string | null;
    razon_social: string | null;
    asesor: string | null;
    marca_nombre: string | null;
  }>(
    `SELECT p.id, p.status, p.descripcion, p.inversion,
            s.razon_social, s.asesor, s.marca_nombre
       FROM propuesta p
       LEFT JOIN solicitud s ON s.id = p.solicitud_id
      WHERE p.id = :id
      LIMIT 1`,
    { id: refId }
  );

  const rows = await query<RowEvento>(
    `${SELECT_EVENTO} WHERE h.ref_id = :id ORDER BY h.id DESC LIMIT 300`,
    { id: refId }
  );
  const eventos = rows.map(parseEvento);
  await enriquecerCampanias(eventos);

  return {
    refId,
    campania,
    cliente: prop?.razon_social ?? null,
    asesor: prop?.asesor ?? null,
    marca: prop?.marca_nombre ?? null,
    status: prop?.status ?? null,
    descripcion: prop?.descripcion ?? null,
    inversion: prop?.inversion != null ? Number(prop.inversion) : null,
    eventos,
  };
}
