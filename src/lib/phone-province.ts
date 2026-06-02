// Argentine phone prefix → province mapping.
// Numbers in DB are stored as international format: 549XXXXXXXXX or 54XXXXXXXXX
// After stripping country code (54) and optional mobile prefix (9),
// the remainder starts with the local area code.

const PREFIX_MAP: [string, string][] = [
  // 4-digit prefixes first (longest match wins)
  ['2901', 'Tierra del Fuego'],
  ['2902', 'Santa Cruz'],
  ['2920', 'Río Negro'],
  ['2954', 'La Pampa'],
  ['2964', 'Tierra del Fuego'],
  ['2966', 'Santa Cruz'],
  ['3327', 'Buenos Aires'],
  ['3385', 'Buenos Aires'],
  ['3564', 'Córdoba'],
  ['3571', 'Córdoba'],
  ['3576', 'Córdoba'],
  // 3-digit prefixes
  ['220', 'Buenos Aires'],
  ['221', 'Buenos Aires'],
  ['223', 'Buenos Aires'],
  ['230', 'Buenos Aires'],
  ['237', 'Buenos Aires'],
  ['249', 'Buenos Aires'],
  ['261', 'Mendoza'],
  ['262', 'Mendoza'],
  ['263', 'San Juan'],
  ['264', 'San Juan'],
  ['266', 'San Luis'],
  ['280', 'Chubut'],
  ['291', 'Buenos Aires'],
  ['294', 'Río Negro'],
  ['297', 'Chubut'],
  ['298', 'Río Negro'],
  ['299', 'Neuquén'],
  ['336', 'Buenos Aires'],
  ['341', 'Santa Fe'],
  ['342', 'Santa Fe'],
  ['343', 'Entre Ríos'],
  ['345', 'Entre Ríos'],
  ['348', 'Buenos Aires'],
  ['351', 'Córdoba'],
  ['353', 'Córdoba'],
  ['354', 'Córdoba'],
  ['358', 'Córdoba'],
  ['362', 'Chaco'],
  ['370', 'Formosa'],
  ['376', 'Misiones'],
  ['379', 'Corrientes'],
  ['380', 'La Rioja'],
  ['381', 'Tucumán'],
  ['383', 'Catamarca'],
  ['385', 'Santiago del Estero'],
  ['387', 'Salta'],
  ['388', 'Jujuy'],
  // 2-digit prefixes (lowest priority)
  ['11', 'Buenos Aires'],  // CABA + GBA
];

export function inferProvinciaFromPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');

  let local = digits;
  if (local.startsWith('549')) local = local.slice(3);
  else if (local.startsWith('54')) local = local.slice(2);

  // Mobile numbers sometimes have a leading 9 after country code
  if (local.startsWith('9') && local.length >= 10) local = local.slice(1);

  for (const [prefix, provincia] of PREFIX_MAP) {
    if (local.startsWith(prefix)) return provincia;
  }
  return null;
}
