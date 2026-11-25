import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';
import { authService } from '../services/auth.service';
import { LOGO_CLARO_PNG, LOGO_OSCURO_PNG } from './logos';

/**
 * OAuth 2.1 del MCP de QEB.
 *
 * Con esto el conector se agrega con una URL única (https://<host>/mcp) y cada persona
 * inicia sesión con su propia cuenta de QEB; ya no hay tokens en la URL.
 *
 * Qeb-Back hace los dos papeles que pide la especificación de MCP:
 *  - Servidor de recursos: /mcp exige "Authorization: Bearer <access token>" y, si falta,
 *    responde 401 apuntando a los metadatos (RFC 9728).
 *  - Servidor de autorización: metadatos (RFC 8414), registro dinámico de clientes
 *    (RFC 7591), authorization code con PKCE S256 y refresh tokens con rotación.
 *
 * Qué se guarda y dónde:
 *  - Clientes (Claude, ChatGPT…): NADA. El client_id es un dato firmado que ya contiene
 *    sus redirect_uris; así el registro abierto no puede llenar la base de basura.
 *  - Códigos de autorización: en memoria (viven 5 min y se usan una sola vez).
 *  - Conexiones (un usuario autorizó una app): tabla `mcp_conexiones`, con el hash del
 *    refresh token. Revocar una conexión = poner su `revocado_en` (ver sql/mcp_conexiones.sql).
 *  - Access tokens: JWT de 1 h firmados con MCP_OAUTH_SECRET (distinto de JWT_SECRET, para
 *    que un token del MCP nunca sirva como sesión de la API ni al revés).
 */

const ACCESS_SEG = 60 * 60;
const REFRESH_DIAS = 30;
const CODE_MS = 5 * 60 * 1000;
const SCOPE = 'qeb.read';
const AUD = 'qeb-mcp';
const BODY_MAX = 64 * 1024;

let secreto = '';

export function cargarOAuth(): { ok: boolean; activo: boolean; error?: string } {
  const s = (process.env.MCP_OAUTH_SECRET || '').trim();
  if (!s) return { ok: true, activo: false };
  if (s.length < 32) return { ok: false, activo: false, error: 'MCP_OAUTH_SECRET debe tener al menos 32 caracteres' };
  if ([process.env.JWT_SECRET, process.env.JWT_REFRESH_SECRET, process.env.PUBLIC_SHARE_SECRET].includes(s)) {
    return { ok: false, activo: false, error: 'MCP_OAUTH_SECRET no puede ser igual a otro secreto de qeb-Back' };
  }
  secreto = s;
  return { ok: true, activo: true };
}

export const oauthActivo = (): boolean => secreto !== '';

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const hmac = (t: string) => createHmac('sha256', secreto).update(t).digest('base64url');
const aleatorio = (bytes = 32) => randomBytes(bytes).toString('base64url');

function igual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const esc = (t: unknown) =>
  String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/**
 * URL pública del back. En un ambiente fijo se define MCP_PUBLIC_URL. Sin ella (piloto
 * con túnel, cuya dirección cambia) se deduce de los encabezados que pone el proxy.
 */
