# Despliegue a producción

Arquitectura elegida: **SPA en Vercel + API en Render + Postgres en Neon**, con
un *rewrite* de Vercel que reenvía `/api/*` a la API.

```
navegador
   │
   ▼
https://goldforall.vercel.app          (Vercel — SPA estática)
   ├── /              → client/dist
   └── /api/*         → rewrite → https://goldforall-api.onrender.com/api/*
                                         │  (Render — Express, proceso vivo)
                                         ▼
                                   Neon Postgres
```

**Por qué el rewrite.** Para el navegador todo vive en un solo origen. Eso
mantiene las cookies de sesión en `SameSite=Lax` (nada de `SameSite=None`, que
Safari y la retirada de las cookies de terceros están estrangulando) y elimina
CORS del camino crítico. Es la misma forma en que ya funciona el proxy de Vite
en desarrollo, así que no hay diferencia de comportamiento entre local y
producción.

**Por qué la API no va en Vercel.** El servidor asume un proceso vivo y único:
el muestreador de precios y la poda de tokens son `setInterval`, la caché de
oro y tasas vive en memoria, y el rate limit de `express-rate-limit` usa un
almacén en memoria. En serverless cada instancia tendría su propio contador y
el freno a la fuerza bruta dejaría de valer — una regresión de seguridad real,
no un detalle de rendimiento.

---

## Estado actual

- [x] Proyecto Neon creado: **goldforall** (`super-sky-04909011`, región
      `us-east-2`, Postgres 17)
- [x] Migraciones 001–008 aplicadas y datos semilla cargados en Neon
- [x] Repositorio git inicializado con el primer commit
- [x] `vercel.json` y `render.yaml` listos
- [x] Credenciales de producción en `server/.env.production` (ignorado por git)
- [ ] Subir el repo a GitHub
- [ ] Desplegar Render
- [ ] Desplegar Vercel
- [ ] Enlazar ambos y verificar

---

## Paso 1 — Subir el repo a GitHub

Crea un repositorio **privado** vacío en GitHub y luego:

```bash
git remote add origin https://github.com/TU-USUARIO/goldforall.git
git push -u origin main
```

`server/.env` y `server/.env.production` están en `.gitignore`; ya se verificó
que ningún secreto entra al commit.

---

## Paso 2 — Base de datos (ya hecho)

El proyecto Neon existe y está migrado. La cadena de conexión está en
`server/.env.production`, en la línea `DATABASE_URL`.

**Migraciones futuras.** El plan gratuito de Render no da consola, así que se
corren desde tu máquina apuntando a Neon:

```bash
cd server
DATABASE_URL='<la de .env.production>' node src/migrate.js
```

Son idempotentes y quedan registradas en `schema_migrations`: volver a
ejecutarlas no repite nada.

---

## Paso 3 — API en Render

1. Render → **New** → **Blueprint** → selecciona el repo. Detecta `render.yaml`.
2. Render pedirá los valores marcados `sync: false`. Cópialos de
   `server/.env.production`:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la cadena de Neon |
   | `JWT_SECRET` | el generado en `.env.production` (distinto al de desarrollo) |
   | `ADMIN_EMAILS` | tu correo |
   | `APP_URL` / `API_URL` / `CORS_ORIGINS` | déjalos en blanco por ahora — se llenan en el paso 5 |
   | `GOOGLE_*`, `SMTP_*` | vacíos si aún no los configuras |

3. Deploy. Anota la URL que te asigna, por ejemplo
   `https://goldforall-api.onrender.com`.

El servicio **no arrancará** si `JWT_SECRET` falta o mide menos de 32
caracteres: es deliberado. Si el log muestra `Configuración inválida`, la causa
está en ese mensaje.

### Advertencia del plan gratuito de Render

El plan free **suspende el servicio tras 15 minutos sin tráfico** y tarda entre
30 y 60 s en despertar. Dos consecuencias:

- La primera visita después de un rato puede agotar el tiempo del rewrite de
  Vercel y fallar.
- Mientras duerme no corre el muestreador de precios, así que la gráfica de
  12 horas tendrá huecos.

Opciones:

- **Railway** (~5 USD/mes): no duerme. Mismo repo; en el dashboard pon build
  `pnpm install --frozen-lockfile` y start `pnpm --filter goldforall-server start`,
  y las mismas variables de entorno.
- **Render + ping externo**: un servicio gratuito tipo cron-job.org o
  UptimeRobot llamando a `https://TU-API.onrender.com/api/health` cada 10 min.
  Consume casi las 750 horas mensuales del plan free, que alcanzan justo para
  un servicio.
