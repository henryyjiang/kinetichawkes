import { useState, useRef } from 'react'

interface Props { onLoad: (text: string) => void }

export function FileDropzone({ onLoad }: Props) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const read = (file: File) => {
    const reader = new FileReader()
    reader.onload = e => { if (e.target?.result) onLoad(e.target.result as string) }
    reader.readAsText(file)
  }

  return (
    <div
      onDrop={e => { e.preventDefault(); setDragging(false); read(e.dataTransfer.files[0]) }}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onClick={() => inputRef.current?.click()}
      className={`
        flex flex-col items-center justify-center gap-4 cursor-pointer
        border-2 border-dashed rounded-2xl p-20 text-center transition-colors
        ${dragging ? 'border-sky-400 bg-sky-400/5' : 'border-slate-600 hover:border-slate-500'}
      `}
    >
      <div className="text-5xl">📊</div>
      <div>
        <p className="text-lg font-semibold text-slate-300">Drop <code className="text-sky-400">sim_data.jsonl</code> here</p>
        <p className="text-sm text-slate-500 mt-1">or click to browse</p>
      </div>
      <p className="text-xs text-slate-600 max-w-sm">
        Generate with: <code className="text-slate-400">./hawkes-hft/build/hawkes-hft data/MSFT_*.dbn configs/MSFT.json &gt; gui/public/sim_data.jsonl</code>
      </p>
      <input ref={inputRef} type="file" accept=".jsonl,.json" className="hidden"
        onChange={e => { if (e.target.files?.[0]) read(e.target.files[0]) }} />
    </div>
  )
}
