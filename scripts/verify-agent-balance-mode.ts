// Prueba OFFLINE (sin red ni base) del modo de stock con saldo del agente opcional y
// de cómo buildProviderPatch conserva / borra la marca agent_balance_verified_at.
// SECRET_ENC_KEY: clave de TEST fija (solo cifra blobs en memoria).
// Uso:  npx tsx scripts/verify-agent-balance-mode.ts
process.env.SECRET_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
import { stockModeFrom } from '../src/lib/casino/stock-mode';
import { AGENT_BALANCE_VERIFIED_KEY as K, UNREADABLE_PROVIDER, buildProviderPatch } from '../src/lib/casino/provider-account';
import { getProvider } from '../src/lib/casino/providers';
import { decryptSecret, encryptSecret } from '../src/lib/secure-secret';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${name} → ${JSON.stringify(got)}${ok ? '' : `  (esperado ${JSON.stringify(want)})`}`);
};

console.log('— stockModeFrom');
eq('casino apagado', stockModeFrom(false, 'agentesplus', { [K]: 'x' }), 'manual');
eq('celuapuestas (17Star) sin config', stockModeFrom(true, 'celuapuestas'), 'casino');
eq('celuapuestas con config raro', stockModeFrom(true, 'celuapuestas', { [K]: '' }), 'casino');
eq('agentes.plus sin marca', stockModeFrom(true, 'agentesplus', {}), 'hybrid');
eq('agentes.plus sin config', stockModeFrom(true, 'agentesplus', null), 'hybrid');
eq('agentes.plus con marca', stockModeFrom(true, 'agentesplus', { [K]: '2026-10-03T00:00:00Z' }), 'casino');
eq('agentes.plus marca vacía', stockModeFrom(true, 'agentesplus', { [K]: '' }), 'hybrid');
eq('proveedor desconocido', stockModeFrom(true, 'otro_casino', {}), 'casino');
eq('fila ilegible', stockModeFrom(true, UNREADABLE_PROVIDER, null), 'casino');
eq('sin fila', stockModeFrom(true, null), 'casino');

console.log('— buildProviderPatch (agentes.plus con saldo activado)');
const ap = getProvider('agentesplus')!;
const row = {
  id: 'acc', tenant_id: 't', provider: 'agentesplus',
  config: { panel_user: 'agente1', [K]: '2026-10-03T00:00:00Z' },
  secrets_enc: encryptSecret(JSON.stringify({ api_key: 'KEY123456', panel_password: 'Pass1234' })),
};
const blobOf = (p: any) => p.secrets_enc ? JSON.parse(decryptSecret(p.secrets_enc)) : null;
const base = { api_key: '', api_url: '', panel_user: 'agente1', panel_password: '', panel_url: '', panel_via: '' };

let r = buildProviderPatch(ap, row, { values: base });
eq('sin cambios: marca', r.patch.config[K], row.config[K]);
eq('sin cambios: flags', [r.connChanged, r.balanceChanged, r.agentBalanceTurnedOff], [false, false, false]);

r = buildProviderPatch(ap, row, { values: { ...base, panel_password: 'Nueva999' } });
eq('nueva contraseña: marca se conserva', r.patch.config[K], row.config[K]);
eq('nueva contraseña: flags', [r.connChanged, r.balanceChanged, r.agentBalanceTurnedOff], [false, true, false]);

r = buildProviderPatch(ap, row, { values: base, clear: ['panel_password'] });
eq('borrar contraseña: marca fuera', r.patch.config[K], undefined);
eq('borrar contraseña: flags', [r.connChanged, r.balanceChanged, r.agentBalanceTurnedOff], [false, true, true]);
eq('borrar contraseña: api_key intacta, sin panel_password', blobOf(r.patch), { api_key: 'KEY123456' });

r = buildProviderPatch(ap, row, { values: { ...base, panel_user: '' } });
eq('usuario vacío: marca fuera', [r.patch.config[K], r.agentBalanceTurnedOff], [undefined, true]);

r = buildProviderPatch(ap, row, { values: base, clear: ['api_key'] });
eq('no se puede borrar la api_key (obligatoria)', [blobOf(r.patch), r.missing], [null, []]);

r = buildProviderPatch(ap, row, { values: { ...base, panel_via: 'directo' } });
eq('cambiar salida: marca se conserva', [r.patch.config[K], r.connChanged, r.balanceChanged], [row.config[K], false, true]);

r = buildProviderPatch(ap, row, { values: { ...base, api_key: 'OTRAKEY999' } });
eq('nueva api_key: apaga casino (conn) y conserva marca', [r.connChanged, r.balanceChanged, r.patch.config[K]], [true, false, row.config[K]]);

const sinMarca = { ...row, config: { panel_user: 'agente1' } };
r = buildProviderPatch(ap, sinMarca, { values: base, clear: ['panel_password'] });
eq('sin marca + borrar: no "turned off"', r.agentBalanceTurnedOff, false);

console.log(fails ? `\n${fails} FALLA(S)` : '\nTodo OK');
process.exit(fails ? 1 : 0);
