// Configuración central con validación fail-fast.
// Si falta un secreto obligatorio el proceso NO arranca: es preferible caerse
// al arrancar que servir tráfico con un secreto por defecto conocido.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const resultadoDotenv = dotenv.config({ path: path.resolve(dirname, '..', '.env') });

// En un PaaS (Render, Railway, Vercel) no existe archivo .env: la
// configuración llega por variables de entorno del servicio. El mensaje de
// error tiene que apuntar al sitio correcto o manda a buscar un archivo que
// no está.
const hayArchivoEnv = !resultadoDotenv.error;
const DONDE_CONFIGURAR = hayArchivoEnv
  ? 'server/.env'
  : 'las variables de entorno del servicio';

// Valores de plantilla que nunca deben llegar a producción.
const SECRETOS_PROHIBIDOS = new Set([
  'dev-secret',
  'secret',
  'changeme',
  'cambia-este-secreto-en-produccion',
]);

const listaSeparadaPorComas = z
  .string()
  .transform((valor) =>
    valor
      .split(',')
      .map((parte) => parte.trim())
      .filter(Boolean)
  );

const esquema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4310),

    // Origen público del frontend: enlaces de correo y redirección OAuth.
    // El esquema es obligatorio: "midominio.com" a secas no es una URL válida
    // y es el error más fácil de cometer al copiarla del dashboard.
    APP_URL: z
      .string()
      .url('Debe ser una URL completa CON esquema, por ejemplo https://goldforall-client.vercel.app (no sirve goldforall-client.vercel.app a secas)')
      .default('http://localhost:5310'),
    // Origen público de esta API: se usa para construir el redirect_uri de Google.
    API_URL: z
      .string()
      .url('Debe ser una URL completa CON esquema. Con el rewrite de Vercel es el MISMO valor que APP_URL')
      .default('http://localhost:4310'),

    JWT_SECRET: z
      .string()
      .min(32, 'JWT_SECRET debe tener al menos 32 caracteres (usa: pnpm secret)')
      .refine(
        (valor) => !SECRETOS_PROHIBIDOS.has(valor.toLowerCase()),
        'JWT_SECRET es un valor de plantilla. Genera uno real con: pnpm secret'
      ),

    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(30),
    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

    // Orígenes permitidos por CORS. Si no se declara, se deriva de APP_URL:
    // en el 99% de los despliegues son el mismo valor, y tener que repetirlo
    // solo añade una variable más que se puede olvidar o escribir mal.
    CORS_ORIGINS: listaSeparadaPorComas.optional(),
    COOKIE_DOMAIN: z.string().optional(),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((valor) => (valor === undefined ? undefined : valor === 'true')),
    // Detrás de Nginx / Railway / Render hace falta para que req.ip sea el real.
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

    // Cuentas que se promueven a admin en la migración.
    ADMIN_EMAILS: listaSeparadaPorComas.default(''),

    // Registro público. Cerrado por defecto: las cuentas las crea un admin
    // desde el panel. Afecta por igual a POST /api/auth/register y al alta
    // automática por Google, que si no sería la puerta de atrás obvia.
    ALLOW_PUBLIC_REGISTRATION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((valor) => valor === 'true'),

    // Autosuscripción a Premium (POST /api/subscribe, pago SIMULADO).
    // Cerrada por defecto: mientras no exista pasarela real, dejarla abierta
    // significa que cualquier usuario se activa Premium gratis y la gestión
    // de Premium por el administrador deja de tener sentido.
    ALLOW_SELF_SUBSCRIBE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((valor) => valor === 'true'),

    // Solo los lee el script "pnpm seed:admin"; nunca el servidor.
    SEED_ADMIN_EMAIL: z.string().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
    SEED_ADMIN_NAME: z.string().optional(),

    // Los proveedores gestionados (Neon, Render, Railway, Supabase) entregan
    // la conexión como una sola URL. Si está presente manda sobre las
    // variables sueltas de abajo, que son las del Postgres local.
    DATABASE_URL: z.string().startsWith('postgres').optional(),

    PGHOST: z.string().default('localhost'),
    PGPORT: z.coerce.number().int().positive().default(5432),
    PGUSER: z.string().default('postgres'),
    PGPASSWORD: z.string().default(''),
    PGDATABASE: z.string().default('goldforall'),
    // false     = sin TLS (Postgres local)
    // true      = TLS verificando el certificado (lo correcto en producción)
    // no-verify = TLS sin verificar la CA; solo para proveedores con
    //             certificado autofirmado. Deja pasar un man-in-the-middle.
    PGSSL: z.enum(['true', 'false', 'no-verify']).optional(),

    GOLD_API_URL: z.string().url().default('https://api.gold-api.com/price/XAU'),
    RATES_API_URL: z.string().url().default('https://open.er-api.com/v6/latest/USD'),
    GOLD_CACHE_SECONDS: z.coerce.number().int().positive().default(10),
    RATES_CACHE_SECONDS: z.coerce.number().int().positive().default(600),
    HISTORY_SAMPLE_SECONDS: z.coerce.number().int().positive().default(300),

    // Zona horaria que define cuándo "se reinicia el día" para la cuota gratis.
    QUOTA_TIMEZONE: z.string().default('America/Bogota'),

    // Google OAuth: opcional. Si falta, el login social queda desactivado
    // y el cliente oculta el botón (ver GET /api/auth/providers).
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),

    // SMTP: opcional. Sin SMTP los enlaces de recuperación se imprimen en consola.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().default('GoldForAll <no-reply@goldforall.local>'),
  })
  .superRefine((valores, ctx) => {
    if (valores.NODE_ENV !== 'production') return;

    // APP_URL y API_URL tienen default local para desarrollo. En producción
    // hay que declararlos: si se quedan en localhost, los enlaces de correo
    // apuntan a la máquina del usuario y el redirect_uri de Google no valida.
    if (!process.env.APP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_URL'],
        message:
          'Obligatorio en producción: dominio público del frontend, por ejemplo ' +
          'https://goldforall.vercel.app (de aquí sale CORS_ORIGINS si no lo declaras)',
      });
    }
    if (!process.env.API_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_URL'],
        message:
          'Obligatorio en producción: dominio público de la API. Con el rewrite ' +
          'de Vercel es el MISMO dominio que APP_URL',
      });
    }
    if (valores.CORS_ORIGINS?.some((origen) => origen === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS no puede ser "*" en producción',
      });
    }
    if (!valores.DATABASE_URL && !valores.PGPASSWORD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PGPASSWORD'],
        message: 'En producción hace falta DATABASE_URL o PGPASSWORD',
      });
    }
    // PGSSL solo gobierna la conexión local; con DATABASE_URL el cifrado sale
    // del sslmode de la propia URL.
    if (!valores.DATABASE_URL && valores.PGSSL === 'false') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PGSSL'],
        message: 'PGSSL=false en producción manda las credenciales de la base sin cifrar',
      });
    }
    if (valores.DATABASE_URL?.includes('sslmode=disable')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'sslmode=disable en producción manda las credenciales de la base sin cifrar',
      });
    }
    if (valores.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE=false en producción expone las cookies de sesión en texto plano',
      });
    }
  });

