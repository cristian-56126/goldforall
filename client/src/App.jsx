import { useEffect, useState, useCallback } from 'react';
import { api, eventos, haySesionProbable } from './api.js';
import AuthView from './views/AuthView.jsx';
import Dashboard from './views/Dashboard.jsx';
import ResetPasswordView from './views/ResetPasswordView.jsx';

const MOTIVOS_OAUTH = {
  cancelado: 'Cancelaste el inicio de sesión con Google.',
  estado_invalido: 'La solicitud de Google expiró o no es válida. Inténtalo otra vez.',
  peticion_incompleta: 'Faltaron datos en la respuesta de Google. Inténtalo otra vez.',
  canje_fallido: 'No se pudo validar la sesión con Google.',
  correo_no_verificado: 'Google no confirma que tu correo esté verificado.',
  correo_en_uso: 'Ese correo ya tiene una cuenta creada con contraseña.',
  cuenta_desactivada: 'Tu cuenta está desactivada. Contacta al administrador.',
  google_deshabilitado: 'El inicio de sesión con Google no está configurado.',
  perfil_incompleto: 'Google no entregó los datos mínimos del perfil.',
  sin_id_token: 'Google no entregó el token de identidad.',
};

export default function App() {
  const [session, setSession] = useState(null); // { user, plan }
  const [loading, setLoading] = useState(true);
  const [aviso, setAviso] = useState(null); // { tipo, texto }

  // Enrutado mínimo: la app tiene una sola pantalla más, la de restablecer
  // contraseña, a la que se llega desde el enlace del correo.
  const [ruta] = useState(() => window.location.pathname);
  const [tokenReset] = useState(
    () => new URLSearchParams(window.location.search).get('token') || ''
  );

  const refrescarSesion = useCallback(async () => {
    if (!haySesionProbable()) {
      setSession(null);
      setLoading(false);
      return;
    }
    try {
      setSession(await api.me());
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Resultado del regreso desde Google, que llega como ?auth=ok|error
  useEffect(() => {
    const parametros = new URLSearchParams(window.location.search);
    const auth = parametros.get('auth');
    if (!auth) return;

    if (auth === 'ok') {
      setAviso({ tipo: 'ok', texto: 'Sesión iniciada con Google.' });
    } else {
      const motivo = parametros.get('motivo');
      setAviso({
        tipo: 'error',
        texto: MOTIVOS_OAUTH[motivo] || 'No se pudo iniciar sesión con Google.',
      });
    }
    // Limpia la URL para que un F5 no repita el aviso.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    refrescarSesion();
  }, [refrescarSesion]);

  // El cliente HTTP avisa cuando ni siquiera el refresh token sirve ya.
  useEffect(() => {
    const alTerminar = () => setSession(null);
    eventos.addEventListener('sesion-terminada', alTerminar);
    return () => eventos.removeEventListener('sesion-terminada', alTerminar);
  }, []);

  const cerrarSesion = async () => {
    try {
      await api.logout();
    } catch {
      // Aunque falle la llamada, en el cliente la sesión se da por cerrada.
    }
    setSession(null);
  };

  if (ruta === '/restablecer') {
    return <ResetPasswordView token={tokenReset} />;
  }

  if (loading) {
    return (
      <div className="splash">
        <div className="logo-big">Gold<span>ForAll</span></div>
        <p>Cargando…</p>
      </div>
    );
  }

  return session ? (
    <Dashboard
      session={session}
      onRefresh={refrescarSesion}
      onLogout={cerrarSesion}
      aviso={aviso}
      onCerrarAviso={() => setAviso(null)}
    />
  ) : (
    <AuthView onAuthed={refrescarSesion} aviso={aviso} onCerrarAviso={() => setAviso(null)} />
  );
}
