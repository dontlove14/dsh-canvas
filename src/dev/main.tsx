import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '../client/styles.css'
import { CanvasApp } from '../client/Canvas'
import { CanvasApi } from '../client/api'

// The standalone page has no Harness theme presenter; keep its fallback palette.
document.documentElement.style.colorScheme = 'dark'
const api = new CanvasApi()
createRoot(document.getElementById('root')!).render(<CanvasApp api={api} />)
