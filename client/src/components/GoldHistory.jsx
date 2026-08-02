import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { fmtMoney, fmtNum } from '../format.js';

// Gráfica de las últimas 12 horas — SVG puro, sin librerías.
export default function GoldHistory() {
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    api.priceHistory().then(setData).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return null;
  const { history, summary } = data;

  if (!summary || history.length < 2) {
    return (
      <div className="card gold-history">
        <h3>Histórico 12 horas</h3>
        <p className="gh-collecting">
          Recopilando datos del mercado… {history.length} muestra{history.length === 1 ? '' : 's'}.
          La curva aparece con la segunda muestra.
        </p>
      </div>
    );
  }

  // Normalizar puntos al viewBox 100 × 30
  const W = 100;
  const H = 30;
  const PAD = 2;
  const values = history.map((h) => Number(h.gold_usd_oz));
  const span = summary.max - summary.min || 1;
  const points = values
    .map((v, i) => {
      const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
      const y = H - PAD - ((v - summary.min) / span) * (H - PAD * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const up = summary.change >= 0;
  const from = new Date(history[0].recorded_at);
  const to = new Date(history[history.length - 1].recorded_at);
  const hhmm = (d) => d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="card gold-history">
      <div className="gh-head">
        <h3>Histórico 12 horas</h3>
        <span className={up ? 'gh-change up' : 'gh-change down'}>
          {up ? '▲' : '▼'} {fmtNum(Math.abs(summary.change), 2)} ({fmtNum(summary.change_pct, 2)}%)
        </span>
      </div>

      <svg
        className="gh-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Precio del oro últimas 12 horas, de ${fmtMoney(summary.first, 'USD')} a ${fmtMoney(summary.last, 'USD')}`}
      >
        <polyline
          points={`${points} ${W - PAD},${H - PAD} ${PAD},${H - PAD}`}
          className="gh-area"
        />
        <polyline points={points} className="gh-line" />
      </svg>

      <div className="gh-scale">
        <span>{hhmm(from)}</span>
        <span>{hhmm(to)}</span>
      </div>

      <div className="gh-stats">
        <span>
          Mín <b>{fmtMoney(summary.min, 'USD')}</b>
        </span>
        <span>
          Máx <b>{fmtMoney(summary.max, 'USD')}</b>
        </span>
        <span>
          Ahora <b>{fmtMoney(summary.last, 'USD')}</b>
        </span>
      </div>
    </div>
  );
}