const resultado = esquema.safeParse(process.env);

if (!resultado.success) {
  const detalles = resultado.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
    .join('\n');
  console.error(
    `\nConfiguración inválida — el servidor no puede arrancar.\n` +
      `Corrige esto en ${DONDE_CONFIGURAR}:\n${detalles}\n`
  );

  // Inventario de lo obligatorio en producción, sin imprimir ningún valor.
  // Sirve para distinguir de un vistazo "no la puse" de "la puse mal", que
  // es donde se pierde más tiempo depurando un despliegue.
  if (process.env.NODE_ENV === 'production') {
    const requeridas = ['JWT_SECRET', 'APP_URL', 'API_URL', 'DATABASE_URL'];
    console.error('Estado de las variables obligatorias en producción:');
    for (const nombre of requeridas) {
      const definida = Boolean(process.env[nombre]);
      console.error(`  ${definida ? '[definida]' : '[AUSENTE ]'}  ${nombre}`);
    }
    console.error('');
  }

  console.error(
    'Referencia de todas las variables: server/.env.example\n' +
      'Para generar un JWT_SECRET válido: pnpm secret\n'
  );
  process.exit(1);
}

const env = resultado.data;

const esProduccion = env.NODE_ENV === 'production';

/**
 * Conexión a Postgres. Dos rutas separadas a propósito:
 *
 *   DATABASE_URL presente  -> proveedor gestionado (Neon, Render, Railway…).
 *   DATABASE_URL ausente   -> Postgres local vía variables PG*.
 *
 * La URL se descompone en campos explícitos en lugar de pasarla como
 * connectionString: si se le entrega la cadena tal cual, node-postgres rellena
 * lo que la URL no diga (puerto, sobre todo) desde las variables PG* del
 * entorno. Con un Postgres local en un puerto no estándar eso hace que la
 * conexión a la nube salga apuntando al puerto local y muera por timeout.
 */
