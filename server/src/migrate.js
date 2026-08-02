// Crea la base de datos (si no existe), aplica las migraciones pendientes y
// siembra los datos base.  Uso: pnpm migrate
//
// Las migraciones se registran en la tabla schema_migrations: cada una corre
// una sola vez y dentro de su propia transacción. Aun así el DDL se escribe
// idempotente (IF NOT EXISTS) para que sea seguro re-aplicarlo a mano.
import pg from 'pg';
import { config } from './config.js';

const { Client } = pg;

const DB_NAME = config.db.database;

// Con proveedor gestionado (Neon, Render, Railway) la base ya viene creada
// dentro de DATABASE_URL y no hay permiso para CREATE DATABASE: ese paso se
// salta. Solo el Postgres local necesita crearla.
if (!config.db.esGestionada) {
  // El nombre va interpolado en CREATE DATABASE (no admite parámetros), así
  // que se valida como identificador antes de tocar el servidor.
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(DB_NAME)) {
    console.error(`PGDATABASE inválido: "${DB_NAME}". Solo letras, números y guion bajo.`);
    process.exit(1);
  }
}

const migraciones = [
  {
    nombre: '001_esquema_inicial',
    sql: `
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        daily_query_limit INTEGER,          -- NULL = ilimitado
        monthly_price_usd NUMERIC(10,2)     -- NULL = gratis
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS weight_units (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name_es TEXT NOT NULL,
        grams NUMERIC(12,4) NOT NULL,
        is_traditional BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS conversion_queries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        unit_code TEXT NOT NULL,
        quantity NUMERIC(14,4) NOT NULL,
        grams_total NUMERIC(16,4) NOT NULL,
        gold_price_usd_oz NUMERIC(12,4) NOT NULL,
        value_usd NUMERIC(16,4) NOT NULL,
        value_cop NUMERIC(18,2) NOT NULL,
        value_gbp NUMERIC(16,4) NOT NULL,
        value_eur NUMERIC(16,4) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_queries_user_date
        ON conversion_queries (user_id, created_at);

      -- Porcentaje de negociación nacional sobre el valor internacional
      -- (100 = valor internacional pleno)
      ALTER TABLE conversion_queries
        ADD COLUMN IF NOT EXISTS percentage NUMERIC(5,2) NOT NULL DEFAULT 100;

      -- Históricos de precio: ventana de últimas 6 horas (se poda al insertar)
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        gold_usd_oz NUMERIC(12,4) NOT NULL,
        usd_cop NUMERIC(12,4) NOT NULL,
        usd_gbp NUMERIC(10,6) NOT NULL,
        usd_eur NUMERIC(10,6) NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_price_history_recorded
        ON price_history (recorded_at);
    `,
  },

  {
    nombre: '002_usuarios_roles_e_identidades',
    sql: `
      -- Rol para el control de acceso. Solo 'user' y 'admin' por ahora.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check
        CHECK (role IN ('user', 'admin'));

      -- Identidad de Google. NULL para cuentas creadas con email + contraseña.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
      -- Todo refresh token emitido antes de esta marca queda inválido
      -- (se mueve al cambiar contraseña o al desactivar la cuenta).
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_from TIMESTAMPTZ NOT NULL DEFAULT now();

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
        ON users (google_id) WHERE google_id IS NOT NULL;

      -- Una cuenta creada solo con Google no tiene contraseña.
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

      -- ...pero tiene que tener al menos una forma de entrar.
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tiene_credencial_check;
      ALTER TABLE users ADD CONSTRAINT users_tiene_credencial_check
        CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL);
    `,
  },

  {
    nombre: '003_refresh_tokens',
    sql: `
      -- Un refresh token nunca se guarda en claro: solo su SHA-256.
      -- family_id agrupa la cadena de rotaciones de una misma sesión; si se
      -- reutiliza un token ya rotado se revoca la familia completa (robo).
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY,
        family_id UUID NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        replaced_by UUID,
        user_agent TEXT,
        ip TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);
    `,
  },

  {
    nombre: '004_recuperacion_de_contrasena',
    sql: `
      -- Igual que los refresh tokens: se guarda el hash, nunca el token.
      CREATE TABLE IF NOT EXISTS password_resets (
        id UUID PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        requested_ip TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
      CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets (expires_at);
    `,
  },

  {
    nombre: '005_intentos_de_login',
    sql: `
      -- Bloqueo por cuenta: complementa al rate limit por IP, que no sirve
      -- contra un atacante distribuido apuntando a un solo correo.
      CREATE TABLE IF NOT EXISTS login_attempts (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        ip TEXT,
        succeeded BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_login_attempts_email_fecha
        ON login_attempts (email, created_at DESC);
    `,
  },

  {
    nombre: '006_suscripciones_pago',
    sql: `
      -- Preparado para la pasarela real (Stripe / Wompi / PayU). Hoy todos
      -- los pagos entran con is_simulated = true.
      ALTER TABLE user_subscriptions
        ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'simulado';
      ALTER TABLE user_subscriptions
        ADD COLUMN IF NOT EXISTS payment_reference TEXT;
      ALTER TABLE user_subscriptions
        ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(10,2);
      ALTER TABLE user_subscriptions
        ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE user_subscriptions
        ADD COLUMN IF NOT EXISTS granted_by INTEGER REFERENCES users(id);

      ALTER TABLE user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;
      ALTER TABLE user_subscriptions ADD CONSTRAINT user_subscriptions_status_check
        CHECK (status IN ('active', 'cancelled', 'expired'));

      -- La referencia de pago de una pasarela real no se puede repetir:
      -- evita acreditar dos veces el mismo webhook.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_referencia_pago
        ON user_subscriptions (payment_provider, payment_reference)
        WHERE payment_reference IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_subs_usuario_vigencia
        ON user_subscriptions (user_id, status, expires_at DESC);
    `,
  },

  {
    nombre: '007_limpieza_indice_cuota',
    sql: `
      -- El conteo de cuota diaria pasó de "created_at::date = CURRENT_DATE"
      -- (no sargable: fuerza recorrer todo el historial del usuario) a un
      -- rango [inicio_del_dia, +1 día), que sí usa idx_queries_user_date.
      -- Un índice sobre created_at::date no es posible: la conversión
      -- timestamptz -> date es STABLE, no IMMUTABLE.
      CREATE INDEX IF NOT EXISTS idx_queries_user_date
        ON conversion_queries (user_id, created_at);
    `,
  },

  {
    nombre: '008_tokens_valid_from_al_segundo',
    sql: `
      -- El "iat" de un JWT viene en segundos enteros (truncado hacia abajo),
      -- mientras que now() trae microsegundos. Con el DEFAULT en now(), un
      -- usuario creado en el segundo 10,750 recibía un token con iat = 10,000,
      -- y la comprobación "iat < tokens_valid_from" lo invalidaba al instante:
      -- toda cuenta recién registrada respondía 401.
      -- Truncar al segundo alinea ambas escalas y elimina la carrera.
      ALTER TABLE users
        ALTER COLUMN tokens_valid_from SET DEFAULT date_trunc('second', now());

      UPDATE users
         SET tokens_valid_from = date_trunc('second', tokens_valid_from)
       WHERE tokens_valid_from <> date_trunc('second', tokens_valid_from);
    `,
  },
];

