import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['--import', 'tsx', 'src/dev/server.ts'], { stdio: 'inherit', env: process.env })
process.once('SIGINT', () => child.kill('SIGINT'))
process.once('SIGTERM', () => child.kill('SIGTERM'))
child.once('exit', (code) => process.exit(code ?? 0))
