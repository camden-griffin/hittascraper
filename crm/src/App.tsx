import { useAuth } from './hooks/useAuth';
import { Login } from './components/Login';
import { LeadsTable } from './components/LeadsTable';

export default function App() {
  const auth = useAuth();

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <h1 className="text-lg font-semibold">Hittascraper CRM</h1>
      </header>
      <div className="flex-1 overflow-hidden">
        {auth.loggedIn ? <LeadsTable logout={auth.logout} /> : <Login auth={auth} />}
      </div>
    </div>
  );
}
