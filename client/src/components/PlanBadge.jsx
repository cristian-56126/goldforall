export default function PlanBadge({ plan, onSubscribe }) {
  const isPremium = plan.plan_code === 'premium';

  return (
    <div className={isPremium ? 'card plan premium' : 'card plan'}>
      <h3>{plan.plan_name}</h3>

      {isPremium ? (
        <>
          <p className="plan-line">Consultas ilimitadas</p>
          {plan.subscription_expires_at && (
            <p className="plan-line small">
              Vence: {new Date(plan.subscription_expires_at).toLocaleDateString('es-CO')}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="plan-line">
            Consultas hoy: <b>{plan.used_today}</b> / {plan.daily_limit}
          </p>
          <div className="quota-bar">
            <div
              className="quota-fill"
              style={{ width: `${Math.min(100, (plan.used_today / plan.daily_limit) * 100)}%` }}
            />
          </div>
          {onSubscribe ? (
            <>
              <button className="btn-gold small" onClick={onSubscribe}>
                Mejorar a Premium
              </button>
              <p className="plan-line small">Suscripción mensual · consultas ilimitadas</p>
            </>
          ) : (
            <p className="plan-line small">
              Premium (consultas ilimitadas) lo activa un administrador.
            </p>
          )}
        </>
      )}
    </div>
  );
}
