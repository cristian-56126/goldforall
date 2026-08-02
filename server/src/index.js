import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { cerrarPool } from './db.js';
import { AppError } from './lib/errors.js';
import { limpiarTokensViejos } from './lib/tokens.js';
import { verificarCsrf } from './middleware/csrf.js';
import {
  cabecerasSeguras,
  corsRestringido,
  limitadorGlobal,
} from './middleware/security.js';
import { adminRouter } from './routes/admin.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { oauthRouter } from './routes/oauth.js';
import { arrancarMuestreador, priceHistoryRouter } from './routes/priceHistory.js';

const app = express();

// Detrás de un proxy (Nginx, Railway, Render) req.ip es la IP del proxy si no
// se declara cuántos saltos son de confianza; sin esto el rate limit por IP
// agruparía a todos los usuarios en una sola clave.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.disable('etag');

app.use(cabecerasSeguras);
app.use(corsRestringido);

// Límite de cuerpo: sin él, una petición de varios cientos de MB se acepta
// y se acumula en memoria.
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(cookieParser());

// Identificador por petición: aparece en el log del error y en la respuesta,
// así un usuario puede reportar un 500 y se encuentra la traza exacta.
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
});

app.use(limitadorGlobal);
app.use(verificarCsrf);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, env: config.env, google: config.google.habilitado });
});

app.use('/api/auth', authRouter);
app.use('/api/auth', oauthRouter);
app.use('/api/admin', adminRouter);
app.use('/api', apiRouter);
app.use('/api', priceHistoryRouter);

// 404 explícito: sin esto una ruta inexistente cae en el manejador de errores
// con un mensaje poco claro.
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ---------------------------------------------------------------------------
// Manejador de errores global
//
// Regla: al cliente solo se le devuelve el mensaje de los errores marcados
// como públicos (AppError). Cualquier otro se registra completo en el servidor
// y se responde con un 500 genérico, para no filtrar rutas de archivos,
// consultas SQL ni nombres de tablas.
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: err.message,
      codigo: err.codigo,
      ...(err.detalles ? { detalles: err.detalles } : {}),
    });
  }

  // Cuerpo JSON malformado (lo lanza body-parser).
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La petición es demasiado grande' });
  }
  if (err.message?.startsWith('Origen no permitido por CORS')) {
    return res.status(403).json({ error: 'Origen no permitido' });
  }

  console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({
    error: 'Error interno del servidor',
    request_id: req.id,
  });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

const servidor = app.listen(config.port, () => {
  console.log(`GoldForAll API escuchando en http://localhost:${config.port}  [${config.env}]`);
  console.log(`  CORS permitido para: ${config.corsOrigins.join(', ')}`);
  console.log(`  Login con Google:    ${config.google.habilitado ? 'activo' : 'desactivado'}`);
  console.log(`  Correo saliente:     ${config.smtp.habilitado ? 'SMTP' : 'consola'}`);
  if (!config.cookies.secure) {
    console.log('  Cookies sin flag Secure (correcto en desarrollo sobre HTTP).');
  }

  arrancarMuestreador();

  // Poda de tokens caducados. unref() para no impedir que el proceso termine.
  limpiarTokensViejos().catch((err) => console.error('[limpieza]', err.message));
  const limpieza = setInterval(() => {
    limpiarTokensViejos().catch((err) => console.error('[limpieza]', err.message));
  }, 6 * 60 * 60 * 1000);
  limpieza.unref?.();
});

// Un error no capturado deja el proceso en estado desconocido: se registra y
// se sale para que el supervisor (pm2, systemd, contenedor) lo reinicie limpio.
process.on('unhandledRejection', (motivo) => {
  console.error('[fatal] promesa rechazada sin manejar:', motivo);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] excepción no capturada:', err);
  process.exit(1);
});

async function apagar(senal) {
  console.log(`\n${senal} recibido: cerrando…`);
  servidor.close(async () => {
    await cerrarPool().catch(() => {});
    process.exit(0);
  });
  // Si alguna conexión se queda colgada, no esperar indefinidamente.
  setTimeout(() => process.exit(1), 10_000).unref?.();
}

process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
