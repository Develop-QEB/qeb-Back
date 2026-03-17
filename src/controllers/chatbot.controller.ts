import { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { AuthRequest } from '../types';
import prisma from '../utils/prisma';

const BASE_SYSTEM_PROMPT = `Eres QEBbooh, el asistente virtual de QEB (Quality Equipment Billboard), una plataforma de gestion de publicidad exterior (OOH - Out of Home).

Tu personalidad:
- Amigable, conciso y profesional
- Respondes en espanol
- Usas un tono casual pero respetuoso
- Si no sabes algo, lo dices honestamente

FORMATO DE RESPUESTA: Responde SIEMPRE en texto plano. NUNCA uses formato markdown (no uses **, ##, *, backticks, ni ningun simbolo de formato). Usa saltos de linea para separar ideas. Para listas usa guiones simples (-) o numeros. Manten las respuestas cortas y directas.

ORTOGRAFIA: Usa siempre la ortografia correcta en espanol. Escribe "campana" como "campana" NUNCA, siempre escribe "campaña" con ene. Ejemplos correctos: "campaña", "campañas", "la campaña 19", "crear una campaña".

REGLA IMPORTANTE: SOLO respondes preguntas relacionadas con la plataforma QEB, sus funcionalidades, como usar el sistema, errores del sistema, y flujos de trabajo. Si el usuario pregunta algo personal, no relacionado con QEB (recetas, consejos personales, tareas del hogar, matematicas, historia, etc.), responde amablemente: "Hola! Soy QEBbooh y estoy aqui para ayudarte con todo lo relacionado a la plataforma QEB. Tienes alguna duda sobre el sistema?" No hagas excepciones a esta regla.

Modulos principales:

1. Dashboard - Vista general con metricas
2. Solicitudes - Los ejecutivos crean solicitudes de espacios publicitarios. Click en Nueva Solicitud, llenar cliente, caras, fechas. Estados: Pendiente, En revision, Aprobada, Rechazada
3. Propuestas - Se generan de solicitudes aprobadas. Se asigna inventario con mapa interactivo. Se comparte con cliente via link publico
4. Campañas - Se crean de propuestas aprobadas. Detalle muestra inventario reservado y mapa. Se asigna APS a espacios
5. Gestion de Artes (dentro de Campañas, Gestor de Tareas) - Tabs: Subir Artes, Revisar y Aprobar, Programacion, Impresiones, Validacion/Testigo
6. Inventarios - Catalogo de espacios publicitarios. Filtrar por plaza, mueble, estatus
7. Clientes - Gestion de clientes
8. Proveedores - Gestion de proveedores
9. Notificaciones/Tareas - Centro de notificaciones, vista lista o Kanban
10. Correos - Historial de correos del sistema
11. Perfil - Editar datos, cambiar contrasena, foto de perfil

Errores comunes:
- No se pueden cargar datos: Verificar internet, recargar pagina (F5)
- No aparecen espacios en mapa: Los espacios no tienen coordenadas
- No puedo asignar arte: Seleccionar al menos un espacio primero
- Boton deshabilitado (gris): Seleccionar items primero o falta permisos
- No veo un modulo: El rol no tiene acceso, contactar administrador
- Error al subir archivo: Verificar que sea imagen JPG/PNG o PDF, maximo 10MB

Tips:
- Usar filtros en tablas para encontrar informacion rapido
- Agrupar por campos como plaza, APS, periodo
- Buscar icono de descarga para exportar datos

NAVEGACION: Al final de cada respuesta, agrega sugerencias de navegacion usando este formato exacto (una por linea):
[NAV:ruta|texto del boton]

Rutas disponibles:
- /dashboard - Dashboard
- /solicitudes - Solicitudes
- /propuestas - Propuestas
- /campanas - Campañas
- /campanas/detail/ID - Detalle de campaña especifica (reemplaza ID con el numero)
- /campanas/ID/tareas - Gestion de artes de campaña especifica
- /inventarios - Inventarios
- /clientes - Clientes
- /proveedores - Proveedores
- /notificaciones - Notificaciones
- /correos - Correos
- /perfil - Perfil
- /admin/usuarios - Administrar usuarios

Ejemplos:
- Si preguntan "como edito la campaña 19" -> [NAV:/campanas/detail/19|Ir a Campaña 19]
- Si preguntan "donde veo las propuestas" -> [NAV:/propuestas|Ir a Propuestas]
- Si preguntan "como creo una solicitud" -> [NAV:/solicitudes|Ir a Solicitudes]
- Si mencionan varios modulos, agrega multiples NAV
- Si la pregunta es muy general y no aplica navegacion, no agregues NAV

IMPORTANTE: Los NAV van al final del texto, despues de tu respuesta. No los pongas dentro del texto.`;

function buildUserContext(nombre: string, rol: string, permisos: string | null): string {
  return `
---
CONTEXTO DEL USUARIO ACTUAL:
- Nombre: ${nombre}
- Rol: ${rol}
${permisos ? `- Restricciones de su rol: ${permisos}` : '- Sin restricciones especiales (acceso completo)'}

REGLA DE PERMISOS: Si el usuario pregunta como realizar una accion para la cual su rol no tiene permiso (segun las restricciones listadas arriba), responde amablemente que su rol de "${rol}" no tiene acceso a esa funcionalidad y que debe contactar a su administrador del sistema para obtenerlo. No inventes ni asumas permisos que no esten listados.`;
}

export class ChatbotController {
  private client: Anthropic | null = null;
  private tableChecked = false;

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY no configurada');
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  private async ensureTable(): Promise<void> {
    if (this.tableChecked) return;
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS chatbot_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          user_nombre VARCHAR(255) NOT NULL,
          user_email VARCHAR(255) NOT NULL,
          rol VARCHAR(255) DEFAULT NULL,
          pantalla VARCHAR(255) DEFAULT NULL,
          modal VARCHAR(255) DEFAULT NULL,
          pregunta TEXT NOT NULL,
          respuesta TEXT NOT NULL,
          categoria VARCHAR(255) DEFAULT NULL,
          off_topic TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Add columns if table already existed without them
      const alterCols = [
        `ALTER TABLE chatbot_logs ADD COLUMN rol VARCHAR(255) DEFAULT NULL`,
        `ALTER TABLE chatbot_logs ADD COLUMN modal VARCHAR(255) DEFAULT NULL`,
      ];
      for (const sql of alterCols) {
        try { await prisma.$executeRawUnsafe(sql); } catch { /* column already exists */ }
      }
      this.tableChecked = true;
    } catch (err) {
      console.error('[Chatbot] Error creating table:', err);
    }
  }

  private classifyQuestion(pregunta: string): string {
    const lower = pregunta.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const categories: [RegExp, string][] = [
      [/crear.*solicitud|nueva.*solicitud|solicitud.*nueva/, 'crear_solicitud'],
      [/editar.*solicitud|modificar.*solicitud/, 'editar_solicitud'],
      [/estado.*solicitud|solicitud.*estado|solicitud.*pendiente|solicitud.*aprobad/, 'estados_solicitud'],
      [/crear.*propuesta|nueva.*propuesta/, 'crear_propuesta'],
      [/editar.*propuesta|modificar.*propuesta/, 'editar_propuesta'],
      [/compartir.*propuesta|link.*propuesta|propuesta.*cliente/, 'compartir_propuesta'],
      [/asignar.*inventario|inventario.*propuesta/, 'asignar_inventario'],
      [/crear.*campana|nueva.*campana/, 'crear_campana'],
      [/editar.*campana|modificar.*campana/, 'editar_campana'],
      [/detalle.*campana|ver.*campana/, 'detalle_campana'],
      [/asignar.*aps|aps/, 'asignar_aps'],
      [/subir.*arte|cargar.*arte|asignar.*arte/, 'subir_artes'],
      [/aprobar.*arte|rechazar.*arte|revisar.*arte/, 'revisar_artes'],
      [/programacion|programar/, 'programacion'],
      [/impresion|imprimir/, 'impresiones'],
      [/testigo|instalacion|validar/, 'testigo_instalacion'],
      [/filtrar|filtro|buscar/, 'filtrar_datos'],
      [/exportar|descargar|download/, 'exportar_datos'],
      [/permiso|no puedo|no tengo acceso|acceso/, 'permisos'],
      [/error|no funciona|no carga|falla|problema/, 'error_sistema'],
      [/crear.*cliente|nuevo.*cliente/, 'crear_cliente'],
      [/editar.*cliente/, 'editar_cliente'],
      [/proveedor/, 'proveedores'],
      [/notificacion|tarea/, 'notificaciones'],
      [/contrasena|password|perfil/, 'perfil_cuenta'],
      [/inventario.*bloquear|bloquear|desbloquear/, 'bloquear_inventario'],
      [/mapa|ubicacion|coordenada/, 'mapa_ubicaciones'],
    ];
    for (const [pattern, category] of categories) {
      if (pattern.test(lower)) return category;
    }
    return 'general';
  }

  private async logConversation(
    userId: number, nombre: string, email: string, rol: string,
    pantalla: string | null, modal: string | null,
    pregunta: string, respuesta: string, offTopic: boolean,
  ): Promise<void> {
    try {
      await this.ensureTable();
      const categoria = offTopic ? 'off_topic' : this.classifyQuestion(pregunta);
      await prisma.$executeRawUnsafe(
        'INSERT INTO chatbot_logs (user_id, user_nombre, user_email, rol, pantalla, modal, pregunta, respuesta, categoria, off_topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        userId, nombre, email, rol, pantalla, modal, pregunta, respuesta, categoria, offTopic ? 1 : 0,
      );
    } catch (err) {
      console.error('[Chatbot] Error logging conversation:', err);
    }
  }

  private isClearlyOffTopic(text: string): boolean {
    const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const offTopicPatterns = [
      /^\d+\s*[\+\-\*\/x]\s*\d+/,
      /cuanto es \d/,
      /calcula/,
      /raiz cuadrada/,
      /receta/,
      /cocinar/,
      /ingredientes/,
      /comer hoy/,
      /comida/,
      /desayuno/,
      /cena/,
      /que hago con mi vida/,
      /consejo personal/,
      /relacion sentimental/,
      /mi novia/,
      /mi novio/,
      /chiste/,
      /cuentame algo gracioso/,
      /cancion/,
      /pelicula/,
      /serie de tv/,
      /netflix/,
      /capital de/,
      /presidente de/,
      /quien invento/,
      /codigo en python/,
      /codigo en java/,
      /clima/,
      /temperatura/,
      /va a llover/,
      /futbol/,
      /partido/,
      /champions/,
      /dolor de cabeza/,
      /medicina/,
      /donde compro/,
      /amazon/,
      /mercado libre/,
    ];
    return offTopicPatterns.some(p => p.test(lower));
  }

  async chat(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { messages, pantalla, modal, permisos } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ success: false, error: 'Se requiere un array de messages' });
        return;
      }

      const userId = req.user?.userId || 0;
      const userName = req.user?.nombre || 'Desconocido';
      const userEmail = req.user?.email || '';
      const userRol = req.user?.rol || 'Desconocido';

      const lastUserMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'user');
      const pregunta = lastUserMessage?.content || '';

      if (lastUserMessage && this.isClearlyOffTopic(pregunta)) {
        const offTopicReply = 'Hola! Soy QEBbooh y estoy aqui para ayudarte con todo lo relacionado a la plataforma QEB. Tienes alguna duda sobre el sistema?';
        this.logConversation(userId, userName, userEmail, userRol, pantalla || null, modal || null, pregunta, offTopicReply, true).catch(() => {});
        res.json({ success: true, data: { reply: offTopicReply } });
        return;
      }

      const client = this.getClient();
      const systemPrompt = BASE_SYSTEM_PROMPT + buildUserContext(userName, userRol, permisos || null);

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.map((m: { role: string; content: string }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      const textBlock = response.content.find((b: { type: string }) => b.type === 'text') as { type: 'text'; text: string } | undefined;
      const reply = textBlock ? textBlock.text : '';

      this.logConversation(userId, userName, userEmail, userRol, pantalla || null, modal || null, pregunta, reply, false).catch(() => {});

      res.json({ success: true, data: { reply } });
    } catch (error) {
      console.error('Error en chatbot:', error);
      const message = error instanceof Error ? error.message : 'Error en el chatbot';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const chatbotController = new ChatbotController();
