// Campos de diagnóstico del número que se piden a la Graph API al tocar "Verificar"
// (GET /{phone_number_id}). Solo lectura: no registra ni modifica nada en Meta.
export const PHONE_STATUS_FIELDS = [
  'display_phone_number',
  'verified_name',
  'status',                   // CONNECTED, PENDING (sin registrar), FLAGGED, RESTRICTED…
  'platform_type',            // CLOUD_API, ON_PREMISE o NOT_APPLICABLE (sin registrar)
  'code_verification_status', // VERIFIED, NOT_VERIFIED, EXPIRED
  'name_status',              // APPROVED, PENDING_REVIEW, DECLINED…
  'quality_rating',           // GREEN, YELLOW, RED, UNKNOWN
].join(',');

export type PhoneStatus = {
  display_phone_number: string | null;
  verified_name: string | null;
  status: string | null;
  platform_type: string | null;
  code_verification_status: string | null;
  name_status: string | null;
  quality_rating: string | null;
};

export function pickPhoneStatus(data: any): PhoneStatus {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    display_phone_number:     s(data?.display_phone_number),
    verified_name:            s(data?.verified_name),
    status:                   s(data?.status),
    platform_type:            s(data?.platform_type),
    code_verification_status: s(data?.code_verification_status),
    name_status:              s(data?.name_status),
    quality_rating:           s(data?.quality_rating),
  };
}

// Línea de una sola vista para el resultado de "Verificar" en el panel.
export function phoneStatusSummary(p: PhoneStatus): string {
  const parts = [
    p.display_phone_number ?? 'OK',
    p.verified_name && `"${p.verified_name}"`,
    p.status && `estado ${p.status}`,
    p.platform_type && `plataforma ${p.platform_type}`,
    p.code_verification_status && `código ${p.code_verification_status}`,
    p.name_status && `nombre ${p.name_status}`,
    p.quality_rating && `calidad ${p.quality_rating}`,
  ];
  return parts.filter(Boolean).join(' · ');
}
