import { useEffect, useState } from 'react'
import { browserGpuCapability, type GpuCapability } from './gpu'

const initial: GpuCapability = { enabled: false, reason: 'checking' }
export function useGpuCapability(): GpuCapability {
  const [capability, setCapability] = useState(initial)
  useEffect(() => {
    let mounted = true
    void browserGpuCapability().then((result) => { if (mounted) setCapability(result) })
    return () => { mounted = false }
  }, [])
  return capability
}
