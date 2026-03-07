import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import routes from './routes';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware';

const app = express();

// Parse FRONTEND_URL: puede ser un solo URL o múltiples separados por coma
const getAllowedOrigins = () => {
  const defaultOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'https://front-qeb-pi.vercel.app',
    'https://front-16yzokren-qeb.vercel.app',
    'http://localhost:5177',
    'https://front-qeb.vercel.app',
    'https://app.qeb.mx'
  ];

  const envUrl = process.env.FRONTEND_URL;
  if (!envUrl) {
    return defaultOrigins;
  }
  // Si contiene comas, separar en array y agregar los defaults
  if (envUrl.includes(',')) {
    const envOrigins = envUrl.split(',').map(url => url.trim());
    return [...new Set([...defaultOrigins, ...envOrigins])];
  }
  return [...new Set([...defaultOrigins, envUrl])];
};

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Permitir requests sin Origin (health checks, curl, server-to-server)
    if (!origin) return callback(null, true);

    const allowedOrigins = getAllowedOrigins();
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Permitir headers dinámicos del preflight para evitar bloqueos por headers extras.
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
// Log ALL incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  next();
});
app.use(morgan('dev'));
// Aumentar límite para soportar archivos base64 (videos pueden ser grandes)
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Servir archivos estáticos de uploads con CORS permisivo para imágenes
app.use('/uploads', (req, res, next) => {
  // Headers para permitir acceso desde cualquier origen (imágenes públicas)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, '../uploads'), {
  // Establecer cache para mejor rendimiento
  maxAge: '1d',
  // Permitir que las imágenes se carguen incluso si el path no coincide exactamente
  fallthrough: true,
}));

// Public route for client propuesta view (no auth required)
import { propuestasController } from './controllers/propuestas.controller';
app.get('/public/propuestas/:id', propuestasController.getPublicDetails.bind(propuestasController));

// Evitar que el navegador cachee respuestas de la API
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use('/api', routes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
