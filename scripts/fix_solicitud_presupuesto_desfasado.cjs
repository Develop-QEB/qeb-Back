#!/usr/bin/env node
/**
 * Fix masivo: solicitud.presupuesto quedó desfasado respecto a la suma real
 * de solicitudCaras en ~34% de las solicitudes del año porque no se recalculaba
 * al agregar/quitar caras desde Propuestas o Campañas (Jos 2026-11-10, ticket
 * #516 reportado por Elvia con la solicitud #81488).
 *
 * El fix de código ya cubre que no vuelva a pasar (listado suma en vivo +
 * hooks en create/update/delete de caras). Este script normaliza los registros
 * existentes en una sola corrida.
 *
 * Uso:
 *   # Dry-run (solo imprime lo que haría, no modifica nada):
 *   node scripts/fix_solicitud_presupuesto_desfasado.cjs
 *
 *   # Ejecutar de verdad (requiere flag explícita):
 *   node scripts/fix_solicitud_presupuesto_desfasado.cjs --commit
 *
 * Seguridad:
 *   - Antes de cualquier UPDATE guarda snapshot JSON en scripts/snapshots/
 *     con {id, presupuesto_anterior, presupuesto_nuevo, suma_caras, n_caras}.
 *   - Solo toca solicitudes que:
 *       * están vivas (deleted_at IS NULL)
 *       * tienen al menos 1 cara en solicitudCaras
 *       * tienen una divergencia > $1 entre presupuesto_guardado y suma_real
 *     No toca solicitudes sin caras (preserva el valor histórico del asesor).
 *   - UPDATEs se corren en lotes de 100 con parámetros binded (no interpolación
 *     de SQL). Si cualquier batch falla, el proceso aborta.
 *
 * Reversión:
 *   - Re-correr con un script inverso leyendo el snapshot JSON.
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const COMMIT = process.argv.includes('--commit');
const BATCH_SIZE = 100;

function parseDbUrl(raw) {
  const u = new URL(raw);
  return {
    host: u.hostname,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    port: Number(u.port) || 3306,
    ssl: { rejectUnauthorized: false },
  };
}

async function main() {
  require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL en el entorno. Usa ENV_FILE=.env.backup-prod node scripts/fix_solicitud_presupuesto_desfasado.cjs');
    process.exit(1);
  }
  const conn = await mysql.createConnection(parseDbUrl(process.env.DATABASE_URL));
  await conn.query('SET SESSION MAX_EXECUTION_TIME=300000');

  console.log('=================================================');
  console.log('Fix solicitud.presupuesto desfasado');
  console.log('DB:', process.env.DATABASE_URL.split('@')[1]?.split('?')[0] || '(desconocida)');
  console.log('Modo:', COMMIT ? 'EJECUTAR UPDATE' : 'DRY-RUN (no modifica nada)');
  console.log('=================================================');
  console.log();

  console.log('Escaneando solicitudes…');
  const [rows] = await conn.query(`
    SELECT s.id,
           CAST(s.presupuesto AS DECIMAL(15,2)) presupuesto_guardado,
           ROUND(COALESCE(sc.suma, 0), 2) suma_caras,
           COALESCE(sc.n, 0) n_caras,
           s.status,
           s.razon_social
      FROM solicitud s
      LEFT JOIN (
        SELECT CAST(idquote AS UNSIGNED) idn, SUM(costo) suma, COUNT(*) n
          FROM solicitudCaras
         GROUP BY idquote
      ) sc ON sc.idn = s.id
     WHERE s.deleted_at IS NULL
       AND sc.n > 0
  `);

  const divergentes = rows.filter(r => Math.abs(Number(r.presupuesto_guardado || 0) - Number(r.suma_caras || 0)) > 1);
  console.log('Total solicitudes vivas con caras:', rows.length);
  console.log('Divergentes a corregir:         ', divergentes.length);
  if (divergentes.length === 0) {
    console.log('Nada que hacer. Saliendo.');
    await conn.end();
    return;
  }

  // Snapshot
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotsDir = path.join(__dirname, 'snapshots');
  if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });
  const snapshotFile = path.join(snapshotsDir, `fix_presupuesto_${ts}.json`);
  const snapshot = divergentes.map(r => ({
    id: r.id,
    presupuesto_anterior: Number(r.presupuesto_guardado || 0),
    presupuesto_nuevo: Number(r.suma_caras || 0),
    suma_caras: Number(r.suma_caras || 0),
    n_caras: Number(r.n_caras || 0),
    status: r.status,
    razon_social: r.razon_social,
  }));
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
  console.log('Snapshot guardado en:', snapshotFile);
  console.log();

  // Top 10 ejemplos
  console.log('=== Top 10 diferencias absolutas más grandes ===');
  const top = [...snapshot]
    .sort((a, b) => Math.abs(b.presupuesto_anterior - b.presupuesto_nuevo) - Math.abs(a.presupuesto_anterior - a.presupuesto_nuevo))
    .slice(0, 10);
  for (const r of top) {
    const diff = r.presupuesto_nuevo - r.presupuesto_anterior;
    const flecha = diff > 0 ? '↑' : '↓';
    console.log(`  #${r.id} | ${r.status} | de $${r.presupuesto_anterior.toLocaleString()} → $${r.presupuesto_nuevo.toLocaleString()} ${flecha} (${r.razon_social?.substring(0, 30) || ''})`);
  }
  console.log();

  if (!COMMIT) {
    console.log('Dry-run finalizado. Revisa el snapshot y re-corre con --commit para aplicar.');
    await conn.end();
    return;
  }

  console.log(`Aplicando UPDATE en lotes de ${BATCH_SIZE}…`);
  let actualizadas = 0;
  for (let i = 0; i < snapshot.length; i += BATCH_SIZE) {
    const lote = snapshot.slice(i, i + BATCH_SIZE);
    for (const r of lote) {
      // UPDATE individual con bind params (más seguro que un CASE masivo).
      const [res] = await conn.query(
        `UPDATE solicitud SET presupuesto = ? WHERE id = ? AND deleted_at IS NULL`,
        [r.presupuesto_nuevo.toFixed(2), r.id]
      );
      if (res.affectedRows > 0) actualizadas++;
    }
    console.log(`  ${Math.min(i + BATCH_SIZE, snapshot.length)} / ${snapshot.length} procesadas (${actualizadas} filas actualizadas)`);
  }

  console.log();
  console.log('=================================================');
  console.log(`Listo. ${actualizadas} solicitudes normalizadas.`);
  console.log(`Snapshot de respaldo: ${snapshotFile}`);
  console.log('=================================================');
  await conn.end();
}

main().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