async function asegurarBaseDeDatos() {
  const cliente = new Client({ ...config.db.conexion, database: 'postgres' });
  await cliente.connect();
  try {
    const existe = await cliente.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (existe.rowCount === 0) {
      await cliente.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`Base de datos "${DB_NAME}" creada.`);
    } else {
      console.log(`Base de datos "${DB_NAME}" ya existe.`);
    }
  } finally {
    await cliente.end();
  }
}

async function aplicarMigraciones(cliente) {
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nombre TEXT PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const aplicadas = await cliente.query('SELECT nombre FROM schema_migrations');
  const yaAplicadas = new Set(aplicadas.rows.map((fila) => fila.nombre));

  let pendientes = 0;
  for (const migracion of migraciones) {
    if (yaAplicadas.has(migracion.nombre)) continue;
    pendientes += 1;
    await cliente.query('BEGIN');
    try {
      await cliente.query(migracion.sql);
      await cliente.query('INSERT INTO schema_migrations (nombre) VALUES ($1)', [migracion.nombre]);
      await cliente.query('COMMIT');
      console.log(`  aplicada: ${migracion.nombre}`);
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw new Error(`Falló la migración ${migracion.nombre}: ${err.message}`);
    }
  }
  if (pendientes === 0) console.log('  sin migraciones pendientes');
}

