import { useRef } from 'react'
import { useAuth } from './contexts/AuthContext'
import { usePermissions } from './contexts/PermissionsContext'
import LoginPage from './pages/LoginPage'
import FabricCuttingModule from './FabricCuttingModule'
import { Layers } from 'lucide-react'

export default function App() {
  const { loading: authLoading, session } = useAuth()
  const { loading: permsLoading } = usePermissions()

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

  return <FabricCuttingModule />
}
