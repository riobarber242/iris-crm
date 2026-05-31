import type { ReactNode } from 'react';

type SectionCardProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

export function SectionCard({ title, description, children }: SectionCardProps) {
  return (
    <section className="rounded-[32px] border border-white/10 bg-iris-card p-6 shadow-iris">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">{title}</h2>
          {description ? <p className="mt-2 text-sm text-iris-text-muted">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
