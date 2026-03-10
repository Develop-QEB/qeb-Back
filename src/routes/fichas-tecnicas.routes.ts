import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import {
  isSpacesConfigured,
  getClient,
  getBucket,
  getPublicBaseUrl,
  ListObjectsV2Command,
} from '../config/spaces';

const router = Router();

const SPACES_PREFIX = 'fichas-tecnicas/';

interface TreeNode {
  name: string;
  type: 'folder' | 'file';
  children?: TreeNode[];
  path?: string;
  ext?: string;
}

/**
 * Builds a tree from a flat list of S3 object keys.
 */
function buildTreeFromKeys(keys: string[]): TreeNode[] {
  const root: TreeNode = { name: 'root', type: 'folder', children: [] };

  for (const key of keys) {
    // Remove the prefix to get relative path
    const relativePath = key.startsWith(SPACES_PREFIX) ? key.slice(SPACES_PREFIX.length) : key;
    if (!relativePath) continue;

    const parts = relativePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isFile = i === parts.length - 1;

      if (isFile) {
        const ext = part.includes('.') ? part.split('.').pop()?.toLowerCase() : undefined;
        current.children!.push({
          name: part,
          type: 'file',
          path: relativePath,
          ext,
        });
      } else {
        let folder = current.children!.find(c => c.type === 'folder' && c.name === part);
        if (!folder) {
          folder = { name: part, type: 'folder', children: [] };
          current.children!.push(folder);
        }
        current = folder;
      }
    }
  }

  // Sort recursively: folders first, then files, both alphabetically
  function sortTree(nodes: TreeNode[]): TreeNode[] {
    const folders = nodes.filter(n => n.type === 'folder').sort((a, b) =>
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    );
    const files = nodes.filter(n => n.type === 'file').sort((a, b) =>
      a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    );

    for (const folder of folders) {
      if (folder.children) {
        folder.children = sortTree(folder.children);
      }
    }

    return [...folders, ...files];
  }

  return sortTree(root.children || []);
}

// Apply auth middleware
router.use(authMiddleware);

// GET /api/fichas-tecnicas/tree
router.get('/tree', async (_req: Request, res: Response) => {
  try {
    if (!isSpacesConfigured()) {
      return res.status(500).json({
        success: false,
        error: 'DigitalOcean Spaces no está configurado.',
      });
    }

    const client = getClient();
    const bucket = getBucket();
    const allKeys: string[] = [];
    let continuationToken: string | undefined;

    // Paginate through all objects with the prefix
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: SPACES_PREFIX,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await client.send(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key) {
            allKeys.push(obj.Key);
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    const tree = buildTreeFromKeys(allKeys);

    return res.json({
      success: true,
      data: tree,
    });
  } catch (error: any) {
    console.error('Error listing fichas tecnicas from Spaces:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al leer la estructura de fichas técnicas.',
    });
  }
});

// GET /api/fichas-tecnicas/file?path=AEROPUERTO/DIGITAL/somefile.jpg
// Returns the public Spaces URL for the file
router.get('/file', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;

    if (!filePath) {
      return res.status(400).json({
        success: false,
        error: 'El parámetro "path" es requerido.',
      });
    }

    // Prevent directory traversal
    if (filePath.includes('..') || filePath.startsWith('/')) {
      return res.status(403).json({
        success: false,
        error: 'Ruta no permitida.',
      });
    }

    const baseUrl = getPublicBaseUrl();
    const key = `${SPACES_PREFIX}${filePath}`;
    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const url = `${baseUrl}/${encodedKey}`;

    return res.redirect(url);
  } catch (error: any) {
    console.error('Error serving ficha tecnica file:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al servir el archivo.',
    });
  }
});

export default router;