async function sembrarDatos(cliente) {
  // Planes: perfil 1 gratis (3 consultas/día), perfil 2 premium (ilimitado).
  // monthly_price_usd del premium: placeholder 0 hasta que el cliente defina precio.
  await cliente.query(`
    INSERT INTO plans (code, name, daily_query_limit, monthly_price_usd) VALUES
      ('free',    'Perfil 1 - Gratis',   3,    NULL),
      ('premium', 'Perfil 2 - Premium',  NULL, 0)
    ON CONFLICT (code) DO UPDATE
      SET daily_query_limit = EXCLUDED.daily_query_limit;
  `);

  // Unidades de peso confirmadas por el cliente (NO cambiar sin autorización):
  //   Castellano 4.6 g | Tomín 0.575 g | Real 0.287 g | Grano 0.05 g
  //   Gramo 1 g | Onza troy 31.1035 g | Kilogramo 1000 g
  await cliente.query(`
    INSERT INTO weight_units (code, name_es, grams, is_traditional, sort_order) VALUES
      ('castellano', 'Castellano', 4.6,     true,  1),
      ('tomin',      'Tomín',      0.575,   true,  2),
      ('real',       'Real',       0.287,   true,  3),
      ('grano',      'Grano',      0.05,    true,  4),
      ('gramo',      'Gramo',      1,       false, 5),
      ('onza_troy',  'Onza troy',  31.1035, false, 6),
      ('kilogramo',  'Kilogramo',  1000,    false, 7)
    ON CONFLICT (code) DO UPDATE
      SET grams = EXCLUDED.grams, name_es = EXCLUDED.name_es;
  `);

  // Promoción a admin de los correos declarados en ADMIN_EMAILS.
  // Solo afecta cuentas que ya existen; no crea usuarios.
  if (config.adminEmails.length > 0) {
    const resultado = await cliente.query(
      `UPDATE users SET role = 'admin', updated_at = now()
        WHERE email = ANY($1::text[]) AND role <> 'admin'
        RETURNING email`,
      [config.adminEmails]
    );
    if (resultado.rowCount > 0) {
      console.log(`  admin asignado a: ${resultado.rows.map((f) => f.email).join(', ')}`);
    }
    const faltantes = config.adminEmails.filter(
      (correo) => !resultado.rows.some((f) => f.email === correo)
    );
    if (faltantes.length > 0) {
      console.log(
        `  nota: ${faltantes.join(', ')} aún no tiene cuenta. ` +
          'Regístrate y vuelve a correr "pnpm migrate" para recibir el rol admin.'
      );
    }
  }
}

async function principal() {
  if (config.db.esGestionada) {
    console.log('Base gestionada (DATABASE_URL): se omite la creación de la base.');
  } else {
    await asegurarBaseDeDatos();
  }

  const cliente = new Client(config.db.conexion);
  await cliente.connect();
  try {
    console.log('Migraciones:');
    await aplicarMigraciones(cliente);
    console.log('Datos semilla:');
    await sembrarDatos(cliente);
    console.log('  planes y unidades de peso listos');
  } finally {
    await cliente.end();
  }
}

try {
  await principal();
  console.log('\nMigración completada.');
} catch (err) {
  console.error('\nError en migración:', err.message);
  process.exit(1);
}
