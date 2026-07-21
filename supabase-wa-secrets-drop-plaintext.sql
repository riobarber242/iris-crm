-- PR5, paso final: borrar el texto plano de los secretos de whatsapp_numbers.
-- Idempotente (solo toca filas que todavía tengan valor).
--
-- ⚠️ CORRER SOLO DESPUÉS de verificar en PRODUCCIÓN que el cifrado funciona.
-- Verificación hecha el 21/07/2026 sobre Derki, único tenant con secretos propios:
--   · app_secret_enc   → sonda firmada al webhook: 200. Con el código fail-closed
--     ya deployado, un 200 SOLO es posible si el cifrado descifró y coincide.
--   · access_token_enc → campaña send_limit:1 disparada por el cron de producción:
--     sent=1, mensaje entregado y leído.
--   · Tráfico entrante normal de Derki siguió entrando después del corte.
--
-- Riesgo de este UPDATE: ninguno a nivel comportamiento. El código deployado
-- (readWaSecret, PR5) ya NO lee estas columnas, así que vaciarlas no puede
-- cambiar nada. El riesgo estaba en el corte de código, que ya está verificado.
--
-- NO recuperable: una vez en null, el valor plano no se puede reconstruir. No
-- hace falta: el valor vive cifrado en *_enc, y si algún día se perdiera la
-- clave, el camino correcto es regenerar el token/secret en Meta, no volver a
-- guardarlo en claro.
--
-- Las COLUMNAS no se borran acá a propósito: el drop definitivo conviene hacerlo
-- en una limpieza aparte, cuando ya no quede ningún deploy viejo en circulación.

update whatsapp_numbers
set access_token = null,
    app_secret   = null
where access_token is not null
   or app_secret  is not null;


-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════

-- V1. Ninguna fila conserva texto plano, y todas las que tenían secretos propios
--     conservan su versión cifrada. Esperado: plano_token = 0, plano_secret = 0.
select
  count(*)                                        as filas,
  count(*) filter (where access_token is not null) as plano_token,
  count(*) filter (where app_secret   is not null) as plano_secret,
  count(*) filter (where access_token_enc is not null) as cifrado_token,
  count(*) filter (where app_secret_enc   is not null) as cifrado_secret
from whatsapp_numbers;

-- V2. Detalle por línea, sin exponer secretos.
select label,
       (access_token_enc is not null) as tiene_token_cifrado,
       (app_secret_enc   is not null) as tiene_secret_cifrado,
       (access_token is not null)     as tiene_token_plano,
       (app_secret   is not null)     as tiene_secret_plano
from whatsapp_numbers
order by label;
