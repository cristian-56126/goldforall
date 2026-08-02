import { fmtMoney, fmtNum } from '../format.js';

const TROY_OZ_GRAMS = 31.1035;

function BotonRefrescar({ onRefresh, refreshing }) {
  if (!onRefresh) return null;
  return (
    <button
      type="button"
      className={refreshing ? 'btn-refresh girando' : 'btn-refresh'}
      onClick={onRefresh}
      disabled={refreshing}
      title="Actualizar precios ahora"
      aria-label="Actualizar precios ahora"
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <polyline points="21 3 21 9 15 9" />
      </svg>
    </button>
  );
}

export default function PriceTicker({ prices, error, onRefresh, refreshing }) {
  if (error) {
    return (
      <div className="card ticker error-card">
        <div className="ticker-error-fila">
          <span>{error}</span>
          <BotonRefrescar onRefresh={onRefresh} refreshing={refreshing} />
        </div>
      </div>
    );
  }
  if (!prices) return <div className="card ticker">Cargando precio del oro…</div>;

  const perGram = prices.gold_usd_oz / TROY_OZ_GRAMS;
  const desactualizado = Boolean(prices.stale || prices.gold_stale || prices.rates_stale);

  return (
    <div className="card ticker">
      <BotonRefrescar onRefresh={onRefresh} refreshing={refreshing} />
      <div className="ticker-main">
        <div>
          <p className="ticker-label">
            <span className={desactualizado ? 'live-dot stale' : 'live-dot'} aria-hidden="true" />
            Oro internacional · onza troy
          </p>
          <p className="ticker-price">{fmtMoney(prices.gold_usd_oz, 'USD')}</p>
        </div>
        <div className="ticker-gram">
          <p className="ticker-label">Por gramo</p>
          <p className="ticker-price-sm">{fmtMoney(perGram, 'USD')}</p>
        </div>
        <div className="ticker-dollar">
          <p className="ticker-label">Dólar hoy</p>
          <p className="ticker-price-sm dollar">
            {fmtNum(prices.rates.COP, 2)} <small>COP</small>
          </p>
        </div>
      </div>
      <div className="ticker-rates">
        <span>USD/COP <b>{fmtNum(prices.rates.COP, 2)}</b></span>
        <span>USD/GBP <b>{fmtNum(prices.rates.GBP, 4)}</b></span>
        <span>USD/EUR <b>{fmtNum(prices.rates.EUR, 4)}</b></span>
      </div>
      {desactualizado && (
        <p className="ticker-stale">
          Sin conexión con el proveedor de precios: se muestra el último valor conocido.
          Usa el botón de actualizar para reintentar.
        </p>
      )}
      <p className="ticker-time">
        Oro actualizado:{' '}
        {new Date(prices.gold_updated_at || prices.fetched_at).toLocaleTimeString('es-CO')}
        {' '}· Consultado:{' '}
        {new Date(prices.fetched_at).toLocaleTimeString('es-CO')}
        {prices.rates_updated_at && (
          <>
            {' '}· Tasas:{' '}
            {new Date(prices.rates_updated_at).toLocaleDateString('es-CO', {
              day: '2-digit',
              month: 'short',
            })}{' '}
            (diaria)
          </>
        )}
      </p>
    </div>
  );
}
