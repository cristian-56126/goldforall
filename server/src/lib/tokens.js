// Emisión, verificación y rotación de tokens de sesión.
//
// Modelo:
//   - Access token: JWT firmado, corto (15 min por defecto). Sin estado en la
//     base: verificarlo no cuesta una consulta.
//   - Refresh token: opaco y largo (30 días). Se guarda SOLO su SHA-256.
//     Rota en cada uso: usarlo lo invalida y emite uno nuevo.
//
// Detección de robo: todos los tokens que descienden de un mismo login
// comparten family_id. Si alguien presenta un token ya rotado significa que
// hubo dos copias en circulación, así que se revoca la familia completa y las
// dos partes quedan fuera. Es la contramedida estándar de refresh rotativo.
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, enTransaccion } from '../db.js';
import { errorNoAutenticado } from './errors.js';
import { comparacionSegura, hashToken, partirTokenCompuesto, tokenAleatorio, uuid } from './seguridad.js';

const { jwtSecret, accessTokenTtl, refreshTokenTtlDays, issuer, audience } = config.auth;

export function firmarAccessToken(usuario) {
  return jwt.sign(
    {
      sub: String(usuario.id),
      email: usuario.email,
      role: usuario.role,
      typ: 'access',
    },
    jwtSecret,
    { expiresIn: accessTokenTtl, issuer, audience, algorithm: 'HS256' }
  );
}

export function verificarAccessToken(token) {
  // algorithms explícito: sin esto, un token con alg "none" o con un algoritmo
  // asimétrico podría intentar colarse por confusión de algoritmo.
  const payload = jwt.verify(token, jwtSecret, {
    issuer,
    audience,
    algorithms: ['HS256'],
  });
  if (payload.typ !== 'access') throw new Error('Tipo de token incorrecto');
  return payload;
}

function huellaDePeticion(req) {
  return {
    userAgent: (req?.get?.('user-agent') || '').slice(0, 255) || null,
    ip: (req?.ip || '').slice(0, 45) || null,
  };
}

/**
 * Crea un refresh token nuevo y devuelve el valor en claro "<id>.<secreto>".
 * Ese valor solo existe en esta función y en la cookie del cliente.
 */
