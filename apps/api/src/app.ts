import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import healthRoutes from './modules/health/health.routes.js';
import userRoutes from './modules/users.routes.js';
import organizationRoutes from './modules/organizations.routes.js';
import flightRoutes from './modules/flights.routes.js';
import bookingRoutes from './modules/bookings.routes.js';
import paymentRoutes from './modules/payments.routes.js';
import operationsRoutes from './modules/operations.routes.js';
import { errorHandler, notFound } from './shared/http.js';

export const app = express();
const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Origin is not allowed by CORS.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature'],
}));
app.use((req, res, next) => {
  const parser = req.originalUrl.startsWith('/api/v1/payments/stripe/webhook')
    ? express.raw({ type: 'application/json', limit: '1mb' })
    : express.json({ limit: '1mb' });
  parser(req, res, next);
});
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
app.get('/', (_req, res) => res.json({ service: 'AeroNexa API', version: '2.0.0', docs: '/api/v1/health' }));
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1', userRoutes);
app.use('/api/v1', organizationRoutes);
app.use('/api/v1', flightRoutes);
app.use('/api/v1', bookingRoutes);
app.use('/api/v1', paymentRoutes);
app.use('/api/v1', operationsRoutes);
app.use(notFound);
app.use(errorHandler);
