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
        <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-3 bg-stone-900 px-4 py-3 shadow-lg">
          <p className="text-sm text-white">A new version of the app is available.</p>
          <button
            onClick={() => updateServiceWorker(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-stone-900 hover:bg-stone-100 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Update now
          </button>
        </div>
      )}
    </>
  )
}
