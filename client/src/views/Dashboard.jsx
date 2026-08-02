import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import PriceTicker from '../components/PriceTicker.jsx';
import GoldHistory from '../components/GoldHistory.jsx';
import Converter from '../components/Converter.jsx';
import PlanBadge from '../components/PlanBadge.jsx';
import History from '../components/History.jsx';
import AccountPanel from '../components/AccountPanel.jsx';
import AdminPanel from '../components/AdminPanel.jsx';

export default function Dashboard({ session, onRefresh, onLogout, aviso, onCerrarAviso }) {
  const [units, setUnits] = useState([]);
  const [prices, setPrices] = useState(null);
  const [pricesError, setPricesError] = useState('');
  const [historyKey, setHistoryKey] = useState(0);
  const [vista, setVista] = useState('inicio'); // 'inicio' | 'cuenta' | 'admin'
  const [errorAccion, setErrorAccion] = useState('');
  // Con la autosuscripción cerrada (pago simulado, Premium lo activa el
  // admin), los botones "Mejorar a Premium" se ocultan.
  const [autoSuscripcion, setAutoSuscripcion] = useState(false);

  const esAdmin = session.user.role === 'admin';

  const [refrescando, setRefrescando] = useState(false);
  const sondeoRef = useRef(null);

  const loadPrices = useCallback(async (forzar = false) => {
    try {
      setPrices(await api.prices(forzar ? { refresh: true } : undefined));
      setPricesError('');
    } catch (err) {
      setPricesError(err.message);
    }
  }, []);

  // El sondeo se rearma tras un refresco manual: así el tick automático no
  // cae un segundo después del clic.
  const armarSondeo = useCallback(() => {
    clearInterval(sondeoRef.current);
    sondeoRef.current = setInterval(() => loadPrices(), 15_000); // cada 15 s
  }, [loadPrices]);

  const refrescarPrecios = useCallback(async () => {
    setRefrescando(true);
    try {
      await loadPrices(true);
      armarSondeo();
    } finally {
      setRefrescando(false);
    }
  }, [loadPrices, armarSondeo]);

  useEffect(() => {
    api.units().then((d) => setUnits(d.units)).catch(() => {});
    api.providers().then((p) => setAutoSuscripcion(Boolean(p.self_subscribe))).catch(() => {});
    loadPrices();
    armarSondeo();
    return () => clearInterval(sondeoRef.current);
  }, [loadPrices, armarSondeo]);

  const onConverted = () => {
    onRefresh();
    setHistoryKey((k) => k + 1);
  };

  const subscribe = async () => {
    setErrorAccion('');
    try {
      await api.subscribe();
      onRefresh();
    } catch (err) {
      setErrorAccion(err.message);
    }
  };

  return (
    <div className="dash">
      <header className="topbar">
        <div className="logo">Gold<span>ForAll</span></div>

        <nav className="nav-vistas">
          <button
            className={vista === 'inicio' ? 'tab active' : 'tab'}
            onClick={() => setVista('inicio')}
          >
            Inicio
          </button>
          <button
            className={vista === 'cuenta' ? 'tab active' : 'tab'}
            onClick={() => setVista('cuenta')}
          >
            Cuenta
          </button>
          {esAdmin && (
            <button
              className={vista === 'admin' ? 'tab active' : 'tab'}
              onClick={() => setVista('admin')}
            >
              Admin
            </button>
          )}
        </nav>

        <div className="topbar-right">
          {session.user.avatar_url && (
            <img className="avatar" src={session.user.avatar_url} alt="" referrerPolicy="no-referrer" />
          )}
          <span className="user-name">{session.user.name}</span>
          {esAdmin && <span className="etiqueta dorada">admin</span>}
          <button className="btn-ghost" onClick={onLogout}>Salir</button>
        </div>
      </header>

      {aviso && (
        <div className={aviso.tipo === 'ok' ? 'aviso aviso-ok' : 'aviso aviso-error'}>
          <span>{aviso.texto}</span>
          <button type="button" className="aviso-cerrar" onClick={onCerrarAviso}>×</button>
        </div>
      )}
      {errorAccion && <div className="aviso aviso-error"><span>{errorAccion}</span></div>}

      {vista === 'inicio' && (
        <main className="dash-grid">
          <section className="col-main">
            <PriceTicker
              prices={prices}
              error={pricesError}
              onRefresh={refrescarPrecios}
              refreshing={refrescando}
            />
            <Converter
              units={units}
              plan={session.plan}
              onConverted={onConverted}
              onSubscribe={autoSuscripcion ? subscribe : null}
            />
            <GoldHistory />
          </section>

          <aside className="col-side">
            <PlanBadge plan={session.plan} onSubscribe={autoSuscripcion ? subscribe : null} />
            <History refreshKey={historyKey} />
          </aside>
        </main>
      )}

      {vista === 'cuenta' && (
        <main className="dash-simple">
          <AccountPanel user={session.user} onLogout={onLogout} />
        </main>
      )}

      {vista === 'admin' && esAdmin && (
        <main className="dash-simple">
          <AdminPanel />
        </main>
      )}
    </div>
  );
}