export function urlBase(req: IncomingMessage): string {
  const fija = (process.env.MCP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (fija) return fija;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}`;
}

function ipDe(req: IncomingMessage): string {
  const h = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  return String(Array.isArray(h) ? h[0] : h || req.socket.remoteAddress || '?').split(',')[0].trim();
}

function json(res: ServerResponse, status: number, cuerpo: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(cuerpo));
}

const errorOAuth = (res: ServerResponse, status: number, error: string, descripcion: string) =>
  json(res, status, { error, error_description: descripcion });

function leerBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > BODY_MAX) {
        reject(new Error('BODY_MAX'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

/** Cuerpo como pares clave/valor: acepta formulario (lo estándar en OAuth) o JSON. */
async function leerCampos(req: IncomingMessage): Promise<Record<string, string>> {
  const crudo = await leerBody(req);
  const tipo = String(req.headers['content-type'] || '');
  if (tipo.includes('application/json')) {
    const o = JSON.parse(crudo || '{}');
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  }
  return Object.fromEntries(new URLSearchParams(crudo));
}

// ---- límites de intentos (en memoria) ----

const intentos = new Map<string, { n: number; hasta: number }>();

function excede(clave: string, max: number, ventanaMs: number): boolean {
  const ahora = Date.now();
  if (intentos.size > 5000) for (const [k, v] of intentos) if (v.hasta <= ahora) intentos.delete(k);
  const v = intentos.get(clave);
  if (!v || v.hasta <= ahora) {
    intentos.set(clave, { n: 1, hasta: ahora + ventanaMs });
    return false;
  }
  v.n += 1;
  return v.n > max;
}

// ---------------------------------------------------------------------------
// clientes (registro dinámico sin estado)
// ---------------------------------------------------------------------------

interface Cliente {
  /** nombre que declaró la app (no verificado) */
  n: string;
  /** redirect_uris registradas */
  r: string[];
  /** método de autenticación en /token: 'none' (público, con PKCE) o con secreto */
  m: 'none' | 'client_secret_post' | 'client_secret_basic';
  t: number;
}

const esLoopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

function redirectValida(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && esLoopback(u.hostname));
  } catch {
    return false;
  }
}

function emitirClientId(c: Cliente): string {
  const cuerpo = b64u(JSON.stringify(c));
  return `qc_${cuerpo}.${hmac(`client:${cuerpo}`)}`;
}

function leerCliente(clientId: string): Cliente | null {
  const m = /^qc_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(clientId || '');
  if (!m || !igual(m[2], hmac(`client:${m[1]}`))) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as Cliente;
  } catch {
    return null;
  }
}

const secretoDeCliente = (clientId: string) => hmac(`secret:${clientId}`);

/** Coincidencia exacta; en loopback se ignora el puerto (RFC 8252: el cliente elige uno libre). */
function redirectCoincide(c: Cliente, uri: string): boolean {
  if (c.r.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' || !esLoopback(u.hostname)) return false;
    return c.r.some(r => {
      const x = new URL(r);
      return x.protocol === 'http:' && esLoopback(x.hostname) && x.pathname === u.pathname;
    });
  } catch {
    return false;
  }
}

async function registrar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (excede(`reg:${ipDe(req)}`, 30, 60 * 60 * 1000)) return errorOAuth(res, 429, 'too_many_requests', 'Demasiados registros');
  let datos: any;
  try {
    datos = JSON.parse(await leerBody(req));
  } catch {
    return errorOAuth(res, 400, 'invalid_client_metadata', 'JSON inválido');
  }
  const uris: unknown = datos?.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every(u => typeof u === 'string' && u.length <= 300 && redirectValida(u))) {
    return errorOAuth(res, 400, 'invalid_redirect_uri', 'redirect_uris debe traer de 1 a 5 URLs https (o http en localhost)');
  }
  const pedido = String(datos?.token_endpoint_auth_method || 'none');
  const metodo: Cliente['m'] = pedido === 'client_secret_post' || pedido === 'client_secret_basic' ? pedido : 'none';
  const cliente: Cliente = { n: String(datos?.client_name || 'Aplicación').slice(0, 80), r: uris as string[], m: metodo, t: Math.floor(Date.now() / 1000) };
  const clientId = emitirClientId(cliente);
  json(res, 201, {
    client_id: clientId,
    client_id_issued_at: cliente.t,
    client_name: cliente.n,
    redirect_uris: cliente.r,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: metodo,
    scope: SCOPE,
    ...(metodo === 'none' ? {} : { client_secret: secretoDeCliente(clientId), client_secret_expires_at: 0 }),
  });
}

// ---------------------------------------------------------------------------
// autorización: página de inicio de sesión y consentimiento
// ---------------------------------------------------------------------------

interface Codigo {
  usuarioId: number;
  clientId: string;
  redirectUri: string;
  challenge: string;
  expira: number;
}
const codigos = new Map<string, Codigo>();

const CAMPOS = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type'] as const;

/**
 * Página de inicio de sesión. Sigue el diseño del login del front
 * (front-qeb/src/features/auth/LoginPage.tsx): fondo en degradado, logo arriba, tarjeta con
 * borde morado y botón principal morado→rosa. Sin JavaScript y con tema claro/oscuro según
 * el sistema del usuario.
 */
const ESTILOS = `
:root{color-scheme:light dark;--fondo:linear-gradient(to bottom right,#fff,rgba(250,245,255,.5),rgba(243,232,255,.3));--tarjeta:rgba(255,255,255,.9);--borde:rgba(233,213,255,.6);--sombra:0 20px 25px -5px rgba(243,232,255,.5),0 8px 10px -6px rgba(243,232,255,.5);--tx:#1f2937;--tx2:#4b5563;--mu:#6b7280;--campo:#f9fafb;--bcampo:#e9d5ff;--caja:rgba(250,245,255,.7);--ac:#9333ea;--er:#dc2626;--erbg:#fef2f2;--erbd:#fecaca}
@media(prefers-color-scheme:dark){:root{--fondo:linear-gradient(to bottom right,#0f0a18,#1a1025,#0f0a18);--tarjeta:rgba(26,16,37,.9);--borde:rgba(88,28,135,.35);--sombra:0 20px 25px -5px rgba(88,28,135,.12);--tx:#fff;--tx2:#d4d4d8;--mu:#a1a1aa;--campo:rgba(39,39,42,.5);--bcampo:rgba(168,85,247,.25);--caja:rgba(39,39,42,.35);--ac:#c084fc;--er:#f87171;--erbg:rgba(239,68,68,.1);--erbd:rgba(239,68,68,.3)}}
*{box-sizing:border-box}
html{background:#fff}@media(prefers-color-scheme:dark){html{background:#0f0a18}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--fondo);color:var(--tx);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.w{width:100%;max-width:440px}
.logo{display:flex;justify-content:center;margin-bottom:28px}.logo img{height:84px;width:auto;display:block}
.c{background:var(--tarjeta);border:1px solid var(--borde);border-radius:16px;padding:32px;box-shadow:var(--sombra)}
.h{text-align:center;margin-bottom:24px}
h1{font-size:24px;font-weight:300;letter-spacing:.025em;margin:0}
.s{color:var(--mu);font-size:14px;margin:8px 0 0}
.amb{display:inline-block;margin-top:12px;padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid var(--bcampo);color:var(--ac)}
.box{background:var(--caja);border:1px solid var(--bcampo);border-radius:12px;padding:14px 16px;font-size:13.5px;color:var(--tx2);margin-bottom:22px}
.box p{margin:0 0 8px}.box b{color:var(--tx);font-weight:600;word-break:break-word}.box span{color:var(--mu)}
ul{list-style:none;margin:0;padding:0}li{position:relative;padding-left:22px;margin:5px 0}
li::before{content:"✓";position:absolute;left:0;color:var(--ac);font-weight:700}
.e{background:var(--erbg);color:var(--er);border:1px solid var(--erbd);border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:18px}
label{display:block;font-size:14px;font-weight:300;color:var(--tx2);margin:0 0 8px}
.f{margin-bottom:20px}
input[type=email],input[type=password]{width:100%;height:42px;padding:0 12px;border:1px solid var(--bcampo);border-radius:8px;background:var(--campo);color:var(--tx);font:inherit;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:var(--mu);opacity:.7}
input[type=email]:focus,input[type=password]:focus{outline:none;border-color:#a855f7;box-shadow:0 0 0 3px rgba(168,85,247,.2)}
button{display:block;width:100%;border:0;border-radius:8px;font:inherit;cursor:pointer}
.p{margin-top:6px;padding:13px;color:#fff;font-weight:300;letter-spacing:.025em;font-size:15px;background:linear-gradient(to right,#9333ea,#db2777);transition:filter .15s}
.p:hover{filter:brightness(.9)}.p:focus-visible,.x:focus-visible{outline:2px solid #a855f7;outline-offset:2px}
.x{margin-top:10px;padding:10px;background:transparent;color:var(--mu);font-size:14px}.x:hover{color:var(--tx)}
.pie{text-align:center;font-size:12px;color:var(--mu);margin:24px 0 0;opacity:.8}
.msg{color:var(--tx2);font-size:14px;text-align:center;margin:0 0 10px}
@media(max-width:420px){.c{padding:24px 20px}.logo img{height:68px}}
`;

function pagina(res: ServerResponse, status: number, titulo: string, cuerpo: string): void {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(titulo)} · QEB</title><style>${ESTILOS}</style></head><body><div class="w">
<div class="logo"><picture><source srcset="/mcp/oauth/logo-oscuro.png" media="(prefers-color-scheme: dark)"><img src="/mcp/oauth/logo-claro.png" alt="QEB OOH Management" height="84"></picture></div>
<main class="c">${cuerpo}</main>
<p class="pie">QEB OOH Management Platform</p>
</div></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(html);
}

const paginaError = (res: ServerResponse, mensaje: string) =>
  pagina(res, 400, 'No se pudo conectar', `<div class="h"><h1>No se pudo conectar</h1></div><p class="msg">${esc(mensaje)}</p><p class="msg">Cierra esta ventana y vuelve a intentar desde la aplicación.</p>`);

function formulario(res: ServerResponse, p: Record<string, string>, cliente: Cliente, error?: string, email = ''): void {
  const ocultos = CAMPOS.map(k => `<input type="hidden" name="${k}" value="${esc(p[k] || '')}">`).join('');
  let destino = '';
  try {
    destino = new URL(p.redirect_uri).host;
  } catch {
    /* ya validada antes */
  }
  const amb = (process.env.MCP_AMBIENTE || '').trim();
  const insignia = amb && !/^prod/i.test(amb) ? `<div><span class="amb">Ambiente de ${esc(amb)}</span></div>` : '';
  // "Autorizar" va PRIMERO en el HTML: al pulsar Enter el navegador envía el primer botón.
  pagina(res, error ? 401 : 200, 'Conectar con QEB', `
<div class="h"><h1>Conectar con QEB</h1><p class="s">Inicia sesión para autorizar la conexión</p>${insignia}</div>
<div class="box"><p><b>${esc(cliente.n)}</b> <span>(${esc(destino)})</span> podrá:</p>
<ul><li>Consultar solicitudes, propuestas, campañas, artes e inventario</li><li>Ver solo lo que tú ves en QEB, con tus mismos permisos</li><li>Solo lectura: no puede crear ni modificar nada</li></ul></div>
${error ? `<div class="e" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/mcp/oauth/authorize" autocomplete="on">${ocultos}
<div class="f"><label for="email">Email</label><input id="email" name="email" type="email" required ${email ? '' : 'autofocus'} autocomplete="username" placeholder="tu@email.com" value="${esc(email)}"></div>
<div class="f"><label for="password">Password</label><input id="password" name="password" type="password" required ${email ? 'autofocus' : ''} autocomplete="current-password" placeholder="Tu password"></div>
<button class="p" type="submit" name="accion" value="autorizar">Autorizar</button>
<button class="x" type="submit" name="accion" value="cancelar" formnovalidate>Cancelar</button>
</form>`);
}

/** Valida la solicitud. Si el cliente o la redirect_uri no son de fiar, NO se redirige. */
function validarSolicitud(p: Record<string, string>): { cliente: Cliente } | { fatal: string } | { redirigir: string } {
  const cliente = leerCliente(p.client_id);
  if (!cliente) return { fatal: 'La aplicación no está registrada (client_id inválido).' };
  if (!p.redirect_uri || !redirectCoincide(cliente, p.redirect_uri)) return { fatal: 'La dirección de retorno no coincide con la registrada por la aplicación.' };
  if (p.response_type !== 'code') return { redirigir: 'unsupported_response_type' };
  if (!p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) return { redirigir: 'invalid_request' };
  return { cliente };
}

function redirigir(res: ServerResponse, redirectUri: string, params: Record<string, string | undefined>): void {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  res.writeHead(302, { Location: u.toString(), 'Cache-Control': 'no-store' });
  res.end();
}

async function autorizar(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const esPost = req.method === 'POST';
  let p: Record<string, string>;
  try {
    p = esPost ? await leerCampos(req) : Object.fromEntries(new URL(req.url || '', 'http://x').searchParams);
  } catch {
    return paginaError(res, 'Solicitud inválida.');
  }
  const v = validarSolicitud(p);
  if ('fatal' in v) return paginaError(res, v.fatal);
  if ('redirigir' in v) return redirigir(res, p.redirect_uri, { error: v.redirigir, state: p.state });
  if (!esPost) return formulario(res, p, v.cliente);

  // OJO: "Autorizar" debe ser el PRIMER botón del formulario en el HTML. Al pulsar Enter
  // el navegador envía el primer botón submit; si fuera "Cancelar", Enter cancelaría.
  if (p.accion === 'cancelar') {
    console.log(`[MCP] oauth: inicio de sesión cancelado en "${v.cliente.n}"`);
    return redirigir(res, p.redirect_uri, { error: 'access_denied', state: p.state });
  }

  const email = String(p.email || '').trim().toLowerCase();
  const password = String(p.password || '');
  // Topes: por IP (amplio, la oficina sale por una sola) y por cuenta (estricto).
  if (excede(`ip:${ipDe(req)}`, 60, 15 * 60 * 1000) || excede(`cta:${email}`, 8, 15 * 60 * 1000)) {
    return formulario(res, p, v.cliente, 'Demasiados intentos. Espera unos minutos y vuelve a intentar.', email);
  }
  let usuarioId: number;
  try {
    usuarioId = (await authService.login(email, password)).user.id;
  } catch {
    console.log(`[MCP] oauth: credenciales incorrectas en "${v.cliente.n}"`);
    return formulario(res, p, v.cliente, 'Correo o contraseña incorrectos.', email);
  }
  intentos.delete(`cta:${email}`);

  const ahora = Date.now();
  if (codigos.size > 2000) for (const [k, c] of codigos) if (c.expira <= ahora) codigos.delete(k);
  const code = aleatorio();
  codigos.set(code, { usuarioId, clientId: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, expira: ahora + CODE_MS });
  console.log(`[MCP] oauth: usuario=${usuarioId} autorizó "${v.cliente.n}"`);
  redirigir(res, p.redirect_uri, { code, state: p.state });
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

function clienteAutenticado(req: IncomingMessage, p: Record<string, string>): { clientId: string; cliente: Cliente } | null {
  let clientId = p.client_id || '';
  let secretoRecibido = p.client_secret || '';
  const basic = /^Basic (.+)$/i.exec(String(req.headers.authorization || ''));
  if (basic) {
    const [id, sec = ''] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    clientId = decodeURIComponent(id);
    secretoRecibido = decodeURIComponent(sec);
  }
  const cliente = leerCliente(clientId);
  if (!cliente) return null;
  if (cliente.m !== 'none' && !igual(secretoRecibido, secretoDeCliente(clientId))) return null;
  return { clientId, cliente };
}

function respuestaTokens(res: ServerResponse, usuarioId: number, conexionId: string, refresh: string): void {
  const access = jwt.sign({ cid: conexionId, scope: SCOPE }, secreto, {
    algorithm: 'HS256', subject: String(usuarioId), audience: AUD, issuer: AUD, expiresIn: ACCESS_SEG,
  });
  json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SEG, refresh_token: refresh, scope: SCOPE }, { Pragma: 'no-cache' });
}

async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let p: Record<string, string>;
  try {
    p = await leerCampos(req);
  } catch {
    return errorOAuth(res, 400, 'invalid_request', 'Cuerpo inválido');
  }
  const c = clienteAutenticado(req, p);
  console.log(`[MCP] oauth: /token grant=${p.grant_type || '?'} cliente=${c ? `"${c.cliente.n}"` : 'inválido'}`);
  if (!c) return errorOAuth(res, 401, 'invalid_client', 'Cliente desconocido o secreto incorrecto');
  const clientHash = sha256(c.clientId);

  if (p.grant_type === 'authorization_code') {
    const dato = codigos.get(p.code || '');
    if (dato) codigos.delete(p.code); // un solo uso, valga o no
    if (!dato || dato.expira < Date.now() || dato.clientId !== c.clientId || dato.redirectUri !== p.redirect_uri) {
      return errorOAuth(res, 400, 'invalid_grant', 'Código inválido o vencido');
    }
    const verificador = p.code_verifier || '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verificador) || !igual(createHash('sha256').update(verificador).digest('base64url'), dato.challenge)) {
      return errorOAuth(res, 400, 'invalid_grant', 'PKCE no coincide');
    }
    const id = randomBytes(16).toString('hex');
    const refresh = `qr_${aleatorio()}`;
    await prisma.$executeRaw`
      INSERT INTO mcp_conexiones (id, usuario_id, client_hash, client_nombre, scope, refresh_hash, creado_en, ultimo_uso, expira_en)
      VALUES (${id}, ${dato.usuarioId}, ${clientHash}, ${c.cliente.n}, ${SCOPE}, ${sha256(refresh)}, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ${REFRESH_DIAS} DAY))`;
    return respuestaTokens(res, dato.usuarioId, id, refresh);
  }

  if (p.grant_type === 'refresh_token') {
    const recibido = sha256(p.refresh_token || '');
    const filas = await prisma.$queryRaw<{ id: string; usuario_id: number }[]>`
      SELECT id, usuario_id FROM mcp_conexiones
      WHERE refresh_hash = ${recibido} AND client_hash = ${clientHash} AND revocado_en IS NULL AND expira_en > NOW() LIMIT 1`;
    if (filas.length === 0) {
      // ¿Es un refresh token YA rotado? Pasados 2 min de gracia (reintentos de red) se
      // asume robo y se revoca la conexión completa.
      const n = await prisma.$executeRaw`
        UPDATE mcp_conexiones SET revocado_en = NOW()
        WHERE refresh_prev_hash = ${recibido} AND revocado_en IS NULL AND rotado_en < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`;
      if (n > 0) console.warn('[MCP] oauth: reuso de refresh token ya rotado; conexión revocada');
      return errorOAuth(res, 400, 'invalid_grant', 'Refresh token inválido, vencido o revocado');
    }
    const nuevo = `qr_${aleatorio()}`;
    // El WHERE repite refresh_hash: si dos peticiones llegan a la vez, solo una rota.
    const n = await prisma.$executeRaw`
      UPDATE mcp_conexiones
      SET refresh_prev_hash = refresh_hash, refresh_hash = ${sha256(nuevo)}, rotado_en = NOW(), ultimo_uso = NOW(),
          expira_en = DATE_ADD(NOW(), INTERVAL ${REFRESH_DIAS} DAY)
      WHERE id = ${filas[0].id} AND refresh_hash = ${recibido} AND revocado_en IS NULL`;
    if (n === 0) return errorOAuth(res, 400, 'invalid_grant', 'Refresh token ya utilizado');
    return respuestaTokens(res, Number(filas[0].usuario_id), filas[0].id, nuevo);
  }

  return errorOAuth(res, 400, 'unsupported_grant_type', 'Solo authorization_code y refresh_token');
}

// ---------------------------------------------------------------------------
// validación del access token en /mcp
// ---------------------------------------------------------------------------

const vigentes = new Map<string, { ok: boolean; hasta: number }>();

/** La conexión sigue viva (no revocada ni vencida). Se cachea 60 s: revocar tarda como mucho eso. */
async function conexionVigente(id: string): Promise<boolean> {
  const ahora = Date.now();
  const c = vigentes.get(id);
  if (c && c.hasta > ahora) return c.ok;
  const filas = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM mcp_conexiones WHERE id = ${id} AND revocado_en IS NULL AND expira_en > NOW() LIMIT 1`;
  if (vigentes.size > 5000) vigentes.clear();
  vigentes.set(id, { ok: filas.length > 0, hasta: ahora + 60_000 });
  return filas.length > 0;
}

/** Devuelve el usuario y la conexión del Bearer token, o null si no es válido. */
export async function autenticarBearer(req: IncomingMessage): Promise<{ usuarioId: number; conexionId: string } | null> {
  const m = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  try {
    const d = jwt.verify(m[1].trim(), secreto, { algorithms: ['HS256'], audience: AUD, issuer: AUD }) as jwt.JwtPayload;
    const usuarioId = Number(d.sub);
    const conexionId = String(d.cid || '');
    if (!Number.isInteger(usuarioId) || usuarioId <= 0 || !conexionId) return null;
    return (await conexionVigente(conexionId)) ? { usuarioId, conexionId } : null;
  } catch {
    return null;
  }
}

/** 401 que le indica al cliente dónde descubrir cómo autenticarse. */
export function pedirAutenticacion(req: IncomingMessage, res: ServerResponse): void {
  const meta = `${urlBase(req)}/.well-known/oauth-protected-resource`;
  json(res, 401, { error: 'unauthorized', error_description: 'Se requiere iniciar sesión en QEB' }, {
    'WWW-Authenticate': `Bearer resource_metadata="${meta}", scope="${SCOPE}"`,
  });
}

// ---------------------------------------------------------------------------
// enrutador
// ---------------------------------------------------------------------------

export const esRutaOAuth = (ruta: string): boolean =>
  ruta.startsWith('/.well-known/oauth-protected-resource') ||
  ruta.startsWith('/.well-known/oauth-authorization-server') ||
  ruta.startsWith('/mcp/oauth/');

/** Atiende metadatos y endpoints de OAuth. Devuelve false si la ruta no es de OAuth. */
export async function manejarOAuth(req: IncomingMessage, res: ServerResponse, ruta: string): Promise<boolean> {
  if (!oauthActivo() || !esRutaOAuth(ruta)) return false;
  const base = urlBase(req);
  const cors = { 'Access-Control-Allow-Origin': '*' };

  if (ruta.startsWith('/.well-known/oauth-protected-resource')) {
    json(res, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'QEB',
    }, cors);
    return true;
  }
  if (ruta.startsWith('/.well-known/oauth-authorization-server')) {
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/mcp/oauth/authorize`,
      token_endpoint: `${base}/mcp/oauth/token`,
      registration_endpoint: `${base}/mcp/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
    }, cors);
    return true;
  }

  const logo = /^\/mcp\/oauth\/logo-(claro|oscuro)\.png$/.exec(ruta);
  if (logo && req.method === 'GET') {
    const png = Buffer.from(logo[1] === 'claro' ? LOGO_CLARO_PNG : LOGO_OSCURO_PNG, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=86400' });
    res.end(png);
    return true;
  }

  try {
    if (ruta === '/mcp/oauth/register' && req.method === 'POST') await registrar(req, res);
    else if (ruta === '/mcp/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) await autorizar(req, res);
    else if (ruta === '/mcp/oauth/token' && req.method === 'POST') await token(req, res);
    else json(res, 404, { error: 'No encontrado' });
  } catch (e) {
    console.error('[MCP] oauth: error inesperado:', (e as Error).message);
    if (!res.headersSent) errorOAuth(res, 500, 'server_error', 'Error interno');
    else res.end();
  }
  return true;
}
