type StatCardProps = {
  label: string;
  value: string;
  description?: string;
  accent?: 'purple' | 'gold' | 'pink' | 'green';
};

const accentClasses: Record<string, string> = {
  purple: 'bg-[#C6FF00]/10 text-[#C6FF00]',
  gold: 'bg-[#C6FF00]/10 text-[#C6FF00]',
  pink: 'bg-[#C6FF00]/10 text-[#C6FF00]',
  green: 'bg-[#C6FF00]/10 text-[#C6FF00]',
};

export function StatCard({ label, value, description, accent = 'purple' }: StatCardProps) {
  return (
    <div className="rounded-[24px] border-2 border-[#C6FF00] bg-[#111111] p-6 shadow-iris">
      <div className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ${accentClasses[accent]}`}>
        {label}
      </div>
      <p className="mt-6 text-5xl font-bold text-white">{value}</p>
      {description ? <p className="mt-2 text-sm text-[#888888]">{description}</p> : null}
    </div>
  );
}
