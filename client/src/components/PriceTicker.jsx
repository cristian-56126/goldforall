import { fmtMoney, fmtNum } from '../format.js';

const TROY_OZ_GRAMS = 31.1035;

export default function PriceTicker({ prices, error }) {
  if (error) return <div className="card ticker error-card">{error}</div>;
  if (!prices) return <div className="card ticker">Cargando precio del oro…</div>;

  const perGram = prices.gold_usd_oz / TROY_OZ_GRAMS;

  return (
    <div className="card ticker">
      <div className="ticker-main">
        <div>
          <p className="ticker-label">
            <span className="live-dot" aria-hidden="true" />
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
      <p className="ticker-time">
        Oro actualizado:{' '}
        {new Date(prices.gold_updated_at || prices.fetched_at).toLocaleTimeString('es-CO')}
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
