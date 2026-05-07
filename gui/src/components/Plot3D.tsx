import { useEffect, useRef } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

interface Props {
  data: AnyObj[]
  layout?: AnyObj
  className?: string
}

const BASE_LAYOUT: AnyObj = {
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor:  'rgba(0,0,0,0)',
  font: { color: '#94a3b8', size: 11, family: 'monospace' },
  margin: { l: 10, r: 10, t: 40, b: 10 },
  scene: {
    xaxis: { gridcolor: '#334155', zerolinecolor: '#334155', color: '#64748b' },
    yaxis: { gridcolor: '#334155', zerolinecolor: '#334155', color: '#64748b' },
    zaxis: { gridcolor: '#334155', zerolinecolor: '#334155', color: '#64748b' },
    bgcolor: 'rgba(0,0,0,0)',
  },
}

export function Plot3D({ data, layout = {}, className = 'h-96' }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    let alive = true

    import('plotly.js-dist-min').then(mod => {
      if (!alive || !el) return
      const Plotly = (mod as AnyObj).default ?? mod
      const merged = { ...BASE_LAYOUT, ...layout }
      Plotly.react(el, data, merged, { responsive: true, displayModeBar: false })
    })

    return () => {
      alive = false
      import('plotly.js-dist-min').then(mod => {
        const Plotly = (mod as AnyObj).default ?? mod
        if (el) Plotly.purge(el)
      })
    }
  }, [data, layout])

  return <div ref={ref} className={className} />
}
