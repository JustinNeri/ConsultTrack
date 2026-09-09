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

  /*
   * The profile is captured at sign-in, so anything that changes it -- joining
   * a group, a rename, editing your section -- used to leave the top bar and
   * the profile screen showing yesterday's answer until you signed out.
   */
  const handleProfileChanged = useCallback((profile) => {
    setSession((current) => {
      if (!current) return current;
      const next = { ...current, profile: { ...current.profile, ...profile } };
      saveSession(next);
      return next;
    });
  }, []);

  const handleSignOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  if (!session) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  return (
    <Dashboard
      session={session}
      onSignOut={handleSignOut}
      onProfileChanged={handleProfileChanged}
    />
  );
}