function resolverBaseDeDatos(valores) {
  if (!valores.DATABASE_URL) {
    const modoSsl = valores.PGSSL ?? 'false';
    return {
      esGestionada: false,
      database: valores.PGDATABASE,
      ssl: sslDesdeModo(modoSsl),
      conexion: {
        host: valores.PGHOST,
        port: valores.PGPORT,
        user: valores.PGUSER,
        password: valores.PGPASSWORD,
        database: valores.PGDATABASE,
        ssl: sslDesdeModo(modoSsl),
      },
    };
  }

  let url;
  try {
    url = new URL(valores.DATABASE_URL);
  } catch {
    console.error('\nDATABASE_URL no es una URL válida de PostgreSQL.\n');
    process.exit(1);
  }

  // El modo TLS sale del sslmode de la URL. PGSSL es un ajuste del Postgres
  // local y no debe apagar el cifrado de una base remota por accidente; solo
  // se respeta si pide explícitamente saltarse la verificación.
  const sslmode = url.searchParams.get('sslmode');
  let modoSsl = 'true';
  if (sslmode === 'disable') modoSsl = 'false';
  if (sslmode === 'no-verify' || valores.PGSSL === 'no-verify') modoSsl = 'no-verify';

  const ssl = sslDesdeModo(modoSsl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';

  return {
    esGestionada: true,
    database,
    ssl,
    conexion: {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      ssl,
    },
  };
}

function sslDesdeModo(modo) {
  if (modo === 'true') return { rejectUnauthorized: true };
  // Sin verificación de CA: se cifra, pero se pierde la garantía de con quién
  // se está hablando. Solo para proveedores con certificado autofirmado.
  if (modo === 'no-verify') return { rejectUnauthorized: false };
  return false;
}

export const config = {
  env: env.NODE_ENV,
  esProduccion,
  port: env.PORT,
  appUrl: env.APP_URL.replace(/\/$/, ''),
  apiUrl: env.API_URL.replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY,
  // Sin CORS_ORIGINS declarado (o declarado vacío), el único origen permitido
  // es el propio frontend.
  corsOrigins: (env.CORS_ORIGINS?.length ? env.CORS_ORIGINS : [env.APP_URL]).map((origen) =>
    origen.replace(/\/$/, '')
  ),
  adminEmails: env.ADMIN_EMAILS.map((correo) => correo.toLowerCase()),
  registroPublicoAbierto: env.ALLOW_PUBLIC_REGISTRATION,
  autoSuscripcionAbierta: env.ALLOW_SELF_SUBSCRIBE,

  semillaAdmin: {
    email: env.SEED_ADMIN_EMAIL?.trim().toLowerCase(),
    password: env.SEED_ADMIN_PASSWORD,
    nombre: env.SEED_ADMIN_NAME?.trim(),
  },

  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTokenTtl: env.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    passwordResetTtlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    bcryptRounds: env.BCRYPT_ROUNDS,
    issuer: 'goldforall',
    audience: 'goldforall-web',
  },

  cookies: {
    secure: env.COOKIE_SECURE ?? esProduccion,
    domain: env.COOKIE_DOMAIN,
    // Lax (no Strict) para que la redirección de vuelta desde Google
    // llegue con la cookie recién puesta. Lax ya bloquea POST cross-site.
    sameSite: 'lax',
  },

  db: resolverBaseDeDatos(env),

  precios: {
    goldApiUrl: env.GOLD_API_URL,
    ratesApiUrl: env.RATES_API_URL,
    goldCacheMs: env.GOLD_CACHE_SECONDS * 1000,
    ratesCacheMs: env.RATES_CACHE_SECONDS * 1000,
    historySampleMs: env.HISTORY_SAMPLE_SECONDS * 1000,
  },

  cuota: {
    zonaHoraria: env.QUOTA_TIMEZONE,
  },

  google: {
    habilitado: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI || `${env.API_URL.replace(/\/$/, '')}/api/auth/google/callback`,
  },

  smtp: {
    habilitado: Boolean(env.SMTP_HOST),
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.SMTP_FROM,
  },
};
