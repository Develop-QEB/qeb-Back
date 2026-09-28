import bcrypt from 'bcryptjs';
import { query, queryWrite } from '../db.js';

/**
 * Usuarios EXCLUSIVOS de QEBI, en la BD escribible de Hostinger (tabla
 * `qebi_usuario`). Separados de QEB. Login por `correo` + bcrypt. Permisos por
 * pestaña + flag admin (el admin ve todo y gestiona usuarios).
 */

export interface Permisos { bi: boolean; variaciones: boolean; embudo: boolean; objetivos: boolean }
export interface UsuarioQebi {
  id: number;
  nombre: string;
  correo: string;
  esAdmin: boolean;
  activo: boolean;
  permisos: Permisos;
}
interface Row {
  id: number; nombre: string; correo: string; password?: string;
  es_admin: number; ver_bi: number; ver_variaciones: number; ver_embudo: number; ver_objetivos: number; activo: number;
}

const mapUser = (r: Row): UsuarioQebi => ({
  id: Number(r.id),
  nombre: r.nombre,
  correo: r.correo,
  esAdmin: !!r.es_admin,
  activo: !!r.activo,
  permisos: { bi: !!r.ver_bi, variaciones: !!r.ver_variaciones, embudo: !!r.ver_embudo, objetivos: !!r.ver_objetivos },
});

let tablaLista = false;
export async function ensureTabla(): Promise<void> {
  if (tablaLista) return;
  await queryWrite(
    `CREATE TABLE IF NOT EXISTS qebi_usuario (
       id INT AUTO_INCREMENT PRIMARY KEY,
       nombre VARCHAR(255) NOT NULL,
       correo VARCHAR(255) NOT NULL UNIQUE,
       password VARCHAR(255) NOT NULL,
       es_admin TINYINT(1) NOT NULL DEFAULT 0,
       ver_bi TINYINT(1) NOT NULL DEFAULT 1,
       ver_variaciones TINYINT(1) NOT NULL DEFAULT 1,
       ver_embudo TINYINT(1) NOT NULL DEFAULT 1,
       ver_objetivos TINYINT(1) NOT NULL DEFAULT 0,
       activo TINYINT(1) NOT NULL DEFAULT 1,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  tablaLista = true;
}

/** Fila con hash para login (activo). */
export async function porCorreoConHash(correo: string): Promise<(UsuarioQebi & { hash: string }) | null> {
  await ensureTabla();
  const rows = await queryWrite<Row>(
    `SELECT * FROM qebi_usuario WHERE correo = :correo AND activo = 1 LIMIT 1`,
    { correo }
  );
  const r = rows[0];
  if (!r || !r.password) return null;
  return { ...mapUser(r), hash: r.password };
}

export async function listar(): Promise<UsuarioQebi[]> {
  await ensureTabla();
  const rows = await queryWrite<Row>(`SELECT * FROM qebi_usuario ORDER BY es_admin DESC, nombre ASC`);
  return rows.map(mapUser);
}

export interface CrearInput { nombre: string; correo: string; password: string; esAdmin?: boolean; permisos?: Partial<Permisos> }
export async function crear(i: CrearInput): Promise<void> {
  await ensureTabla();
  const hash = await bcrypt.hash(i.password, 10);
  const p = i.permisos ?? {};
  await queryWrite(
    `INSERT INTO qebi_usuario (nombre, correo, password, es_admin, ver_bi, ver_variaciones, ver_embudo, ver_objetivos, activo)
     VALUES (:nombre, :correo, :password, :es_admin, :bi, :variaciones, :embudo, :objetivos, 1)
     ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
    {
      nombre: i.nombre, correo: i.correo, password: hash,
      es_admin: i.esAdmin ? 1 : 0,
      bi: p.bi ? 1 : 0, variaciones: p.variaciones ? 1 : 0, embudo: p.embudo ? 1 : 0, objetivos: p.objetivos ? 1 : 0,
    }
  );
}

export interface ActualizarInput { nombre?: string; esAdmin?: boolean; activo?: boolean; permisos?: Partial<Permisos> }
export async function actualizar(id: number, i: ActualizarInput): Promise<void> {
  await ensureTabla();
  const sets: string[] = []; const p: Record<string, unknown> = { id };
  if (i.nombre !== undefined) { sets.push('nombre = :nombre'); p.nombre = i.nombre; }
  if (i.esAdmin !== undefined) { sets.push('es_admin = :es_admin'); p.es_admin = i.esAdmin ? 1 : 0; }
  if (i.activo !== undefined) { sets.push('activo = :activo'); p.activo = i.activo ? 1 : 0; }
  if (i.permisos) {
    if (i.permisos.bi !== undefined) { sets.push('ver_bi = :bi'); p.bi = i.permisos.bi ? 1 : 0; }
    if (i.permisos.variaciones !== undefined) { sets.push('ver_variaciones = :variaciones'); p.variaciones = i.permisos.variaciones ? 1 : 0; }
    if (i.permisos.embudo !== undefined) { sets.push('ver_embudo = :embudo'); p.embudo = i.permisos.embudo ? 1 : 0; }
    if (i.permisos.objetivos !== undefined) { sets.push('ver_objetivos = :objetivos'); p.objetivos = i.permisos.objetivos ? 1 : 0; }
  }
  if (!sets.length) return;
  await queryWrite(`UPDATE qebi_usuario SET ${sets.join(', ')} WHERE id = :id`, p);
}

