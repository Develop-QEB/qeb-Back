import type Anthropic from '@anthropic-ai/sdk';
import { herramientas } from './tools';
import { herramientasSolicitud, type AccionChat, type ContextoChat } from './solicitud';
import type { UsuarioMcp } from './auth';

export type { AccionChat } from './solicitud';

/**
 * Puente entre QEBooh (chatbot interno) y las herramientas del MCP.
 *
 * Recibe las MISMAS herramientas de consulta que usan Claude y ChatGPT por /mcp, más
 * las de armar solicitudes (src/mcp/solicitud.ts), que solo existen aquí. Se ejecutan
 * con la identidad del usuario en sesión, sin tokens ni URLs.
 *
 * Se enciende con CHATBOT_TOOLS_ENABLED=true (independiente de MCP_ENABLED). Sin la
 * variable, QEBooh se comporta exactamente como antes.
 */

/** Herramientas del conector externo que no aportan dentro de QEBooh (ya conoce al usuario). */
const EXCLUIDAS = new Set(['mi_perfil']);

export function chatbotToolsHabilitado(rol: string): boolean {
  if (process.env.CHATBOT_TOOLS_ENABLED !== 'true' || !process.env.JWT_SECRET) return false;
  // Opcional: limitar el piloto a ciertos roles ("DEV,Administrador"). Vacío = todos.
  const roles = (process.env.CHATBOT_TOOLS_ROLES || '').split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
  return roles.length === 0 || roles.includes(String(rol || '').trim().toLowerCase());
}

export const chatbotToolsModelo = (porDefecto: string): string => process.env.CHATBOT_TOOLS_MODEL || porDefecto;

interface Ejecutable {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  correr(args: Record<string, unknown>, ctx: ContextoChat): Promise<unknown>;
}

const EJECUTABLES: Ejecutable[] = [
  ...herramientas
    .filter(h => !EXCLUIDAS.has(h.name))
    .map(h => ({ ...h, correr: (a: Record<string, unknown>, ctx: ContextoChat) => h.ejecutar(a, ctx.usuario) })),
  ...herramientasSolicitud.map(h => ({ ...h, correr: (a: Record<string, unknown>, ctx: ContextoChat) => h.ejecutar(a, ctx) })),
];

export function toolsParaClaude(): Anthropic.Tool[] {
  return EJECUTABLES.map(h => ({ name: h.name, description: h.description, input_schema: h.inputSchema as Anthropic.Tool.InputSchema }));
}

/** Título con que se le presenta al modelo el estado del formulario abierto. */
export const MARCA_FORMULARIO = 'ESTADO ACTUAL DEL FORMULARIO';

/** contextoFormulario: lo que manda el chat del front con el formulario de solicitud abierto. */
/**
 * Red de seguridad: si la respuesta le dice al usuario que dé clic en un botón de
 * acción pero en este mensaje no se generó esa acción (el modelo no llamó la
 * herramienta o falló), se le avisa en vez de dejarlo buscando un botón que no hay.
 */
export function corregirPromesaDeBoton(reply: string, acciones: AccionChat[]): string {
  const prometeSolicitud = /abrir solicitud prellenada/i.test(reply);
  const prometeCircuito = /llenar (el )?circuito|usar este art[ií]culo/i.test(reply) && /bot[oó]n/i.test(reply);
  const falta =
    (prometeSolicitud && !acciones.some(a => a.tipo === 'prefill_solicitud')) ||
    (prometeCircuito && !acciones.some(a => a.tipo === 'llenar_circuito'));
  if (!falta) return reply;
  return `${reply}\n\n(Aviso: no se pudo preparar el botón en este mensaje. Pídemelo de nuevo, por ejemplo: "llénalo en el formulario".)`;
}

export function nuevoContexto(usuario: UsuarioMcp, contextoFormulario?: string | null): ContextoChat {
  return { usuario, acciones: [] as AccionChat[], formularioAbierto: !!contextoFormulario && contextoFormulario.trim().length > 0 };
}

