-- Servicios & Pagos (panel admin) — estado/vencimientos de los servicios de la plataforma.
-- Correr una vez en el SQL editor de Supabase. Es idempotente (se puede re-correr).

CREATE TABLE IF NOT EXISTS services (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  expires_at DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Seed de los 6 servicios iniciales (expires_at NULL → el admin los carga después).
-- NOT EXISTS por nombre para no duplicar si se re-corre.
INSERT INTO services (name, icon)
SELECT v.name, v.icon
FROM (VALUES
  ('Vercel',                  '🔺'),
  ('Supabase',                '⚡'),
  ('Dominio irisonline.app',  '🌐'),
  ('Meta WhatsApp API',       '💬'),
  ('Anthropic API',           '🤖'),
  ('Groq API',                '🧠')
) AS v(name, icon)
WHERE NOT EXISTS (SELECT 1 FROM services s WHERE s.name = v.name);
