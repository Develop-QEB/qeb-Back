import 'dotenv/config';
import prisma from '../utils/prisma';
import { isSpacesConfigured, uploadBufferToSpaces } from '../config/spaces';

type Mode = 'dry-run' | 'commit';
type TableName = 'solicitud' | 'reservas' | 'tickets' | 'imagenes_digitales';

interface CliOptions {
  mode: Mode;
  batchSize: number;
  tables: TableName[];
}

interface RowSolicitud {
  id: number;
  archivo: string | null;
  tipo_archivo: string | null;
}

interface RowReserva {
  id: number;
  archivo: string | null;
}

interface RowTicket {
  id: number;
  imagen: string | null;
}

interface RowImagenDigital {
  id: number;
  archivo: string;
  archivo_data: string | null;
}

interface ParsedContent {
  buffer: Buffer;
  mimeType: string;
}

interface TableStats {
  scanned: number;
  candidates: number;
  migrated: number;
  skipped: number;
  errors: number;
  bytes: number;
}

const DEFAULT_TABLES: TableName[] = ['solicitud', 'reservas', 'tickets', 'imagenes_digitales'];
const ALLOWED_TABLES = new Set<TableName>(DEFAULT_TABLES);

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'dry-run',
    batchSize: 100,
    tables: [...DEFAULT_TABLES],
  };

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length).trim() as Mode;
      if (value !== 'dry-run' && value !== 'commit') {
        throw new Error(`--mode invalido: ${value}. Usa dry-run o commit.`);
      }
      options.mode = value;
      continue;
    }

    if (arg.startsWith('--batch=')) {
      const raw = Number(arg.slice('--batch='.length).trim());
      if (!Number.isInteger(raw) || raw <= 0) {
        throw new Error(`--batch invalido: ${arg}`);
      }
      options.batchSize = raw;
      continue;
    }

    if (arg.startsWith('--tables=')) {
      const raw = arg.slice('--tables='.length).trim();
      const parsed = raw
        .split(',')
        .map(t => t.trim())
        .filter(Boolean) as TableName[];

      if (!parsed.length) {
        throw new Error('--tables vacio');
      }

      for (const t of parsed) {
        if (!ALLOWED_TABLES.has(t)) {
          throw new Error(`Tabla no soportada en --tables: ${t}`);
        }
      }
      options.tables = parsed;
      continue;
    }
  }

  return options;
}

function isLikelyUrl(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('/uploads/');
}

function normalizeBase64Payload(payload: string): string {
  return payload.replace(/\s+/g, '');
}

function isValidBase64Payload(payload: string): boolean {
  if (!payload || payload.length < 128) return false;
  if (payload.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(payload);
}

function inferMimeFromBuffer(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a) return 'image/png';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  return 'application/octet-stream';
}

function extensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'video/mp4': 'mp4',
  };
  return map[mimeType] || 'bin';
}

function parsePossiblyBase64(value: string | null, explicitMime?: string | null): ParsedContent | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || isLikelyUrl(raw)) return null;

  const dataUriMatch = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUriMatch) {
    const mime = dataUriMatch[1]?.trim() || 'application/octet-stream';
    const payload = normalizeBase64Payload(dataUriMatch[2] || '');
    if (!isValidBase64Payload(payload)) return null;
    const buffer = Buffer.from(payload, 'base64');
    if (!buffer.length) return null;
    return { buffer, mimeType: mime };
  }

  const payload = normalizeBase64Payload(raw);
  if (!isValidBase64Payload(payload)) return null;
  const buffer = Buffer.from(payload, 'base64');
  if (!buffer.length) return null;

  const detectedMime = explicitMime?.trim() || inferMimeFromBuffer(buffer);
  return { buffer, mimeType: detectedMime };
}

function createStats(): TableStats {
  return {
    scanned: 0,
    candidates: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
    bytes: 0,
  };
}

async function migrateSolicitudes(mode: Mode, batchSize: number): Promise<TableStats> {
  const stats = createStats();
  let lastId = 0;

  while (true) {
    const rows = await prisma.$queryRawUnsafe<RowSolicitud[]>(
      `SELECT id, archivo, tipo_archivo
       FROM solicitud
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      lastId,
      batchSize
    );

    if (!rows.length) break;

    for (const row of rows) {
      lastId = row.id;
      stats.scanned += 1;

      const parsed = parsePossiblyBase64(row.archivo, row.tipo_archivo);
      if (!parsed) {
        stats.skipped += 1;
        continue;
      }

      stats.candidates += 1;
      stats.bytes += parsed.buffer.length;

      if (mode === 'dry-run') {
        continue;
      }

      try {
        const ext = extensionFromMime(parsed.mimeType);
        const uploaded = await uploadBufferToSpaces(parsed.buffer, {
          folder: 'migrations/solicitud',
          originalName: `solicitud-${row.id}.${ext}`,
          mimeType: parsed.mimeType,
        });

        await prisma.$executeRawUnsafe(
          'UPDATE solicitud SET archivo = ?, tipo_archivo = ? WHERE id = ?',
          uploaded.url,
          parsed.mimeType,
          row.id
        );
        stats.migrated += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(`[solicitud:${row.id}] error:`, error);
      }
    }
  }

  return stats;
}

async function migrateReservas(mode: Mode, batchSize: number): Promise<TableStats> {
  const stats = createStats();
  let lastId = 0;

  while (true) {
    const rows = await prisma.$queryRawUnsafe<RowReserva[]>(
      `SELECT id, archivo
       FROM reservas
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      lastId,
      batchSize
    );

    if (!rows.length) break;

    for (const row of rows) {
      lastId = row.id;
      stats.scanned += 1;

      const parsed = parsePossiblyBase64(row.archivo);
      if (!parsed) {
        stats.skipped += 1;
        continue;
      }

      stats.candidates += 1;
      stats.bytes += parsed.buffer.length;

      if (mode === 'dry-run') {
        continue;
      }

      try {
        const ext = extensionFromMime(parsed.mimeType);
        const uploaded = await uploadBufferToSpaces(parsed.buffer, {
          folder: 'migrations/reservas',
          originalName: `reserva-${row.id}.${ext}`,
          mimeType: parsed.mimeType,
        });

        await prisma.$executeRawUnsafe(
          'UPDATE reservas SET archivo = ? WHERE id = ?',
          uploaded.url,
          row.id
        );
        stats.migrated += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(`[reservas:${row.id}] error:`, error);
      }
    }
  }

  return stats;
}