export async function emitirRefreshToken({ userId, familyId, req, cliente }) {
  const ejecutar = cliente ? cliente.query.bind(cliente) : query;
  const id = uuid();
  const secreto = tokenAleatorio(32);
  const { userAgent, ip } = huellaDePeticion(req);
  const expiraEn = new Date(Date.now() + refreshTokenTtlDays * 86_400_000);

  await ejecutar(
    `INSERT INTO refresh_tokens (id, family_id, user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, familyId || id, userId, hashToken(secreto), expiraEn, userAgent, ip]
  );

  return `${id}.${secreto}`;
}

export async function revocarFamilia(familyId, motivo, cliente) {
  const ejecutar = cliente ? cliente.query.bind(cliente) : query;
  await ejecutar(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, motivo]
  );
}

export async function revocarTodasLasSesiones(userId, motivo) {
  await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, motivo]
  );
  // Corta también los access tokens ya emitidos (ver requireUsuarioActivo).
  // Truncado al segundo para casar con la precisión del "iat" del JWT.
  await query(
    `UPDATE users SET tokens_valid_from = date_trunc('second', now()), updated_at = now()
      WHERE id = $1`,
    [userId]
  );
}

export async function revocarUnToken(bruto, motivo) {
  const partes = partirTokenCompuesto(bruto);
  if (!partes) return;
  await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [partes.id, motivo]
  );
}

/**
 * Valida un refresh token y lo rota.
 * Devuelve { usuario, refreshToken } o lanza 401.
 * Todo ocurre en una transacción para que dos peticiones simultáneas no
 * consuman la misma fila dos veces.
 */
export async function rotarRefreshToken(bruto, req) {
  const partes = partirTokenCompuesto(bruto);
  if (!partes) throw errorNoAutenticado('Sesión inválida', { codigo: 'refresh_malformado' });

  // La revocación de familia NO puede ejecutarse dentro de la transacción que
  // luego lanza el error: el ROLLBACK la desharía y el token robado seguiría
  // vivo. Se anota aquí el motivo y se aplica en su propia transacción una vez
  // que la primera ya abortó.
  let familiaPorRevocar = null;

  try {
    return await enTransaccion(async (cliente) => {
      // FOR UPDATE serializa dos /refresh concurrentes con el mismo token:
      // el segundo verá revoked_at ya puesto y disparará la detección de reuso.
      const fila = await cliente.query(
        `SELECT id, family_id, user_id, token_hash, issued_at, expires_at, revoked_at
           FROM refresh_tokens
          WHERE id = $1
            FOR UPDATE`,
        [partes.id]
      );
      const token = fila.rows[0];
      if (!token) {
        throw errorNoAutenticado('Sesión inválida', { codigo: 'refresh_desconocido' });
      }

      if (!comparacionSegura(hashToken(partes.secreto), token.token_hash)) {
        // El id existe pero el secreto no coincide: es un intento de adivinar.
        familiaPorRevocar = { id: token.family_id, motivo: 'secreto_incorrecto' };
        throw errorNoAutenticado('Sesión inválida', { codigo: 'refresh_invalido' });
      }

      if (token.revoked_at) {
        // Reuso de un token ya rotado: hay una copia robada en circulación.
        // Se cierra la familia entera y las dos partes quedan fuera.
        familiaPorRevocar = { id: token.family_id, motivo: 'reuso_detectado' };
        throw errorNoAutenticado('Sesión cerrada por seguridad. Vuelve a iniciar sesión.', {
          codigo: 'refresh_reusado',
        });
      }

      if (new Date(token.expires_at) <= new Date()) {
        throw errorNoAutenticado('Sesión expirada', { codigo: 'refresh_expirado' });
      }

      const usuarioResultado = await cliente.query(
        `SELECT id, email, name, role, avatar_url, disabled_at, tokens_valid_from
           FROM users WHERE id = $1`,
        [token.user_id]
      );
      const usuario = usuarioResultado.rows[0];
      if (!usuario) throw errorNoAutenticado('Sesión inválida', { codigo: 'usuario_inexistente' });
      if (usuario.disabled_at) {
        familiaPorRevocar = { id: token.family_id, motivo: 'cuenta_desactivada' };
        throw errorNoAutenticado('Cuenta desactivada', { codigo: 'cuenta_desactivada' });
      }
      // Un cambio de contraseña mueve tokens_valid_from: todo token emitido
      // antes de esa marca queda inválido aunque su fila siga viva.
      if (new Date(token.issued_at) < new Date(usuario.tokens_valid_from)) {
        familiaPorRevocar = { id: token.family_id, motivo: 'credenciales_cambiadas' };
        throw errorNoAutenticado('Tus credenciales cambiaron. Vuelve a iniciar sesión.', {
          codigo: 'credenciales_cambiadas',
        });
      }

      const nuevoRefresh = await emitirRefreshToken({
        userId: usuario.id,
        familyId: token.family_id,
        req,
        cliente,
      });
      const nuevoId = nuevoRefresh.slice(0, nuevoRefresh.indexOf('.'));

      await cliente.query(
        `UPDATE refresh_tokens
            SET revoked_at = now(), revoked_reason = 'rotado', replaced_by = $2
          WHERE id = $1`,
        [token.id, nuevoId]
      );

      return { usuario, refreshToken: nuevoRefresh };
    });
  } finally {
    if (familiaPorRevocar) {
      // Se ejecuta ya con la transacción anterior revertida, así que persiste.
      await revocarFamilia(familiaPorRevocar.id, familiaPorRevocar.motivo).catch((err) =>
        console.error('[tokens] no se pudo revocar la familia:', err.message)
      );
    }
  }
}

/** Poda tokens caducados o revocados hace más de 30 días. */
export async function limpiarTokensViejos() {
  const resultado = await query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < now() - interval '7 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`
  );
  await query(`DELETE FROM password_resets WHERE expires_at < now() - interval '7 days'`);
  await query(`DELETE FROM login_attempts WHERE created_at < now() - interval '7 days'`);
  return resultado.rowCount;
}
