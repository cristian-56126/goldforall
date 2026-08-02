import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { fmtMoney, fmtNum } from '../format.js';

// Gráfica del histórico reciente — SVG puro, sin librerías.
//
// Tres decisiones que evitan que la curva mienta:
//   1. La X sale de la marca de tiempo, no del índice. La instancia gratuita
//      del backend se duerme y deja huecos de horas; con la X por índice, un
//      hueco de 2 h ocupa lo mismo que uno de 5 min y el eje temporal es falso.
//   2. Un hueco mayor que 3 intervalos de muestreo parte la línea en tramos:
//      unir los extremos dibujaría un movimiento de precio que nadie midió.
//   3. Serie plana (fin de semana, mercado spot cerrado) se dibuja centrada.
//      Escalar un recorrido de cero pegaba la línea al borde inferior, que es
//      exactamente lo que parece una gráfica rota.
const W = 100;
const H = 30;
const PAD = 2;

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
  const { history, summary, hours = 6, sample_seconds: sampleSeconds = 300 } = data;

  if (!summary || history.length < 2) {
    return (
      <div className="card gold-history">
        <h3>Histórico {hours} horas</h3>
        <p className="gh-collecting">
          Recopilando datos del mercado… {history.length} muestra{history.length === 1 ? '' : 's'}.
          La curva aparece con la segunda muestra.
        </p>
      </div>
    );
  }

  const puntos = history.map((fila) => ({
    t: new Date(fila.recorded_at).getTime(),
    v: Number(fila.gold_usd_oz),
  }));

  const t0 = puntos[0].t;
  const tSpan = puntos[puntos.length - 1].t - t0 || 1;
  const vSpan = summary.max - summary.min;

  const x = (t) => PAD + ((t - t0) / tSpan) * (W - PAD * 2);
  const y = (v) => (vSpan === 0 ? H / 2 : H - PAD - ((v - summary.min) / vSpan) * (H - PAD * 2));

  // Corte de tramo con margen: una muestra puede llegar unos segundos tarde
  // sin que eso sea una interrupción del muestreo.
  const huecoMaxMs = sampleSeconds * 3 * 1000;
  const tramos = [[puntos[0]]];
  for (let i = 1; i < puntos.length; i += 1) {
    if (puntos[i].t - puntos[i - 1].t > huecoMaxMs) tramos.push([]);
    tramos[tramos.length - 1].push(puntos[i]);
  }

  const sinCambio = summary.change === 0;
  const up = summary.change > 0;
  const claseCambio = sinCambio ? 'gh-change flat' : up ? 'gh-change up' : 'gh-change down';
  const from = new Date(puntos[0].t);
  const to = new Date(puntos[puntos.length - 1].t);
  const hhmm = (d) => d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="card gold-history">
      <div className="gh-head">
        <h3>Histórico {hours} horas</h3>
        <span className={claseCambio}>
          {sinCambio ? '–' : up ? '▲' : '▼'} {fmtNum(Math.abs(summary.change), 2)} (
          {fmtNum(summary.change_pct, 2)}%)
        </span>
      </div>

      <svg
        className="gh-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Precio del oro últimas ${hours} horas, de ${fmtMoney(summary.first, 'USD')} a ${fmtMoney(summary.last, 'USD')}`}
      >
        {tramos.map((tramo, indice) => {
          const clave = tramo[0].t;
          // Un tramo suelto (muestra aislada entre dos huecos) no tiene línea
          // que dibujar: se marca con un tick para que no desaparezca.
          if (tramo.length === 1) {
            const cx = x(tramo[0].t).toFixed(2);
            const cy = y(tramo[0].v);
            return (
              <line
                key={clave}
                x1={cx}
                x2={cx}
                y1={(cy - 0.7).toFixed(2)}
                y2={(cy + 0.7).toFixed(2)}
                className="gh-tick"
              />
            );
          }
          const linea = tramo
            .map((punto) => `${x(punto.t).toFixed(2)},${y(punto.v).toFixed(2)}`)
            .join(' ');
          const xIni = x(tramo[0].t).toFixed(2);
          const xFin = x(tramo[tramo.length - 1].t).toFixed(2);
          return (
            <g key={clave} data-tramo={indice}>
              <polyline
                points={`${linea} ${xFin},${H - PAD} ${xIni},${H - PAD}`}
                className="gh-area"
              />
              <polyline points={linea} className="gh-line" />
            </g>
          );
        })}
      </svg>

      <div className="gh-scale">
        <span>{hhmm(from)}</span>
        <span>{hhmm(to)}</span>
      </div>

      {vSpan === 0 && (
        <p className="gh-collecting">
          Sin movimiento en la ventana: el mercado spot no cotiza fines de semana ni festivos.
        </p>
      )}

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