- Aceptar el arranque en frío mientras es un piloto.

---

## Paso 4 — SPA en Vercel

1. Edita `vercel.json` y pon la URL real de Render en el primer rewrite:

   ```json
   { "source": "/api/:path*", "destination": "https://TU-API.onrender.com/api/:path*" }
   ```

   ```bash
   git commit -am "chore: apuntar el rewrite de Vercel a la API de Render"
   git push
   ```

2. Vercel → **Add New Project** → importa el repo.
   `vercel.json` ya trae install, build y directorio de salida; no toques nada.
3. Deploy. Anota la URL, por ejemplo `https://goldforall.vercel.app`.

---

## Paso 5 — Enlazar los dos

En Render, rellena ahora las tres URLs con el dominio de **Vercel** (no el de
Render: con el rewrite, el navegador ve la API en el dominio de Vercel, y de
ahí sale también el `redirect_uri` de Google):

```
APP_URL=https://goldforall.vercel.app
API_URL=https://goldforall.vercel.app
CORS_ORIGINS=https://goldforall.vercel.app
```

Guarda y deja que Render redespliegue.

---

## Paso 6 — Verificación

```bash
API=https://goldforall.vercel.app/api

# 1. La API responde a través del rewrite
curl -s $API/health

# 2. Métodos de acceso disponibles
curl -s $API/auth/providers

# 3. Registro y cookies de sesión
curl -si -X POST $API/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Admin","email":"TU@CORREO.com","password":"UnaClaveLarga2026"}' \
  | grep -i 'set-cookie'
```

En el `set-cookie` de `gfa_at` y `gfa_rt` deben aparecer **`HttpOnly`**,
**`Secure`** y **`SameSite=Lax`**. Si falta `Secure`, `COOKIE_SECURE` no llegó
como `true`.

Después, con sesión de admin, abre **`/api/admin/diagnostico`** y comprueba que
`red.ip_detectada` es tu IP pública real.

> Si en lugar de tu IP aparece una de Vercel o de Render, `TRUST_PROXY` está
> mal calibrado y **todos los usuarios comparten un mismo cubo de rate limit**:
> el freno a la fuerza bruta deja de proteger y usuarios legítimos empiezan a
> recibir 429. Sube o baja `TRUST_PROXY` (prueba 1, 2 y 3) hasta que la IP
> cuadre. El valor por defecto para esta topología es `2`.

Comprueba también `red.protocolo_detectado: "https"`; si dice `http`,
`TRUST_PROXY` está en 0.

### Crear el administrador

Regístrate con el correo que pusiste en `ADMIN_EMAILS` y entrarás ya con rol
`admin`. Si la cuenta ya existía, vuelve a correr las migraciones contra Neon.

---

## Google OAuth en producción

En https://console.cloud.google.com/apis/credentials, en el cliente OAuth,
añade como URI de redirección autorizado el dominio de **Vercel**:

```
https://goldforall.vercel.app/api/auth/google/callback
```

Luego pon `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Render. El frontend
muestra el botón solo cuando el servidor reporta que está configurado.

---

## Correo saliente

Sin `SMTP_HOST`, el enlace de recuperación de contraseña **solo se imprime en
el log de Render**, que no le sirve a un usuario real. Antes de tener usuarios
de verdad hay que configurar un SMTP (Resend, Brevo, Mailgun, SendGrid) y
completar `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM`.

---

## Antes de cobrar dinero de verdad

- **Licencia de Vercel.** El plan Hobby es gratuito solo para uso personal o
  sin fines comerciales. Si GoldForAll va a facturar, sus términos piden el
  plan Pro (20 USD/mes por usuario). Vale la pena revisarlo antes de lanzar.
- **El pago sigue simulado.** `POST /api/subscribe` activa Premium 30 días sin
  cobrar nada. Hay que sustituirlo por la confirmación de la pasarela
  validando la firma del webhook. El esquema ya trae `payment_provider`,
  `payment_reference` y `amount_usd`, con índice único sobre
  (proveedor, referencia) para no acreditar dos veces el mismo pago.
- **Verificación de correo en el registro.** Hoy `email_verified` solo lo marca
  Google.
- **Copias de seguridad.** El plan gratuito de Neon retiene 6 horas de
  historial. Para datos de clientes reales hace falta un plan con más
  retención o un volcado periódico.

---

## Redesplegar

Ambas plataformas despliegan solas en cada `push` a `main`.

- Cambio solo de frontend → Vercel redespliega.
- Cambio de backend → Render redespliega.
- Cambio de esquema → corre las migraciones contra Neon **antes** de que el
  código nuevo empiece a recibir tráfico.
