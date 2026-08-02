# GoldForAll

Aplicación web de compra y venta de oro con precio internacional en tiempo real.

## Stack

- **Monorepo:** pnpm workspaces (`client` + `server`)
- **Frontend:** React 18 + Vite (responsive, móvil primero) — puerto **5310**
- **Backend:** Node.js 18+ / Express — puerto **4310**
- **Base de datos:** PostgreSQL
- **API oro:** gold-api.com (USD por onza troy, gratis, sin API key)
- **API dólar:** open.er-api.com (tasas USD → COP / GBP / EUR, gratis, sin API key)

## Unidades de peso (confirmadas por el cliente)

| Unidad | Gramos | Tipo |
|---|---|---|
| Castellano | 4,6 | Tradicional |
| Tomín | 0,575 | Tradicional |
| Real | 0,287 | Tradicional |
| Grano | 0,05 | Tradicional |
| Gramo | 1 | Estándar |
| Onza troy | 31,1035 | Estándar |
| Kilogramo | 1000 | Estándar |

## Perfiles

- **Perfil 1 — Gratis:** máximo 3 consultas por día. Cada consulta convierte una
  cantidad de oro a COP, USD, GBP y EUR a la vez. El día se reinicia a
  medianoche de `QUOTA_TIMEZONE` (por defecto `America/Bogota`).
- **Perfil 2 — Premium:** suscripción mensual, consultas ilimitadas.
  El pago está **simulado** (pasarela real pendiente: Stripe / Wompi / PayU).
  Precio mensual pendiente de definir por el cliente.
- **Rol admin:** panel de administración de usuarios, roles y suscripciones.

## Puesta en marcha local

Requisitos: Node 18.18+, pnpm 10+, PostgreSQL corriendo en localhost.

```bash
# 1. Dependencias de todo el monorepo, desde la raíz
pnpm install

# 2. Configuración del servidor
cd server
cp .env.example .env
pnpm secret            # genera un JWT_SECRET válido -> pégalo en .env
                       # completa también PGPASSWORD
cd ..

# 3. Base de datos: crea la DB, aplica migraciones y siembra datos
pnpm migrate

# 4. Arrancar backend + frontend a la vez
pnpm dev
```

- Frontend: http://localhost:5310
- API: http://localhost:4310

Scripts de la raíz: `pnpm dev`, `pnpm dev:server`, `pnpm dev:client`,
`pnpm build`, `pnpm migrate`, `pnpm secret`, `pnpm start`.

El servidor **no arranca** si falta `JWT_SECRET` o es un valor de plantilla:
es deliberado, evita servir tráfico firmando tokens con un secreto conocido.

### Crear el primer administrador

1. Pon tu correo en `ADMIN_EMAILS` (en `server/.env`, separados por coma).
2. Regístrate normalmente en la app con ese correo — entra ya con rol `admin`.
   Si la cuenta ya existía, corre `pnpm migrate` y se promueve.

## Autenticación

La sesión vive en **cookies httpOnly**; no hay token en `localStorage`, así que
un XSS no puede robarla.

| Cookie | Contenido | Vida | Notas |
|---|---|---|---|
| `gfa_at` | Access token (JWT HS256) | 15 min | httpOnly, no se puede leer desde JS |
| `gfa_rt` | Refresh token opaco | 30 días | httpOnly, path acotado a `/api/auth` |
| `gfa_csrf` | Token anti-CSRF firmado | 30 días | legible por JS a propósito (double-submit) |

- **Rotación de refresh:** cada uso invalida el token y emite otro. Todos los
  tokens de un mismo login comparten `family_id`.
- **Detección de robo:** presentar un refresh ya rotado revoca la familia
  completa — el atacante y el usuario legítimo quedan fuera y hay que volver a
  entrar. Es la contramedida estándar del refresh rotativo.
- **Renovación transparente:** el cliente reintenta una vez tras un 401 por
  token caducado, con un único `/refresh` en vuelo aunque caduquen varias
  peticiones a la vez.
- **Cambio de credenciales:** mueve `users.tokens_valid_from`, lo que invalida
  de golpe los refresh tokens *y* los access tokens ya emitidos.

Métodos de acceso: correo + contraseña, Google OAuth (opcional) y recuperación
de contraseña por enlace de un solo uso.

### Google OAuth (opcional)

Sin `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` el login social queda apagado y
el frontend oculta el botón solo (consulta `GET /api/auth/providers`).

Para activarlo, en https://console.cloud.google.com/apis/credentials crea un
**ID de cliente de OAuth → Aplicación web** con este URI de redirección:

```
http://localhost:4310/api/auth/google/callback
```

y copia el ID y el secreto a `server/.env`.

El flujo es *authorization code* con PKCE y `state` firmado. Una cuenta local
existente solo se vincula a Google si Google confirma que el correo está
verificado; si no, cualquiera que registrara ese correo se apoderaría de la
cuenta.

### Recuperación de contraseña

