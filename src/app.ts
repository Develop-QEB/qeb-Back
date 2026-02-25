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
    'http://localhost:5177',
    'https://front-qeb.vercel.app'
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

const corsOptions = {
  origin: getAllowedOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
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

app.use('/api', routes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
