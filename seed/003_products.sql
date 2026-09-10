-- Seed 003 — ~20 representative catalogue SKUs (PLAN-DATA-MODEL.md §8).
-- Dev and staging only — production loads its real price list through
-- the API once it exists; this file is demo data, and a staging price
-- list of real SKUs is enough to exercise every screen that renders a
-- product (§8: the fixture states the UI is most likely to render
-- wrong).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed/003_products.sql
--
-- Idempotent: ON CONFLICT (sku) DO NOTHING. default_price pre-fills the
-- sale screen and is snapshotted at sale time (§3.5), so repricing
-- never rewrites history — the values here are representative, not
-- quoted.

INSERT INTO products (sku, name, category, brand, model_number, capacity_label, unit, default_price, warranty_months) VALUES
  -- UPS (online/line-interactive units sold to offices and shops)
  ('UPS-LUM-ECO1050',  'Luminous ECO Volt+ 1050 Sine Wave UPS',   'ups',       'Luminous', 'ECO VOLT+ 1050',  '1050VA',  'NOS', 6800.00, 24),
  ('UPS-MTK-SEBZ1100', 'Microtek SEBz 1100 UPS',                  'ups',       'Microtek', 'SEBz 1100',       '1100VA',  'NOS', 7200.00, 24),
  ('UPS-APC-BX1100',   'APC BX1100C-IN Line-Interactive UPS',     'ups',       'APC',      'BX1100C-IN',      '1100VA',  'NOS', 8400.00, 24),
  ('UPS-APC-SRV1K',    'APC Smart-UPS SRV 1KVA',                  'ups',       'APC',      'SRV1KI-IN',       '1kVA',    'NOS', 14500.00, 24),
  -- Inverters (home units — batteries bought alongside)
  ('INV-LUM-ECO900',   'Luminous ECO Volt 900 Sine Wave',         'inverter',  'Luminous', 'ECO900',          '900VA',   'NOS', 6200.00, 24),
  ('INV-MTK-EB1700',   'Microtek EB 1700 Digital',                'inverter',  'Microtek', 'EB1700',          '1700VA',  'NOS', 9100.00, 24),
  ('INV-VGD-SMART1550','V-Guard Smart Pro 1550',                  'inverter',  'V-Guard',  'SMART PRO 1550',  '1550VA',  'NOS', 8800.00, 24),
  -- Batteries (tubular inverter batteries dominate the service load)
  ('BAT-EXD-IMST1500', 'Exide Inva Tubular IMST1500',             'battery',   'Exide',    'IMST1500',        '150Ah',   'NOS', 13900.00, 36),
  ('BAT-EXD-IMST2000', 'Exide Inva Tubular IMST2000',             'battery',   'Exide',    'IMST2000',        '200Ah',   'NOS', 16800.00, 36),
  ('BAT-AMR-AR150TN',  'Amaron Current AAM-CR-AR150TN49',         'battery',   'Amaron',   'AAM-CR-AR150TN49','150Ah',   'NOS', 13400.00, 36),
  ('BAT-LUM-RC18000',  'Luminous RC18000 Tall Tubular',           'battery',   'Luminous', 'RC18000',         '150Ah',   'NOS', 13100.00, 36),
  ('BAT-LUM-RC25000',  'Luminous RC25000 Tall Tubular',           'battery',   'Luminous', 'RC25000',         '200Ah',   'NOS', 16200.00, 36),
  ('BAT-QUA-6LMS150',  'Quanta 6LMS150 SMF Battery',              'battery',   'Quanta',   '6LMS150',         '150Ah',   'NOS', 18800.00, 24),
  ('BAT-SMF-12V7',     'Generic 12V 7.2Ah SMF Battery',           'battery',   'Quanta',   '12V7.2',          '7.2Ah',   'NOS', 1150.00, 12),
  -- Accessories
  ('ACC-STAB-5A',      'V-Guard VWI 5A Stabilizer',               'accessory', 'V-Guard',  'VWI 5A',          '5A',      'NOS', 2400.00, 12),
  ('ACC-TRLY-2B',      'Two-battery trolley, powder-coated',      'accessory', NULL,       NULL,              '2-battery','NOS', 1500.00, NULL),
  ('ACC-BATT-WTR',     'Battery top-up distilled water (1 L)',    'accessory', NULL,       NULL,              '1L',      'PCS',  60.00, NULL),
  -- Spares (service van stock)
  ('SPR-TERM-BRASS',   'Brass battery terminal, pair',            'spare',     NULL,       NULL,              NULL,      'PCS', 140.00, NULL),
  ('SPR-CABLE-6SQMM',  'Battery cable set, 6 sqmm, 1 m',          'spare',     NULL,       NULL,              '6 sqmm',  'PCS', 320.00, NULL),
  ('SPR-FAN-24V',      'Cooling fan 24V for UPS cabinet',         'spare',     NULL,       NULL,              '24V',     'PCS', 260.00, NULL)
ON CONFLICT (sku) DO NOTHING;

-- The catalogue read back — twenty rows or the operator looks.
SELECT category, count(*), sum(default_price)::bigint AS price_sum
FROM products
GROUP BY category
ORDER BY category;
