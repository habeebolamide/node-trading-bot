import React from 'react';
import { createRoot } from 'react-dom/client';
function App() {
  return (
    <main>
      <h1>Strategy platform</h1>
      <p>Phase 1 · Foundation</p>
      <p>PAPER configuration only. Trading is not active.</p>
      <p>The operator dashboard and bot controls arrive in Phase 7.</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
