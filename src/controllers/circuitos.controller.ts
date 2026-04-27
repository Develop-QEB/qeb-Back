import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../types';
import { parseCircuitoDigital } from '../lib/circuitos';

const prisma = new PrismaClient();

// plazaCode (del itemCode) → WHERE clause sobre inventarios.plaza
const PLAZA_CODE_TO_SQL_LIKE: Record<string, string> = {
  MX: 'CIUDAD DE M%', // captura "Ciudad de México" con/sin acento y mayúsculas
  MTY: 'MONTERREY%',
};

function plazaLike(plazaCode: string): string {
  return PLAZA_CODE_TO_SQL_LIKE[plazaCode.toUpperCase()] || `${plazaCode}%`;
}

class CircuitosController {
  /**
   * GET /circuitos/list
   * Lista todos los circuitos que existen en el inventario.
   * Respuesta: [{ cto, ctoLabel, plazaCode, plazaLabel, total, muebles: {parabus, columna, multiservicio}}]
   */
  async list(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const rows = await prisma.$queryRaw<
        { cto: string; plaza: string; mueble: string | null; total: bigint }[]
      >`
        SELECT cto, UPPER(plaza) as plaza, mueble, COUNT(*) as total
        FROM inventarios
        WHERE cto IS NOT NULL AND cto <> ''
        GROUP BY cto, UPPER(plaza), mueble
        ORDER BY cto, UPPER(plaza), mueble
      `;

      // Agrupar por CTO + plaza
      type GroupKey = string;
      const groups = new Map<
        GroupKey,
        { cto: string; plaza: string; total: number; muebles: Record<string, number> }
      >();
      for (const r of rows) {
        const key = `${r.cto}|${r.plaza}`;
        if (!groups.has(key)) {
          groups.set(key, { cto: r.cto, plaza: r.plaza, total: 0, muebles: {} });
        }
        const g = groups.get(key)!;
        const count = Number(r.total);
        g.total += count;
        if (r.mueble) g.muebles[r.mueble] = (g.muebles[r.mueble] || 0) + count;
      }

      const data = Array.from(groups.values()).map(g => ({
        cto: g.cto,
        plaza: g.plaza,
        total: g.total,
        muebles: g.muebles,
      }));

      res.json({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al listar circuitos';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * GET /circuitos/detalle?itemCode=RT-DIG-03-MX
   * o /circuitos/detalle?cto=3&plazaCode=MX
   *
   * Devuelve el total y los ids de inventarios de ese circuito.
   */
  async detalle(req: AuthRequest, res: Response): Promise<void> {
    try {
      let ctoNum: number | null = null;
      let plazaCode: string | null = null;

      const itemCode = req.query.itemCode as string | undefined;
      if (itemCode) {
        const info = parseCircuitoDigital(itemCode);
        if (!info) {
          res.status(400).json({ success: false, error: 'itemCode no es un circuito válido' });
          return;
        }
        ctoNum = info.cto;
        plazaCode = info.plazaCode;
      } else {
        ctoNum = parseInt((req.query.cto as string) || '', 10);
        plazaCode = (req.query.plazaCode as string) || '';
        if (!Number.isFinite(ctoNum!) || !plazaCode) {
          res.status(400).json({ success: false, error: 'Faltan parámetros cto y plazaCode' });
          return;
        }
      }

      const ctoLabel = `CTO ${ctoNum}`;
      const like = plazaLike(plazaCode!);

      const inventarios = await prisma.$queryRawUnsafe<
        { id: number; codigo_unico: string; mueble: string; tradicional_digital: string; plaza: string }[]
      >(
        `SELECT id, codigo_unico, mueble, tradicional_digital, plaza
         FROM inventarios
         WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)
         ORDER BY id`,
        ctoLabel,
        like
      );

      // Agrupar por mueble para obtener el dominante
      const porMueble: Record<string, number> = {};
      for (const inv of inventarios) {
        if (inv.mueble) porMueble[inv.mueble] = (porMueble[inv.mueble] || 0) + 1;
      }
      const muebleDominante = Object.entries(porMueble).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      // Conteo real de Flujo / Contraflujo (incluye variantes Flujo2, Contraflujo2)
      const tiposCara = await prisma.$queryRawUnsafe<{ tipo_de_cara: string | null; c: bigint }[]>(
        `SELECT tipo_de_cara, COUNT(*) as c FROM inventarios
         WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)
         GROUP BY tipo_de_cara`,
        ctoLabel,
        like
      );
      let flujoCount = 0;
      let contraflujoCount = 0;
      for (const r of tiposCara) {
        const tc = (r.tipo_de_cara || '').toLowerCase();
        const cnt = Number(r.c);
        if (tc.startsWith('contraflujo')) contraflujoCount += cnt;
        else if (tc.startsWith('flujo')) flujoCount += cnt;
      }

      res.json({
        success: true,
        data: {
          cto: ctoNum,
          ctoLabel,
          plazaCode,
          total: inventarios.length,
          muebles: porMueble,
          muebleDominante,
          flujo: flujoCount,
          contraflujo: contraflujoCount,
          inventarios,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al obtener detalle de circuito';
      res.status(500).json({ success: false, error: message });
    }
  }

  /**
   * POST /circuitos/check-disponibilidad
   * body: { itemCode, fecha_inicio, fecha_fin }
   * Verifica que todos los inventarios del circuito NO tengan reservas
   * activas que solapen con el rango. Devuelve conflictos si los hay.
   */
  async checkDisponibilidad(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { itemCode, fecha_inicio, fecha_fin } = req.body as {
        itemCode?: string;
        fecha_inicio?: string;
        fecha_fin?: string;
      };
      if (!itemCode || !fecha_inicio || !fecha_fin) {
        res.status(400).json({ success: false, error: 'Faltan campos: itemCode, fecha_inicio, fecha_fin' });
        return;
      }
      const info = parseCircuitoDigital(itemCode);
      if (!info) {
        res.status(400).json({ success: false, error: 'itemCode no es un circuito válido' });
        return;
      }

      const like = plazaLike(info.plazaCode);

      // Inventarios del circuito
      const invs = await prisma.$queryRawUnsafe<{ id: number; codigo_unico: string }[]>(
        `SELECT id, codigo_unico FROM inventarios
         WHERE cto = ? AND UPPER(plaza) LIKE UPPER(?)`,
        info.ctoLabel,
        like
      );

      if (invs.length === 0) {
        res.json({
          success: true,
          data: { disponible: false, total: 0, conflictos: [], motivo: 'Circuito sin inventarios registrados' },
        });
        return;
      }

      const invIds = invs.map(i => i.id);
      const placeholders = invIds.map(() => '?').join(',');

      // Reservas que solapan con el rango — via espacio_inventario
      const conflictos = await prisma.$queryRawUnsafe<
        { inventario_id: number; codigo_unico: string; fecha_inicio: Date; fecha_fin: Date; propuesta_id: number | null }[]
      >(
        `SELECT inv.id as inventario_id, inv.codigo_unico,
                sc.inicio_periodo as fecha_inicio, sc.fin_periodo as fecha_fin,
                CAST(sc.idquote AS UNSIGNED) as propuesta_id
         FROM reservas r
         INNER JOIN espacio_inventario ei ON ei.id = r.inventario_id
         INNER JOIN inventarios inv ON inv.id = ei.inventario_id
         INNER JOIN solicitudCaras sc ON sc.id = r.solicitudCaras_id
         WHERE inv.id IN (${placeholders})
           AND r.deleted_at IS NULL
           AND r.estatus NOT IN ('eliminada', 'Eliminada', 'cancelado', 'Cancelado')
           AND NOT (sc.fin_periodo < ? OR sc.inicio_periodo > ?)
         ORDER BY inv.id, sc.inicio_periodo`,
        ...invIds,
        fecha_inicio,
        fecha_fin
      );

      res.json({
        success: true,
        data: {
          disponible: conflictos.length === 0,
          total: invs.length,
          conflictos,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error al validar disponibilidad';
      res.status(500).json({ success: false, error: message });
    }
  }
}

export const circuitosController = new CircuitosController();
