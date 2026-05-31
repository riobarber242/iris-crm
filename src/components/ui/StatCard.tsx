type StatCardProps = {
  label: string;
  value: string;
  description?: string;
  accent?: 'purple' | 'gold' | 'pink' | 'green';
};

const accentClasses: Record<string, string> = {
  purple: 'bg-iris-purple/10 text-iris-purple',
  gold: 'bg-iris-gold/10 text-iris-gold',
  pink: 'bg-iris-pink/10 text-iris-pink',
  green: 'bg-iris-green/10 text-iris-green',
};

export function StatCard({ label, value, description, accent = 'purple' }: StatCardProps) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-iris-card p-6 shadow-iris">
      <div className={`inline-flex rounded-full px-3 py-1 text-sm font-semibold ${accentClasses[accent]}`}>
        {label}
      </div>
      <p className="mt-6 text-4xl font-semibold text-white">{value}</p>
      {description ? <p className="mt-2 text-sm text-iris-text-muted">{description}</p> : null}
    </div>
  );
}
