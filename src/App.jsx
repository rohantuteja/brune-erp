import { useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useAuth } from './contexts/AuthContext'
import { usePermissions } from './contexts/PermissionsContext'
import LoginPage from './pages/LoginPage'
import FabricCuttingModule from './FabricCuttingModule'
import { Layers, RefreshCw } from 'lucide-react'

export default function App() {
  const { loading: authLoading, session } = useAuth()
  const { loading: permsLoading } = usePermissions()

  // PWA update detection — shows a banner when a new version is ready.
  // The browser detects the new service worker automatically (no polling).
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW()

  // Track whether we've ever successfully finished the initial load.
  // Once true, we never show the spinner again — background permission
  // re-fetches (e.g. after a Supabase token refresh) must not unmount
  // FabricCuttingModule and close open modals.
  const everLoaded = useRef(false)
  if (!authLoading && !permsLoading && session) everLoaded.current = true

  // Show spinner only on the very first load, before we have any data.
  const showSpinner = authLoading || (session && permsLoading && !everLoaded.current)

  if (showSpinner) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-stone-900 rounded-xl flex items-center justify-center animate-pulse">
            <Layers className="w-6 h-6 text-white" />
          </div>
          <p className="text-sm text-stone-500">Loading…</p>
        </div>
      </div>
    )
  }

  if (!session) return <LoginPage />

  return (
    <>
      <FabricCuttingModule />

      {/* New deployment banner — only visible when a new SW is waiting */}
      {needRefresh && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-stone-900 text-white rounded-xl px-4 py-3 shadow-xl border border-stone-700 w-max max-w-[calc(100vw-2rem)]">
          <RefreshCw className="w-4 h-4 shrink-0 text-stone-400" />
          <p className="text-sm">A new version is available.</p>
          <button
            onClick={() => updateServiceWorker(true)}
            className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-stone-900 hover:bg-stone-100 transition-colors"
          >
            Update now
          </button>
        </div>
      )}
    </>
  )
}
