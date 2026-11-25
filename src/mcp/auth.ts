import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import type { JwtPayload } from '../types';

/**
 * Accesos del MCP (piloto).
 *
 * Cada persona tiene una URL secreta: /mcp/<token>. El token se liga a UN usuario de QEB
 * y el MCP actúa siempre como ese usuario: firma un JWT de vida corta con su id y su rol
 * y llama a la API de qeb-Back igual que el front. Así hereda sus permisos y su
 * visibilidad; el MCP no tiene permisos propios.
 *
 * Piloto: los accesos vienen de la variable MCP_PILOT_TOKENS ("<token>:<usuarioId>,...").
 * Siguiente paso: moverlos a una tabla (hash + revocación + último uso). Por eso aquí ya
 * se trabaja con el hash del token y nunca con el token en claro.
 */

const TOKEN_MIN = 32;
const JWT_VIDA = '2m';
const USUARIO_TTL_MS = 60_000;

export interface UsuarioMcp {
  id: number;
  nombre: string;
  email: string;
  rol: string;
}

/** sha256(token) -> usuarioId */
const accesos = new Map<string, number>();
const usuarios = new Map<number, { usuario: UsuarioMcp | null; hasta: number }>();

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function cargarAccesos(): { ok: true; total: number } | { ok: false; error: string } {
  if (!process.env.JWT_SECRET) return { ok: false, error: 'falta JWT_SECRET' };
  const crudo = (process.env.MCP_PILOT_TOKENS || '').trim();
  accesos.clear();
  // Sin tokens de piloto es válido si el acceso es por OAuth (lo decide index.ts).
  if (!crudo) return { ok: true, total: 0 };

  for (const par of crudo.split(',').map(s => s.trim()).filter(Boolean)) {
    const i = par.lastIndexOf(':');
    const token = i > 0 ? par.slice(0, i) : '';
    const usuarioId = i > 0 ? Number(par.slice(i + 1)) : NaN;
    if (token.length < TOKEN_MIN || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return { ok: false, error: `MCP_PILOT_TOKENS: cada token debe tener al menos ${TOKEN_MIN} caracteres (letras, números, - y _)` };
    }
    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      return { ok: false, error: 'MCP_PILOT_TOKENS: formato esperado "<token>:<usuarioId>"' };
    }
    accesos.set(hashToken(token), usuarioId);
  }
  return accesos.size > 0 ? { ok: true, total: accesos.size } : { ok: false, error: 'MCP_PILOT_TOKENS sin accesos' };
}

/** Devuelve el hash del token y el usuario al que pertenece, o null si el token no existe. */
export function resolverToken(token: string): { hash: string; usuarioId: number } | null {
  if (!token || token.length < TOKEN_MIN) return null;
  const hash = hashToken(token);
  const usuarioId = accesos.get(hash);
  return usuarioId ? { hash, usuarioId } : null;
}

/** Usuario vigente (no eliminado) con su rol ACTUAL. Se cachea 1 min. */
export async function obtenerUsuario(usuarioId: number): Promise<UsuarioMcp | null> {
  const ahora = Date.now();
  const c = usuarios.get(usuarioId);
  if (c && c.hasta > ahora) return c.usuario;
  const u = await prisma.usuario.findFirst({
    where: { id: usuarioId, deleted_at: null },
    select: { id: true, nombre: true, correo_electronico: true, user_role: true },
  });
  const usuario = u ? { id: u.id, nombre: u.nombre, email: u.correo_electronico, rol: u.user_role } : null;
  usuarios.set(usuarioId, { usuario, hasta: ahora + USUARIO_TTL_MS });
  return usuario;
}

/** JWT de vida corta, idéntico en forma al del login, para llamar a la API como el usuario. */
export function firmarJwt(u: UsuarioMcp): string {
  const payload: JwtPayload = { userId: u.id, email: u.email, rol: u.rol, nombre: u.nombre };
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: JWT_VIDA });
}
