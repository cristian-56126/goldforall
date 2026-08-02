// Login con Google (OAuth 2.0, flujo authorization code + PKCE).
//
// Se usa el flujo de servidor y no el de "credencial en el navegador" porque
// el token de sesión tiene que salir como cookie httpOnly desde el backend.
//
// Defensas del flujo:
//   - state firmado (JWT de 10 min) + cookie con el mismo nonce: bloquea el
//     CSRF de login, donde un atacante te hace iniciar sesión en SU cuenta.
//   - PKCE (S256): si alguien intercepta el código de autorización, no puede
//     canjearlo sin el verifier, que nunca sale de la cookie.
//   - El vínculo con una cuenta existente por correo solo se hace si Google
//     afirma que ese correo está verificado; si no, cualquiera que registre
//     ese correo en Google se apoderaría de la cuenta.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.js';
import { query } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { errorNoImplementado } from '../lib/errors.js';
import { comparacionSegura, tokenAleatorio } from '../lib/seguridad.js';
import { establecerSesion } from './auth.js';

export const oauthRouter = Router();

const COOKIE_OAUTH = 'gfa_oauth';
const VIDA_DEL_ESTADO = '10m';

function crearCliente() {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
}

function opcionesCookieTemporal() {
  return {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    domain: config.cookies.domain,
    path: '/api/auth/google',
    maxAge: 10 * 60 * 1000,
  };
}

function exigirGoogleHabilitado(_req, _res, next) {
  if (!config.google.habilitado) {
    return next(
      errorNoImplementado(
        'El inicio de sesión con Google no está configurado en este servidor.',
        { codigo: 'google_deshabilitado' }
      )
    );
  }
  return next();
}

function redirigirConError(res, motivo) {
  res.redirect(`${config.appUrl}/?auth=error&motivo=${encodeURIComponent(motivo)}`);
}

// ---------------------------------------------------------------------------
// Paso 1: llevar al usuario a Google
// ---------------------------------------------------------------------------

oauthRouter.get(
  '/google',
  exigirGoogleHabilitado,
  asyncHandler(async (req, res) => {
    const cliente = crearCliente();
    const { codeVerifier, codeChallenge } = await cliente.generateCodeVerifierAsync();
    const nonce = tokenAleatorio(16);

    const state = jwt.sign({ nonce }, config.auth.jwtSecret, {
      expiresIn: VIDA_DEL_ESTADO,
      issuer: config.auth.issuer,
      audience: 'google-oauth',
      algorithm: 'HS256',
    });

    // El verifier y el nonce viajan en una cookie httpOnly de vida corta:
    // el navegador los devuelve en el callback y nadie más los ve.
    res.cookie(COOKIE_OAUTH, `${nonce}.${codeVerifier}`, opcionesCookieTemporal());

    const url = cliente.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      prompt: 'select_account',
    });

    res.redirect(url);
  })
);

// ---------------------------------------------------------------------------
// Paso 2: Google devuelve al usuario aquí
// ---------------------------------------------------------------------------

oauthRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    if (!config.google.habilitado) return redirigirConError(res, 'google_deshabilitado');

    const cookieOauth = req.cookies?.[COOKIE_OAUTH];
    res.clearCookie(COOKIE_OAUTH, { ...opcionesCookieTemporal(), maxAge: undefined });

    if (req.query.error) return redirigirConError(res, 'cancelado');

    const codigo = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    if (!codigo || !state || !cookieOauth) return redirigirConError(res, 'peticion_incompleta');

    const separador = cookieOauth.indexOf('.');
    if (separador <= 0) return redirigirConError(res, 'estado_invalido');
    const nonceDeCookie = cookieOauth.slice(0, separador);
    const codeVerifier = cookieOauth.slice(separador + 1);

    let payloadEstado;
    try {
      payloadEstado = jwt.verify(state, config.auth.jwtSecret, {
        issuer: config.auth.issuer,
        audience: 'google-oauth',
        algorithms: ['HS256'],
      });
    } catch {
      return redirigirConError(res, 'estado_invalido');
    }
    if (!comparacionSegura(payloadEstado.nonce || '', nonceDeCookie)) {
      return redirigirConError(res, 'estado_invalido');
    }

    const cliente = crearCliente();
    let perfil;
    try {
      const { tokens } = await cliente.getToken({ code: codigo, codeVerifier });
      if (!tokens.id_token) return redirigirConError(res, 'sin_id_token');
      const ticket = await cliente.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.google.clientId,
      });
      perfil = ticket.getPayload();
    } catch (err) {
      console.error('[oauth] fallo el canje del código de Google:', err.message);
      return redirigirConError(res, 'canje_fallido');
    }

    if (!perfil?.sub || !perfil.email) return redirigirConError(res, 'perfil_incompleto');
    if (!perfil.email_verified) return redirigirConError(res, 'correo_no_verificado');

    const email = perfil.email.toLowerCase().trim();
    const nombre = (perfil.name || email.split('@')[0]).slice(0, 120);
    const avatar = perfil.picture || null;

    let usuario;

    // 1) ¿Ya existe esta identidad de Google?
    const porGoogle = await query(
      `SELECT id, email, name, role, avatar_url, email_verified, created_at, disabled_at
         FROM users WHERE google_id = $1`,
      [perfil.sub]
    );
    usuario = porGoogle.rows[0];

    if (!usuario) {
      // 2) ¿Existe una cuenta local con ese correo? Se vincula.
      //    Seguro únicamente porque Google ya confirmó el correo (comprobado arriba).
      const porEmail = await query(
        `UPDATE users
            SET google_id = $2,
                avatar_url = COALESCE(avatar_url, $3),
                email_verified = true,
                updated_at = now()
          WHERE email = $1 AND google_id IS NULL
        RETURNING id, email, name, role, avatar_url, email_verified, created_at, disabled_at`,
        [email, perfil.sub, avatar]
      );
      usuario = porEmail.rows[0];
    }

    if (!usuario) {
      // 3) Cuenta nueva, sin contraseña (entra solo por Google).
      const rol = config.adminEmails.includes(email) ? 'admin' : 'user';
      try {
        const creado = await query(
          `INSERT INTO users (email, name, google_id, avatar_url, email_verified, role)
           VALUES ($1, $2, $3, $4, true, $5)
           RETURNING id, email, name, role, avatar_url, email_verified, created_at, disabled_at`,
          [email, nombre, perfil.sub, avatar, rol]
        );
        usuario = creado.rows[0];
      } catch (err) {
        if (err.code === '23505') return redirigirConError(res, 'correo_en_uso');
        throw err;
      }
    }

    if (usuario.disabled_at) return redirigirConError(res, 'cuenta_desactivada');

    await establecerSesion(res, usuario, req);
    res.redirect(`${config.appUrl}/?auth=ok`);
  })
);
