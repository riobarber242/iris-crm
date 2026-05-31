import type { ReactNode } from 'react';

type SectionCardProps = {
  title: string;
  description?: string;
  children: ReactNode;
};

export function SectionCard({ title, description, children }: SectionCardProps) {
  return (
    <section className="rounded-[24px] border-2 border-[#C6FF00] bg-[#111111] p-6 shadow-iris">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">{title}</h2>
          {description ? <p className="mt-2 text-sm text-[#888888]">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
