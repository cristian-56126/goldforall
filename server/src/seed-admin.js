// Crea (o actualiza) la cuenta de administrador inicial.
//
//   pnpm seed:admin
//
// Las credenciales se leen del entorno, nunca del código:
//   SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME
//
// Existe porque con el registro público cerrado hace falta una primera cuenta
// desde la que crear las demás. Es idempotente: repetirlo no duplica nada.
import { config } from './config.js';
import { query, cerrarPool } from './db.js';
import {
  contrasenaEsDerivadaDelUsuario,
  esquemaContrasena,
  hashearContrasena,
} from './lib/contrasenas.js';

const { email, password, nombre } = config.semillaAdmin;

if (!email || !password) {
  console.error(
    '\nFaltan credenciales para sembrar el administrador.\n' +
      'Define SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD en el entorno, por ejemplo:\n\n' +
      '  SEED_ADMIN_EMAIL=admin@ejemplo.com SEED_ADMIN_PASSWORD="..." pnpm seed:admin\n\n' +
      'No se ponen en el código ni se commitean.\n'
  );
  process.exit(1);
}

const nombreFinal = nombre || email.split('@')[0];

// La cuenta sembrada pasa por la misma política que cualquier otra: una
// contraseña débil en la cuenta con más privilegios sería el peor sitio para
// hacer una excepción.
const validacion = esquemaContrasena.safeParse(password);
if (!validacion.success) {
  console.error(
    `\nSEED_ADMIN_PASSWORD no cumple la política:\n` +
      validacion.error.issues.map((i) => `  - ${i.message}`).join('\n') +
      '\n'
  );
  process.exit(1);
}
if (contrasenaEsDerivadaDelUsuario(password, { email, name: nombreFinal })) {
  console.error('\nSEED_ADMIN_PASSWORD no puede contener el nombre ni el correo de la cuenta.\n');
  process.exit(1);
}

try {
  const hash = await hashearContrasena(password);

  const resultado = await query(
    `INSERT INTO users (email, password_hash, name, role, email_verified)
     VALUES ($1, $2, $3, 'admin', true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           name = EXCLUDED.name,
           role = 'admin',
           disabled_at = NULL,
           tokens_valid_from = date_trunc('second', now()),
           updated_at = now()
     RETURNING id, email, name, role, created_at,
               (xmax = 0) AS fue_creado`,
    [email, hash, nombreFinal]
  );

  const usuario = resultado.rows[0];

  // Si la cuenta ya existía se le cambió la contraseña, así que las sesiones
  // anteriores tienen que morir.
  if (!usuario.fue_creado) {
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = 'contrasena_sembrada'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [usuario.id]
    );
  }

  console.log(
    `\n${usuario.fue_creado ? 'Administrador creado' : 'Administrador actualizado'}:\n` +
      `  id:     ${usuario.id}\n` +
      `  correo: ${usuario.email}\n` +
      `  nombre: ${usuario.name}\n` +
      `  rol:    ${usuario.role}\n\n` +
      'La contraseña no se imprime a propósito. Cámbiala tras el primer ingreso\n' +
      'desde Cuenta → Cambiar contraseña.\n'
  );
} catch (err) {
  console.error('\nError sembrando el administrador:', err.message, '\n');
  process.exitCode = 1;
} finally {
  await cerrarPool();
}
