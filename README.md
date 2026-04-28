# AcademiCats — frontend

The Next.js (App Router, React 19, TypeScript) frontend for AcademiCats,
an academic-research assistant that helps users structure searches,
inspect papers, and run drafts through a multi-agent peer review.

The repository is split into two services:

| Repo / dir                | Stack                  | Notes                                  |
| ------------------------- | ---------------------- | -------------------------------------- |
| `academic-ats-frontend/`  | Next.js 16 + React 19  | this directory; deploys to Vercel.     |
| `academic-ats-backend/`   | FastAPI / uvicorn      | sibling dir; deploys to Railway.       |

## Local development

Both services need to run side-by-side. The frontend talks to the backend
over `NEXT_PUBLIC_API_BASE_URL` — default `http://localhost:8000`.

```bash
# Terminal 1 — backend
cd ../academic-ats-backend
cp .env.example .env  # then fill in real Supabase + LLM keys
uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd academic-ats-frontend
npm install
npm run dev   # binds http://localhost:3000
```

Opening [http://localhost:3000](http://localhost:3000) loads the workspace.
The mobile layout auto-switches under ~640 px width; force it for testing
by narrowing the window or using devtools device emulation.

### Environment variables

Frontend reads two `NEXT_PUBLIC_*` values:

```dotenv
# .env.local
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi…
```

The Supabase keys are the project's _public_ anon key, not the service
role — the latter only lives in the backend's `.env` and never touches
the browser.

The full backend env-var inventory lives in
[`../academic-ats-backend/.env.example`](../academic-ats-backend/.env.example);
the boot-time audit in `settings.py` validates every variable on
startup.

## Project layout

```
src/
├── app/
│   ├── page.tsx               # the workspace — desktop + mobile entry
│   ├── search/                # legacy /search route (SSE explorer)
│   ├── admin/                 # admin dashboard (separate auth)
│   ├── login/                 # auth screen
│   ├── api/send-message/      # client-side server action
│   ├── error.tsx              # global App Router error boundary
│   ├── layout.tsx             # root layout + metadata
│   └── charts.tsx             # paper-set visualisations
├── components/
│   ├── lab/PaperReviewPanel   # multi-agent peer-review UI (SSE-driven)
│   ├── mobile/MobileApp       # full mobile reimplementation
│   ├── header/AnnouncementBanner
│   ├── sprite/Sprite          # the mascot animator
│   ├── ErrorBoundary          # in-region React boundary
│   ├── MaintenanceGate        # full-screen overlay when admin pauses prod
│   ├── TermsOfServiceGate     # ToS click-through
│   └── UserNotificationPopup  # admin-pushed messages
└── lib/
    ├── api.ts                 # fetch helpers + retry + auth
    ├── analytics.ts           # PostHog wrapper
    ├── sentry.ts              # lazy Sentry import
    ├── themes.ts              # theme registry
    ├── tos-content.ts         # versioned ToS prose
    ├── lab-fields.ts          # Synthesis Lab field specs
    ├── workspace-placeholders.ts
    ├── types/                 # shared cross-page types (Paper, WorkflowItem)
    ├── supabase/              # supabase-js wrappers (client + admin)
    ├── stores/                # zustand stores (theme, prefs, guest quota)
    └── hooks/                 # custom hooks (useUsage, useAnnouncements …)
```

## Verification

```bash
npm run lint        # ESLint
npx tsc --noEmit    # TypeScript type-check (no JS emitted)
npm test            # Vitest — covers stores + hooks
```

The backend has no test suite yet; smoke-test API contracts via curl or
the admin dashboard's "API health" panel.

## Deployment

- **Frontend** — Vercel auto-deploys from `main`. The build is just
  `npm run build`; no special config required beyond the
  `NEXT_PUBLIC_*` env vars in the Vercel project settings.
- **Backend** — Railway. `Procfile` declares the uvicorn entry point.
  Environment variables live in the Railway service config; mirror the
  full list from `.env.example`.

## Working on this codebase

This is an alpha product under active iteration. A few file-level rules
that aren't obvious from the code:

- Read [`AGENTS.md`](AGENTS.md) before touching the Next.js internals —
  the project pins a customised Next.js 16 build whose APIs differ from
  the upstream docs in places.
- The desktop entry point ([`src/app/page.tsx`](src/app/page.tsx)) and
  the mobile entry point ([`src/components/mobile/MobileApp.tsx`](src/components/mobile/MobileApp.tsx))
  are both intentionally large monoliths today. A future refactor will
  split them into hooks + region components; in the meantime, keep edits
  local to the section you're working in.
- `EVIDENCE_CHAIN_ENABLED` (in `src/app/page.tsx`) is a deliberate kill
  switch for the Evidence Chain feature. Flip to `true` to re-enable;
  no other code changes required.

## Reporting issues

Use the in-app feedback button (bottom-right "🐛"), or email
`jy1529098645@gmail.com` with the request reference shown on the error
screen — every backend response includes an `X-Request-Id` header that
can be quoted for cross-service tracing.