/** Ejecuta una herramienta como el usuario. Nunca lanza: un fallo se devuelve como error para el modelo. */
export async function ejecutarHerramienta(
  nombre: string,
  args: unknown,
  ctx: ContextoChat,
): Promise<{ texto: string; error: boolean }> {
  const h = EJECUTABLES.find(x => x.name === nombre);
  if (!h) return { texto: `Herramienta desconocida: ${nombre}`, error: true };
  const t0 = Date.now();
  try {
    const datos = await h.correr(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}, ctx);
    console.log(`[QEBooh] usuario=${ctx.usuario.id} herramienta=${nombre} ok ${Date.now() - t0}ms`);
    return { texto: JSON.stringify(datos), error: false };
  } catch (e) {
    const mensaje = (e as Error).message || 'Error al consultar QEB';
    console.warn(`[QEBooh] usuario=${ctx.usuario.id} herramienta=${nombre} error ${Date.now() - t0}ms: ${mensaje}`);
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
- Si pregunta si hay espacio, cuantas caras libres u ocupadas hay en una plaza y catorcena, usa disponibilidad_inventario. Si pregunta quien tiene una cara concreta, usa ocupacion_cara. Presenta la disponibilidad como orientativa (es una foto del momento) y aclara que las reservas tentativas de propuestas no ocupan la cara. Solo la pueden consultar los roles que ven Inventarios; si la herramienta lo niega, explicalo.
- Al aconsejar un circuito, si el usuario tiene acceso, puedes revisar con disponibilidad_inventario si hay suficientes caras libres para las que pide.

REGLAS:
- NUNCA inventes datos, cifras, nombres ni IDs. Responde solo con lo que devuelvan las herramientas. Si una devuelve error o no hay resultados, dilo tal cual.
- Si una herramienta indica que el usuario no tiene acceso, explicaselo amablemente; no intentes otra via.
- No puedes crear, editar ni eliminar nada en QEB. La unica excepcion es preparar una solicitud prellenada (ver abajo), que el usuario termina y crea el mismo. Si piden otra accion, explica como hacerla en el sistema.
- Si el usuario tiene visibilidad total, "mis campañas" incluye las de todos: aclaralo y ofrece filtrar por asesor o cliente.
- Manten el formato de siempre: texto plano, sin markdown ni tablas. Para listas usa guiones, un registro por linea con lo esencial (ID, nombre, cliente, estatus, periodo). Si hay mas de 10 resultados, muestra los primeros 10, di cuantos hay en total y ofrece filtrar o ver mas.
- Escribe los montos con separador de miles y signo de pesos.
- Nunca menciones al usuario los nombres internos de tus herramientas (buscar_cliente, llenar_circuito, etc.) ni ids internos; habla de lo que haces ("busco el cliente", "lleno el circuito").
- Si una herramienta falla, dile al usuario que no pudiste consultar y que lo intente de nuevo. NUNCA rellenes el hueco con valores tipicos, ejemplos ni datos de tu base de conocimiento.
- Solo di que aparece un boton ("Abrir solicitud prellenada", "Llenar circuito") si en ESTE mismo mensaje llamaste preparar_solicitud o llenar_circuito y respondio listo. Si no la llamaste o fallo, no menciones ningun boton.
- NSE: los valores validos son los que devuelve opciones_inventario (en QEB son del tipo AB, ABC, ABC+, C, CD, CDE, D, DE). No uses la clasificacion A/B, C+, D+, E de tu base de conocimiento para capturar circuitos. Si el usuario dice "todos", manda nse: ["todos"] y el formulario selecciona todos los de la plaza.
- Cuando el usuario confirme ("si", "dale", "correcto") lo que propusiste para un circuito o una solicitud, llama la herramienta en ese mismo mensaje; no vuelvas a preguntar lo mismo.
- En buscar_articulo usa palabras de formato, plaza y tipo; no metas precios ni cantidades.

=== ARMAR UNA SOLICITUD NUEVA CON EL USUARIO ===

Si el usuario quiere hacer una solicitud nueva ("quiero una solicitud para Sephora"), ayudale a prellenarla. Tu no la creas: preparar_solicitud abre el formulario con los datos cargados y el usuario agrega los circuitos y la crea.

PASOS (pregunta lo que falte, uno o dos datos por mensaje, sin abrumar):
1. Cliente: usa buscar_cliente. Si hay varios registros (distinta marca, producto o base SAP), muestralos numerados con CUIC, marca, producto, agencia y base SAP, y pregunta cual es. Nunca elijas tu. No le muestres el cliente_id al usuario: es interno.
2. Nombre de la campaña.
3. Periodo en catorcenas: catorcena y año de inicio y de fin. Si dice "esta catorcena" o "la siguiente", usa catorcena_actual. Si pide un periodo mensual, explica que eso se captura directo en el formulario.
4. Descripcion Trafico (indicaciones para Trafico) y Notas Direccion (contexto para Direccion). Ambas son obligatorias; si no tiene que poner, ofrece un texto breve basado en lo que te dijo y confirmalo.
5. Asignados extra (opcional): el usuario queda asignado siempre. Si quiere agregar a alguien, usa usuarios_asignables.
6. Muestra un resumen y pide confirmacion. Solo con un si, llama preparar_solicitud. Los resultados de las herramientas NO se conservan entre mensajes: si ya no tienes el cliente_id a la vista, vuelve a usar buscar_cliente con el CUIC y la marca elegidos para obtenerlo.
7. Dile que de clic en "Abrir solicitud prellenada" debajo de tu mensaje. NO escribas etiquetas [NAV:...] para esto: el boton aparece solo.

Si preparar_solicitud responde que su rol no puede crear solicitudes, explicaselo y no insistas.

=== AYUDA MIENTRAS CAPTURA EL FORMULARIO ===

Cuando la pantalla actual incluya "ESTADO ACTUAL DEL FORMULARIO", el usuario tiene abierta la solicitud y ese bloque refleja lo que lleva capturado en este momento. Usalo para aconsejar en concreto:
- Que paso le falta y que campo le impide avanzar.
- Que articulo usar para la plaza y formato que busca (buscar_articulo). Prefiere articulos de renta (RT-).
- Que formatos y NSE existen en una plaza (opciones_inventario). Ofrece solo NSE que existan ahi.
- Si un circuito pedira autorizacion de Direccion: usa evaluar_circuito de inmediato con el articulo, formato, tipo, plaza, caras y tarifa. NO necesita NSE ni periodo; no los pidas para evaluar.
- Totales: caras, bonificacion e inversion de lo que lleva.
No repitas todo el estado; responde a lo que pregunta.

AGREGAR CIRCUITOS CON EL USUARIO (solo con el formulario abierto):
1. Entiende que quiere: plaza, formato, caras, bonificacion y en que catorcenas. Si la campaña abarca varias catorcenas y no lo aclara, pregunta si el circuito va en todas.
2. Busca el articulo (buscar_articulo) y, si no lo dijo, consulta los NSE de la plaza (opciones_inventario) y preguntale cuales.
3. Si hay bonificacion: no puede exceder las caras de renta y necesita un articulo de bonificacion (BF). llenar_circuito propone el BF equivalente si existe; si no, buscalo con buscar_articulo (incluir_bonificacion: true) y confirmalo.
4. Antes de llenar, dile tarifa, importe por catorcena y si pedira autorizacion (evaluar_circuito).
5. Llama llenar_circuito. Dile que de clic en el boton bajo tu mensaje, revise y de "Agregar". Un circuito a la vez; luego ofrece el siguiente.
6. Si solo quiere elegir el articulo, llama llenar_circuito solo con el articulo ("usar este articulo").
- Usa catorcenas que esten dentro del periodo de la campaña que aparece en el estado del formulario.
- Circuitos digitales (codigo con DIG y numero de circuito): las caras son fijas al tamaño del circuito; no prometas otra cantidad.
- Cortesias (CT-): no llevan caras de renta ni tarifa.
- Periodos mensuales y aeropuerto: no se pueden llenar desde el chat; que lo capture en el formulario.`;
