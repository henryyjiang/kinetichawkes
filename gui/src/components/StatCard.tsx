interface Props {
  label: string
  value: string
  sub?: string
  tone?: 'pos' | 'neg' | 'neutral'
}

export function StatCard({ label, value, sub, tone = 'neutral' }: Props) {
  const c = tone === 'pos' ? 'text-emerald-400'
          : tone === 'neg' ? 'text-red-400'
          : 'text-slate-100'
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex flex-col gap-1">
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">{label}</p>
      <p className={`text-2xl font-bold font-mono leading-none ${c}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  )
}
