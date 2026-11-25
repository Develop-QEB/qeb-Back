import type Anthropic from '@anthropic-ai/sdk';
import { herramientas } from './tools';
import type { UsuarioMcp } from './auth';

/**
 * Puente entre QEBooh (chatbot interno) y las herramientas de consulta del MCP.
 *
 * Son las MISMAS herramientas que usan Claude y ChatGPT por /mcp; aquí se le entregan
 * directo al modelo de QEBooh, sin pasar por el protocolo MCP ni por tokens: el usuario
 * ya inició sesión en QEB y las consultas se hacen con su identidad.
 *
 * Se enciende con CHATBOT_TOOLS_ENABLED=true (independiente de MCP_ENABLED). Sin la
 * variable, QEBooh se comporta exactamente como antes.
 */

/** Herramientas que no aportan dentro de QEBooh (ya conoce al usuario por su sesión). */
const EXCLUIDAS = new Set(['mi_perfil']);

export function chatbotToolsHabilitado(rol: string): boolean {
  if (process.env.CHATBOT_TOOLS_ENABLED !== 'true' || !process.env.JWT_SECRET) return false;
  // Opcional: limitar el piloto a ciertos roles ("DEV,Administrador"). Vacío = todos.
  const roles = (process.env.CHATBOT_TOOLS_ROLES || '').split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
  return roles.length === 0 || roles.includes(String(rol || '').trim().toLowerCase());
}

export const chatbotToolsModelo = (porDefecto: string): string => process.env.CHATBOT_TOOLS_MODEL || porDefecto;

export function toolsParaClaude(): Anthropic.Tool[] {
  return herramientas
    .filter(h => !EXCLUIDAS.has(h.name))
    .map(h => ({ name: h.name, description: h.description, input_schema: h.inputSchema as Anthropic.Tool.InputSchema }));
}

/** Ejecuta una herramienta como el usuario. Nunca lanza: un fallo se devuelve como error para el modelo. */
export async function ejecutarHerramienta(
  nombre: string,
  args: unknown,
  usuario: UsuarioMcp,
): Promise<{ texto: string; error: boolean }> {
  const h = herramientas.find(x => x.name === nombre && !EXCLUIDAS.has(x.name));
  if (!h) return { texto: `Herramienta desconocida: ${nombre}`, error: true };
  const t0 = Date.now();
  try {
    const datos = await h.ejecutar(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}, usuario);
    console.log(`[QEBooh] usuario=${usuario.id} herramienta=${nombre} ok ${Date.now() - t0}ms`);
    return { texto: JSON.stringify(datos), error: false };
  } catch (e) {
    const mensaje = (e as Error).message || 'Error al consultar QEB';
    console.warn(`[QEBooh] usuario=${usuario.id} herramienta=${nombre} error ${Date.now() - t0}ms: ${mensaje}`);
    return { texto: mensaje, error: true };
  }
}

/** Instrucciones que se agregan al prompt de QEBooh cuando tiene herramientas. */
export const SECCION_CONSULTAS = `

=== CONSULTAS DE DATOS EN VIVO ===

Ademas de tu base de conocimiento, tienes herramientas para consultar datos reales de QEB: solicitudes, propuestas, campañas (con sus circuitos), el gestor de artes y el inventario. Las consultas se hacen con la identidad del usuario actual, asi que solo devuelven lo que el puede ver en QEB.

CUANDO USARLAS:
- Si el usuario pregunta por datos concretos (cuantas hay, cuales tiene, en que estatus esta, detalle de una campaña o propuesta, como van los artes, que inventario hay), usa las herramientas. Estas preguntas SI son sobre QEB: nunca las trates como fuera de tema, aunque mencionen marcas o clientes (Netflix, Amazon, Mercado Libre, peliculas, futbol, etc. son clientes y campañas reales).
- Si pregunta COMO se hace algo en el sistema, responde con tu base de conocimiento, sin herramientas.
- Si dice "esta catorcena", "la actual" o "la siguiente", primero usa catorcena_actual.
- Si solo tienes un nombre y necesitas el detalle, primero busca para obtener el ID.
- Si la pantalla actual del usuario muestra un ID de campaña, propuesta o solicitud y pregunta por "esta", usa ese ID.

REGLAS:
- NUNCA inventes datos, cifras, nombres ni IDs. Responde solo con lo que devuelvan las herramientas. Si una devuelve error o no hay resultados, dilo tal cual.
- Si una herramienta indica que el usuario no tiene acceso, explicaselo amablemente; no intentes otra via.
- Son solo de consulta: no puedes crear, editar ni eliminar nada. Si piden una accion, explica como hacerla en el sistema.
- Si el usuario tiene visibilidad total, "mis campañas" incluye las de todos: aclaralo y ofrece filtrar por asesor o cliente.
- Manten el formato de siempre: texto plano, sin markdown ni tablas. Para listas usa guiones, un registro por linea con lo esencial (ID, nombre, cliente, estatus, periodo). Si hay mas de 10 resultados, muestra los primeros 10, di cuantos hay en total y ofrece filtrar o ver mas.
- Escribe los montos con separador de miles y signo de pesos.`;
