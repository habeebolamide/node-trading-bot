# Tasks: m8-dashboard-shell

`[x]` done — dashboard boots + vite build produces 273kB (87kB gzip) bundle.

- [x] apps/dashboard scaffold (Vite + React 18 + TS + Tailwind + TanStack Query + Router)
- [x] hand-rolled shadcn-style UI primitives (Card, Badge, Table, Skeleton, Tabs)
- [x] api.ts fetch wrapper reading VITE_API_URL, defaults to /api (Vite dev proxies to :3000)
- [x] Layout + Sidebar with §26 nav; Overview page with 4 KPI cards over /api/overview
- [x] Placeholder pages for every nav item (later changes fill them in)
- [x] typecheck (root tsc --build + dashboard tsc --noEmit) both green
- [x] vite build green