export async function setPassword(id: number, nueva: string): Promise<void> {
  await ensureTabla();
  const hash = await bcrypt.hash(nueva, 10);
  await queryWrite(`UPDATE qebi_usuario SET password = :hash WHERE id = :id`, { hash, id });
}

export async function verificarPasswordActual(id: number, actual: string): Promise<boolean> {
  const rows = await queryWrite<Row>(`SELECT password FROM qebi_usuario WHERE id = :id LIMIT 1`, { id });
  const h = rows[0]?.password;
  return h ? bcrypt.compare(actual, h) : false;
}

/**
 * Siembra usuarios de QEBI a partir de los usuarios REALES de QEB (tabla
 * `usuario` en prod, solo lectura): trae nombre + correo oficial. Idempotente
 * (ON DUPLICATE no pisa la contraseña). Marca a los correos `adminCorreos` como
 * Admin. Password inicial = `passwordInicial` (bcrypt). Devuelve a quién sembró.
 */
export async function sembrarDesdeProd(opts: {
  correosExactos?: string[];
  nombresLike?: string[];
  incluirAreaBI?: boolean;
  passwordInicial: string;
  permisos: Permisos;
  adminCorreos: string[];
  adminNombres?: string[];
}): Promise<{ correo: string; nombre: string; admin: boolean }[]> {
  await ensureTabla();
  const params: Record<string, unknown> = {};
  const cond: string[] = [];

  // Modo preferido: lista blanca de correos exactos (determinista, sin falsos positivos).
  const correos = (opts.correosExactos ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (correos.length) {
    correos.forEach((c, i) => { cond.push(`LOWER(correo_electronico) = :c${i}`); params[`c${i}`] = c; });
  }
  // Modo fuzzy opcional (por nombre / área BI).
  const like = (opts.nombresLike ?? [])
    .map((n) => n.replace(/[^a-zA-ZÀ-ÿñÑ ]/g, '').trim())
    .filter(Boolean);
  like.forEach((n, i) => { cond.push(`LOWER(nombre) LIKE :n${i}`); params[`n${i}`] = `%${n.toLowerCase()}%`; });
  if (opts.incluirAreaBI) cond.push(`(area LIKE '%BI%' OR puesto LIKE '%BI%')`);
  if (!cond.length) return [];

  const prod = await query<{ nombre: string; correo_electronico: string; area: string | null }>(
    `SELECT nombre, correo_electronico, area FROM usuario
      WHERE deleted_at IS NULL AND correo_electronico IS NOT NULL AND correo_electronico <> ''
        AND (${cond.join(' OR ')})`,
    params
  );

  const adminSet = new Set(opts.adminCorreos.map((c) => c.toLowerCase()));
  const adminNombres = (opts.adminNombres ?? []).map((n) => n.toLowerCase());
  const hash = await bcrypt.hash(opts.passwordInicial, 10);
  const p = opts.permisos;
  const sembrados: { correo: string; nombre: string; admin: boolean }[] = [];
  const vistos = new Set<string>();
  for (const u of prod) {
    const correo = u.correo_electronico.trim();
    if (vistos.has(correo.toLowerCase())) continue;
    vistos.add(correo.toLowerCase());
    const nombreLC = (u.nombre ?? '').toLowerCase();
    const admin = adminSet.has(correo.toLowerCase()) || adminNombres.some((n) => nombreLC.includes(n));
    await queryWrite(
      `INSERT INTO qebi_usuario (nombre, correo, password, es_admin, ver_bi, ver_variaciones, ver_embudo, ver_objetivos, activo)
       VALUES (:nombre, :correo, :password, :es_admin, :bi, :variaciones, :embudo, :objetivos, 1)
       ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), es_admin = GREATEST(es_admin, VALUES(es_admin))`,
      {
        nombre: u.nombre, correo, password: hash,
        es_admin: admin ? 1 : 0,
        bi: admin || p.bi ? 1 : 0, variaciones: admin || p.variaciones ? 1 : 0,
        embudo: admin || p.embudo ? 1 : 0, objetivos: admin || p.objetivos ? 1 : 0,
      }
    );
    sembrados.push({ correo, nombre: u.nombre, admin });
  }
  return sembrados;
}
