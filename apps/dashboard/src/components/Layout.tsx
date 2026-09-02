import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
export function Layout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
