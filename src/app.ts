import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import routes from './routes';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware';

const app = express();

// Parse FRONTEND_URL: puede ser un solo URL o múltiples separados por coma
const getAllowedOrigins = () => {
  const envUrl = process.env.FRONTEND_URL;
  if (!envUrl) {
    return ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:5176', 'http://localhost:5177'];
  }
  // Si contiene comas, separar en array
  if (envUrl.includes(',')) {
    return envUrl.split(',').map(url => url.trim());
  }
  return envUrl;
};

const corsOptions = {
  origin: getAllowedOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api', routes);

app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
