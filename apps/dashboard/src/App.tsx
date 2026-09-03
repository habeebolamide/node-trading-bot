import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { Overview } from '@/pages/Overview';
import { Agents } from '@/pages/Agents';
import { Signals } from '@/pages/Signals';
import { Predictions } from '@/pages/Predictions';
import { Portfolios } from '@/pages/Portfolios';
import { Brain } from '@/pages/Brain';
import { Performance } from '@/pages/Performance';
import { Backtests } from '@/pages/Backtests';
import { Data } from '@/pages/Data';
import { Attribution } from '@/pages/Attribution';
import { LlmReview } from '@/pages/LlmReview';
import { Tokens } from '@/pages/Tokens';
import { SmartMoney } from '@/pages/SmartMoney';
import { Settings } from '@/pages/Settings';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'agents', element: <Agents /> },
      { path: 'agents/:id', element: <Agents /> },
      { path: 'data', element: <Data /> },
      { path: 'signals', element: <Signals /> },
      { path: 'signals/:id', element: <Signals /> },
      { path: 'predictions', element: <Predictions /> },
      { path: 'predictions/:id', element: <Predictions /> },
      { path: 'portfolios', element: <Portfolios /> },
      { path: 'portfolios/:id', element: <Portfolios /> },
      { path: 'brain', element: <Brain /> },
      { path: 'performance', element: <Performance /> },
      { path: 'backtests', element: <Backtests /> },
      { path: 'attribution', element: <Attribution /> },
      { path: 'llm-review', element: <LlmReview /> },
      { path: 'tokens', element: <Tokens /> },
      { path: 'smart-money', element: <SmartMoney /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
