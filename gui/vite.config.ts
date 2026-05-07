import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'child_process'
import { writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export default defineConfig({
  base: '/kinetichawkes/',
  plugins: [
    react(),
    {
      name: 'sim-runner',
      configureServer(server) {
        server.middlewares.use('/api/run', (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end('Method Not Allowed')
            return
          }

          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            let config: unknown
            try { config = JSON.parse(body) } catch {
              res.writeHead(400).end('Bad JSON')
              return
            }

            const configPath = join(tmpdir(), `hawkes_run_${Date.now()}.json`)
            writeFileSync(configPath, JSON.stringify(config, null, 2))

            const root    = join(__dirname, '..')
            const binary  = join(root, 'hawkes-hft', 'build', 'hawkes-hft')
            const dbn     = join(root, 'data', 'MSFT_20240303_20240314_mbo.dbn')
            const outPath = join(__dirname, 'public', 'sim_data.jsonl')

            // Clear the output file so polls see only fresh data
            writeFileSync(outPath, '')

            const proc = spawn(binary, [dbn, configPath], { stdio: ['ignore', 'pipe', 'pipe'] })

            let lineCount = 0
            let stderr    = ''

            proc.stdout.on('data', (d: Buffer) => {
              const chunk = d.toString()
              // Write incrementally so the frontend can poll the growing file
              appendFileSync(outPath, chunk)
              lineCount += chunk.split('\n').filter(Boolean).length
            })
            proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

            proc.on('close', (code: number | null) => {
              if (code === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, lines: lineCount }))
              } else {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: stderr.slice(-800) }))
              }
            })

            proc.on('error', (err: Error) => {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: err.message }))
            })
          })
        })
      },
    },
  ],
})
