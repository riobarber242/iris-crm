// Prueba OFFLINE del parser del saldo del panel de agentes.plus (sin red ni base).
// El HTML real se relevó el 02/10/2026 desde un navegador logueado:
//   <div class="balance">Saldo disponible: <span data-current-agent-balance>463.807,00</span></div>
// Uso:  npx tsx scripts/verify-agentesplus-panel-parse.ts
import { parseArsAmount, parseDashboardBalance } from '../src/lib/casino/providers/agentesplus-panel';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${name} → ${JSON.stringify(got)}${ok ? '' : `  (esperado ${JSON.stringify(want)})`}`);
};

eq('monto real', parseArsAmount('463.807,00'), 463807);
eq('con centavos', parseArsAmount('1.234.567,89'), 1234567.89);
eq('chico', parseArsAmount('0,50'), 0.5);
eq('sin decimales', parseArsAmount('12.000'), 12000);
eq('con $ y nbsp', parseArsAmount('$\u00a0463.807,00'), 463807);
eq('negativo', parseArsAmount('-1.500,00'), -1500);
eq('formato US rechazado', parseArsAmount('463,807.00'), null);
eq('vacío', parseArsAmount(''), null);
eq('texto', parseArsAmount('N/D'), null);

const real = '<main class="content"><div class="balance-stack"><div class="balance">Saldo disponible: <span data-current-agent-balance>463.807,00</span></div></div></main>';
eq('dashboard real', parseDashboardBalance(real), { balance: 463807, raw: '463.807,00' });
eq('span con atributos extra', parseDashboardBalance('<span class="x" data-current-agent-balance="" id="b"> 1.000,00 </span>'), { balance: 1000, raw: '1.000,00' });
eq('fallback por etiqueta', parseDashboardBalance('<div class="saldo">Saldo disponible: <b>$ 2.500,00</b></div>'), { balance: 2500, raw: '2.500,00' });
eq('formulario de login', parseDashboardBalance('<form method="post" id="login-form"><input name="username"></form>'), null);
eq('span vacío', parseDashboardBalance('<span data-current-agent-balance></span>'), null);

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
