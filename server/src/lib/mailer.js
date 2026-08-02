// Envío de correo conmutable.
//   Con SMTP_HOST configurado  -> se envía de verdad por SMTP.
//   Sin SMTP_HOST              -> se imprime en la consola del servidor.
// El modo consola existe para que la recuperación de contraseña sea probable
// en local sin montar un proveedor de correo.
import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporte = null;

function obtenerTransporte() {
  if (!config.smtp.habilitado) return null;
  if (transporte) return transporte;
  transporte = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  });
  return transporte;
}

export async function enviarCorreo({ para, asunto, texto, html }) {
  const transporteSmtp = obtenerTransporte();

  if (!transporteSmtp) {
    console.log(
      '\n─── CORREO (modo consola: SMTP_HOST no configurado) ───────────────\n' +
        `Para:    ${para}\n` +
        `Asunto:  ${asunto}\n\n` +
        `${texto}\n` +
        '───────────────────────────────────────────────────────────────────\n'
    );
    return { entregado: false, modo: 'consola' };
  }

  await transporteSmtp.sendMail({ from: config.smtp.from, to: para, subject: asunto, text: texto, html });
  return { entregado: true, modo: 'smtp' };
}

export function correoDeRecuperacion({ nombre, enlace, minutos }) {
  const texto =
    `Hola ${nombre},\n\n` +
    'Recibimos una solicitud para restablecer la contraseña de tu cuenta de GoldForAll.\n\n' +
    `Abre este enlace para elegir una nueva contraseña:\n${enlace}\n\n` +
    `El enlace vence en ${minutos} minutos y solo se puede usar una vez.\n\n` +
    'Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue siendo válida.\n\n' +
    'GoldForAll';

  const html =
    `<p>Hola ${nombre},</p>` +
    '<p>Recibimos una solicitud para restablecer la contraseña de tu cuenta de GoldForAll.</p>' +
    `<p><a href="${enlace}">Elegir una nueva contraseña</a></p>` +
    `<p>El enlace vence en ${minutos} minutos y solo se puede usar una vez.</p>` +
    '<p>Si no fuiste tú, ignora este mensaje: tu contraseña actual sigue siendo válida.</p>' +
    '<p>GoldForAll</p>';

  return { asunto: 'Restablece tu contraseña de GoldForAll', texto, html };
}