Sin `SMTP_HOST` configurado, el enlace se **imprime en la consola del
servidor** — suficiente para desarrollo. Con SMTP configurado se envía por
correo. El token dura 30 minutos, sirve una sola vez y al usarlo cierra todas
las sesiones abiertas.

## Seguridad

| Área | Medida |
|---|---|
| Secretos | `JWT_SECRET` obligatorio (≥32 caracteres), sin valor por defecto; el proceso aborta si falta |
| CORS | Lista blanca explícita con credenciales; `*` prohibido en producción |
| CSRF | Double-submit con token firmado (HMAC) + `SameSite=Lax` |
| Cabeceras | helmet: CSP, `nosniff`, `frame-ancestors`, HSTS en producción |
| Fuerza bruta | Rate limit por IP + bloqueo por cuenta (10 fallos / 15 min), que sí frena ataques distribuidos |
| Enumeración | Login y recuperación responden igual exista o no la cuenta, con el mismo coste de CPU |
| Contraseñas | bcrypt coste 12, mínimo 8 caracteres, bloqueo de las más usadas y de las derivadas del correo o el nombre |
| Entrada | Todo cuerpo y query validados con zod en modo estricto |
| Cuota | Conteo e inserción bajo advisory lock por usuario: N peticiones en paralelo no se saltan el límite |
| Suscripción | Idempotente; índice único sobre (proveedor, referencia) para no acreditar dos veces un pago |
| Errores | Solo se devuelve el mensaje de errores públicos; el resto es un 500 genérico con `request_id` |
| DoS | Cuerpo JSON limitado a 32 kB; timeout de 8 s en las APIs externas |
| Sesiones | El usuario ve sus sesiones activas y puede cerrarlas una a una o todas |

## Endpoints

### Sesión

| Método | Ruta | Descripción |
|---|---|---|
| GET | /api/auth/providers | Qué métodos de acceso están activos |
| POST | /api/auth/register | Crear cuenta |
| POST | /api/auth/login | Iniciar sesión |
| POST | /api/auth/refresh | Renovar la sesión (rota el refresh token) |
| POST | /api/auth/logout | Cerrar esta sesión |
| POST | /api/auth/logout-all | Cerrar todas las sesiones |
| GET | /api/auth/sessions | Sesiones activas del usuario |
| DELETE | /api/auth/sessions/:id | Revocar una sesión |
| POST | /api/auth/forgot-password | Pedir enlace de recuperación |
| POST | /api/auth/reset-password | Fijar contraseña nueva con el token |
| POST | /api/auth/change-password | Cambiarla con la sesión iniciada |
| GET | /api/auth/google | Iniciar el flujo de Google |
| GET | /api/auth/google/callback | Retorno de Google |

### Aplicación

| Método | Ruta | Descripción |
|---|---|---|
| GET | /api/health | Estado del servicio |
| GET | /api/me | Perfil + plan + cuota del día |
| GET | /api/units | Unidades de peso (público) |
| GET | /api/prices | Oro spot + tasas USD |
| POST | /api/convert | Conversión — consume 1 consulta de la cuota |
| GET | /api/history | Últimas conversiones (`?limit=`) |
| GET | /api/price-history | Serie de precios de las últimas 12 h |
| POST | /api/subscribe | Activa Premium 30 días (pago simulado) |

### Administración (rol `admin`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | /api/admin/stats | Métricas generales |
| GET | /api/admin/users | Listado con búsqueda y paginación |
| PATCH | /api/admin/users/:id/role | Cambiar rol |
| POST | /api/admin/users/:id/disable | Desactivar cuenta |
| POST | /api/admin/users/:id/enable | Reactivar cuenta |
| POST | /api/admin/users/:id/revoke-sessions | Cerrar sus sesiones |
| POST | /api/admin/users/:id/subscription | Otorgar/extender Premium |

Toda petición que modifique datos usando cookies debe llevar la cabecera
`X-CSRF-Token` con el valor de la cookie `gfa_csrf`. Los clientes que no son
navegador pueden usar `Authorization: Bearer <access token>` y saltarse el CSRF.

## Migraciones

Están versionadas en `server/src/migrate.js` y registradas en la tabla
`schema_migrations`: cada una corre una sola vez, dentro de su transacción.
Para añadir un cambio de esquema, agrega una entrada nueva al array — nunca
edites una ya aplicada.

## Pendientes antes de producción

- [ ] Sustituir el pago simulado por la pasarela real (Stripe / Wompi / PayU),
      validando la firma del webhook. El esquema ya tiene
      `payment_provider` / `payment_reference` / `amount_usd`.
- [ ] Definir el precio mensual del plan Premium.
- [ ] Servir todo por HTTPS y poner `COOKIE_SECURE=true`.
- [ ] Declarar `CORS_ORIGINS` con el dominio real y `TRUST_PROXY=1` si hay
      proxy delante.
- [ ] Configurar SMTP para que la recuperación de contraseña salga por correo.
- [ ] Verificación de correo en el registro (hoy `email_verified` solo lo marca
      Google).
