import type { ReactNode } from 'react';

type SectionCardProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

export function SectionCard({ title, description, children }: SectionCardProps) {
  return (
    <section
      style={{
        background: '#FFFFFF',
        borderRadius: '20px',
        padding: '24px',
        boxShadow: '0 2px 16px rgba(0,0,0,0.07)',
      }}
    >
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 800, color: '#000', margin: 0 }}>{title}</h2>
        {description ? (
          <p style={{ fontSize: '13px', color: '#999', marginTop: '4px' }}>{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}
