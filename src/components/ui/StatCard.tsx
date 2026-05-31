type StatCardProps = {
  label: string;
  value: string;
  description?: string;
  accent?: 'purple' | 'gold' | 'pink' | 'green';
};

export function StatCard({ label, value, description }: StatCardProps) {
  return (
    <div
      style={{
        background: '#FFFFFF',
        borderRadius: '20px',
        padding: '24px',
        boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
      }}
    >
      <p style={{ fontSize: '12px', fontWeight: 600, color: '#999', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
        {label}
      </p>
      <p style={{ fontSize: '48px', fontWeight: 900, color: '#000', margin: '12px 0 0 0', lineHeight: 1 }}>
        {value}
      </p>
      {description ? (
        <p style={{ fontSize: '13px', color: '#999', marginTop: '8px' }}>{description}</p>
      ) : null}
      <div style={{ marginTop: '16px', height: '4px', width: '40px', borderRadius: '2px', background: '#C8FF00' }} />
    </div>
  );
}
