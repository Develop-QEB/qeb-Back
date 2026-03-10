import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

// Base path for "Fichas tecnicas" folder
const FICHAS_BASE_PATH = path.resolve(__dirname, '../../../Fichas tecnicas');

// Files to skip when building the tree
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

// MIME types for common file extensions
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain',
};

// Extensions that should be displayed inline in the browser
const INLINE_EXTENSIONS = new Set([
  '.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.tif',
]);

interface TreeNode {
  name: string;
  type: 'folder' | 'file';
  children?: TreeNode[];
  path?: string;
  ext?: string;
}

/**
 * Recursively builds a tree structure from a directory.
 */
function buildTree(dirPath: string, relativePath: string = ''): TreeNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders: TreeNode[] = [];
  const files: TreeNode[] = [];

  for (const entry of entries) {
    if (IGNORED_FILES.has(entry.name)) continue;

    const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = buildTree(path.join(dirPath, entry.name), entryRelativePath);
      folders.push({
        name: entry.name,
        type: 'folder',
        children,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase().replace('.', '');
      files.push({
        name: entry.name,
        type: 'file',
        path: entryRelativePath,
        ext: ext || undefined,
      });
    }
  }

  // Sort folders and files alphabetically, folders first
  folders.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  files.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));

  return [...folders, ...files];
}

/**
 * Validates that a path does not contain directory traversal sequences.
 */
function isPathSafe(filePath: string): boolean {
  // Reject any path containing ".." or starting with "/"
  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    return false;
  }
  // Resolve and verify it stays within the base path
  const resolved = path.resolve(FICHAS_BASE_PATH, filePath);
  return resolved.startsWith(FICHAS_BASE_PATH);
}

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/fichas-tecnicas/tree - Returns the full folder structure as nested JSON
router.get('/tree', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(FICHAS_BASE_PATH)) {
      return res.status(404).json({
        success: false,
        error: `La carpeta "Fichas tecnicas" no fue encontrada en la ruta configurada.`,
      });
    }

    const tree = buildTree(FICHAS_BASE_PATH);

    return res.json({
      success: true,
      data: tree,
    });
  } catch (error: any) {
    console.error('Error building fichas tecnicas tree:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al leer la estructura de fichas técnicas.',
    });
  }
});

// GET /api/fichas-tecnicas/file?path=AEROPUERTO/DIGITAL/somefile.jpg - Serves the actual file
router.get('/file', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: 'El parámetro "path" es requerido.',
      });
    }

    // Sanitize: prevent directory traversal
    if (!isPathSafe(filePath)) {
      return res.status(403).json({
        success: false,
        error: 'Ruta no permitida.',
      });
    }

    const absolutePath = path.resolve(FICHAS_BASE_PATH, filePath);

    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return res.status(404).json({
        success: false,
        error: 'Archivo no encontrado.',
      });
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const disposition = INLINE_EXTENSIONS.has(ext) ? 'inline' : 'attachment';
    const fileName = path.basename(absolutePath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(fileName)}"`);

    const fileStream = fs.createReadStream(absolutePath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Error al leer el archivo.',
        });
      }
    });
  } catch (error: any) {
    console.error('Error serving ficha tecnica file:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al servir el archivo.',
    });
  }
});

export default router;