async function migrateTickets(mode: Mode, batchSize: number): Promise<TableStats> {
  const stats = createStats();
  let lastId = 0;

  while (true) {
    const rows = await prisma.$queryRawUnsafe<RowTicket[]>(
      `SELECT id, imagen
       FROM tickets
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      lastId,
      batchSize
    );

    if (!rows.length) break;

    for (const row of rows) {
      lastId = row.id;
      stats.scanned += 1;

      const parsed = parsePossiblyBase64(row.imagen);
      if (!parsed) {
        stats.skipped += 1;
        continue;
      }

      stats.candidates += 1;
      stats.bytes += parsed.buffer.length;

      if (mode === 'dry-run') {
        continue;
      }

      try {
        const ext = extensionFromMime(parsed.mimeType);
        const uploaded = await uploadBufferToSpaces(parsed.buffer, {
          folder: 'migrations/tickets',
          originalName: `ticket-${row.id}.${ext}`,
          mimeType: parsed.mimeType,
        });

        await prisma.$executeRawUnsafe(
          'UPDATE tickets SET imagen = ? WHERE id = ?',
          uploaded.url,
          row.id
        );
        stats.migrated += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(`[tickets:${row.id}] error:`, error);
      }
    }
  }

  return stats;
}

async function migrateImagenesDigitales(mode: Mode, batchSize: number): Promise<TableStats> {
  const stats = createStats();
  let lastId = 0;

  while (true) {
    const rows = await prisma.$queryRawUnsafe<RowImagenDigital[]>(
      `SELECT id, archivo, archivo_data
       FROM imagenes_digitales
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`,
      lastId,
      batchSize
    );

    if (!rows.length) break;

    for (const row of rows) {
      lastId = row.id;
      stats.scanned += 1;

      const parsedFromArchivoData = parsePossiblyBase64(row.archivo_data);
      const parsedFromArchivo = parsedFromArchivoData ? null : parsePossiblyBase64(row.archivo);
      const parsed = parsedFromArchivoData || parsedFromArchivo;

      if (!parsed) {
        stats.skipped += 1;
        continue;
      }

      stats.candidates += 1;
      stats.bytes += parsed.buffer.length;

      if (mode === 'dry-run') {
        continue;
      }

      try {
        const ext = extensionFromMime(parsed.mimeType);
        const uploaded = await uploadBufferToSpaces(parsed.buffer, {
          folder: 'migrations/imagenes-digitales',
          originalName: `imagen-digital-${row.id}.${ext}`,
          mimeType: parsed.mimeType,
        });

        await prisma.$executeRawUnsafe(
          'UPDATE imagenes_digitales SET archivo = ?, archivo_data = NULL WHERE id = ?',
          uploaded.url,
          row.id
        );
        stats.migrated += 1;
      } catch (error) {
        stats.errors += 1;
        console.error(`[imagenes_digitales:${row.id}] error:`, error);
      }
    }
  }

  return stats;
}

function printTableStats(table: TableName, stats: TableStats): void {
  const mb = (stats.bytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[${table}] scanned=${stats.scanned} candidates=${stats.candidates} migrated=${stats.migrated} skipped=${stats.skipped} errors=${stats.errors} sizeMB=${mb}`
  );
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === 'commit' && !isSpacesConfigured()) {
    throw new Error('Modo commit requiere SPACES_ACCESS_KEY, SPACES_SECRET_KEY y SPACES_BUCKET configurados.');
  }

  console.log(`[base64->spaces] mode=${options.mode} batch=${options.batchSize} tables=${options.tables.join(',')}`);

  await prisma.$connect();

  const summary: Record<TableName, TableStats> = {
    solicitud: createStats(),
    reservas: createStats(),
    tickets: createStats(),
    imagenes_digitales: createStats(),
  };

  try {
    for (const table of options.tables) {
      if (table === 'solicitud') {
        summary.solicitud = await migrateSolicitudes(options.mode, options.batchSize);
      } else if (table === 'reservas') {
        summary.reservas = await migrateReservas(options.mode, options.batchSize);
      } else if (table === 'tickets') {
        summary.tickets = await migrateTickets(options.mode, options.batchSize);
      } else if (table === 'imagenes_digitales') {
        summary.imagenes_digitales = await migrateImagenesDigitales(options.mode, options.batchSize);
      }
      printTableStats(table, summary[table]);
    }

    let totalScanned = 0;
    let totalCandidates = 0;
    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalBytes = 0;

    for (const table of options.tables) {
      const s = summary[table];
      totalScanned += s.scanned;
      totalCandidates += s.candidates;
      totalMigrated += s.migrated;
      totalSkipped += s.skipped;
      totalErrors += s.errors;
      totalBytes += s.bytes;
    }

    const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `[TOTAL] scanned=${totalScanned} candidates=${totalCandidates} migrated=${totalMigrated} skipped=${totalSkipped} errors=${totalErrors} sizeMB=${totalMb}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error('[base64->spaces] fatal error:', error);
  process.exit(1);
});

