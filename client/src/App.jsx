import { useCallback, useState } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import Dashboard from './components/Dashboard.jsx';
import { clearSession, loadSession, saveSession } from './lib/session.js';

export default function App() {
  const [session, setSession] = useState(loadSession);

  const handleAuthenticated = useCallback((next) => {
    saveSession(next);
    setSession(next);
  }, []);

  const handleSignOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  if (!session) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return <Dashboard session={session} onSignOut={handleSignOut} />;
}
