# Performance Management Module — Implementation Guide

**Base API URL:** `/api/v1/performance`  
**Frontend base paths:** `/performance/*` (Company Admin), `/employee-performance/*` (Employee)

This document describes the full Competencies, Templates, Goals, Appraisals, and PIP implementation across backend and frontend.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture & File Map](#2-architecture--file-map)
3. [Permissions & Modules](#3-permissions--modules)
4. [Database Schema](#4-database-schema)
5. [End-to-End Business Flow](#5-end-to-end-business-flow)
6. [Competencies](#6-competencies)
7. [Competency Templates](#7-competency-templates)
8. [Goals](#8-goals)
9. [Appraisals](#9-appraisals)
10. [PIP (Performance Improvement Plans)](#10-pip-performance-improvement-plans)
11. [Frontend Shared Patterns](#11-frontend-shared-patterns)
12. [API Quick Reference](#12-api-quick-reference)
13. [Boot / Schema Notes](#13-boot--schema-notes)

---

## 1. Overview

The Performance module lets a company:

1. Define **competencies** (skills/behaviors to rate).
2. Group them into **templates** with weightages and assign templates by company / department / designation / employee.
3. Create **goals**, assign them to employees with weightages.
4. Run **appraisal cycles**: add participants, rate goals + competencies (1–5), submit, and compute final scores.
5. Open **PIPs** for low final ratings (≤ 2), track progress, and hard-delete when needed.

**Response envelope (all endpoints):**

```json
{
  "error": false,
  "message": "Success",
  "data": { }
}
```

Auth: `Authorization: Bearer <accessToken>`.

---

## 2. Architecture & File Map

### Backend (`hrm-new-stagging-backend`)

| Layer | Path |
|--------|------|
| Mount | `server.js` → `app.use('/api/v1/performance', performanceRoutes)` |
| Routes | `src/routes/performance.routes.js` |
| Controllers | `src/controllers/performance.controller.js` |
| Competencies / Templates | `src/services/performance/competency.service.js` (and related) |
| Goals | `src/services/performance/goal.service.js` |
| Appraisals | `src/services/performance/appraisal.service.js` |
| PIP | `src/services/performance/pip.service.js` |
| Shared helpers | `src/services/performance/performance.helpers.js` |
| Schema bootstrap | `src/db/ensurePerformanceModule.js` (runs on boot) |

### Frontend (`front-end`)

| Area | Path |
|------|------|
| Shared API helper | `src/pages/AdminPages/CompanyAdmin/Performance/performanceApi.js` |
| Competencies | `.../Performance/Competencies/index.jsx` |
| Templates | `.../Performance/Templates/index.jsx` |
| Goals | `.../Performance/Goals/index.jsx` |
| Appraisals | `.../Performance/Appraisals/index.jsx` |
| Admin PIP | `.../Performance/PIP/index.jsx` |
| Employee summaries | `src/pages/AdminPages/Employee/Performance/Summaries/index.jsx` |
| Employee PIP | `src/pages/AdminPages/Employee/Performance/PIP/index.jsx` |
| Star preview | `src/components/StarRating.jsx` |
| Routes | `src/App.jsx` |
| Nav | `src/lib/constants.js` |

`performanceFetch(path, { method, token, body })` calls `${BASE_URL}/v1/performance${path}`.

---

## 3. Permissions & Modules

Seeded in `src/constants/systemModules.seed.js`:

| Module key | Label | Used by |
|------------|--------|---------|
| `performance_competencies` | Competencies | Admin CRUD |
| `performance_templates` | Competency Templates | Admin CRUD + items/assignments |
| `performance_goals` | Goals | Admin CRUD + assignments; employee `GET /goals/me` |
| `performance_appraisals` | Appraisals | Cycles, ratings, summaries |
| `performance_pip` | PIP | Admin CRUD; employee `GET /pips/me` |

Each route uses `protect(moduleKey, action)` where action is `view` | `add` | `edit` | `delete`.

### Frontend routes

**Company Admin**

| Path | Module |
|------|--------|
| `/performance/competencies` | `performance_competencies` |
| `/performance/templates` | `performance_templates` |
| `/performance/goals` | `performance_goals` |
| `/performance/appraisals` | `performance_appraisals` |
| `/performance/pip` | `performance_pip` |

**Employee**

| Path | Module |
|------|--------|
| `/employee-performance/summaries` | `performance_appraisals` |
| `/employee-performance/pip` | `performance_pip` |

---

## 4. Database Schema

Created/updated via `ensurePerformanceModule.js` on server boot.

### Entity relationship (simplified)

```text
companies
  ├── performance_competencies
  ├── performance_competency_templates
  │     ├── performance_competency_template_items → competencies
  │     └── performance_competency_template_assignments
  │           (scope: company | department | designation | employee)
  ├── performance_goals
  │     └── performance_goal_assignments → employees
  ├── performance_appraisal_cycles
  │     └── performance_appraisal_participants → employees
  │           ├── performance_appraisal_goal_ratings (snapshot)
  │           └── performance_appraisal_competency_ratings (snapshot)
  └── performance_pips → participant + employee + cycle
```

### Key tables & constraints

| Table | Notes |
|-------|--------|
| `performance_competencies` | Unique `(company_id, name)`; status `active` / `inactive` |
| `performance_competency_templates` | Unique `(company_id, name)` |
| `performance_competency_template_items` | Weightage 0–100; unique `(template_id, competency_id)`; items should total **100%** |
| `performance_competency_template_assignments` | `scope_type`: `company`, `department`, `designation`, `employee` |
| `performance_goals` | Frequency: `monthly`, `semi_monthly`, `quarterly`, `annually` |
| `performance_goal_assignments` | Unique `(goal_id, employee_id)` |
| `performance_appraisal_cycles` | Types: `monthly`, `semi_monthly`, `yearly`, `quarterly`, `custom`; status `draft` / `active` / `closed`; **goal + competency contribution = 100%** |
| `performance_appraisal_participants` | Status: `pending`, `in_progress`, `submitted`, `pip_suggested`, `pip_created`, `pip_dismissed` |
| `*_goal_ratings` / `*_competency_ratings` | Rating `NUMERIC(4,2)` in **1–5** (half stars supported, e.g. `2.5`) |
| `performance_pips` | Status: `active`, `completed`, `cancelled`; **unique `participant_id`** |

Legacy cycle type aliases (`annual` → `yearly`, `ad_hoc` → `custom`) are normalized in appraisal service updates.

---

## 5. End-to-End Business Flow

```text
1. Create competencies
2. Build template (competencies + weightages = 100%) and assign scope
3. Create goals and assign employees (+ weightage)
4. Create appraisal cycle (draft/active) with goal/competency split = 100%
5. Add participants
     → Resolve template (employee > designation > department > company)
     → Snapshot goals + competencies onto participant rating sheets
     → Draft cycle auto-activates when first participants are added
6. Rate goals & competencies (1–5), save draft, then submit
     → Weighted scores → calculated rating
     → Optional final_rating override
     → If final_rating ≤ 2 → status = pip_suggested
7. Create PIP from participant (or dismiss suggestion)
8. Track / edit / hard-delete PIP
```

### Scoring (submit)

- Goal score = weighted average of goal ratings by goal weightage.
- Competency score = weighted average of competency ratings by competency weightage.
- Calculated rating mixes cycle `goal_contribution` and `competency_contribution`.
- If `final_rating ≤ 2` → participant becomes `pip_suggested`.

### Template resolution precedence

`employee` → `designation` → `department` → `company` (first active match wins).

---

## 6. Competencies

### Backend

| Method | Path | Permission |
|--------|------|------------|
| POST | `/competencies` | add |
| GET | `/competencies` | view |
| GET | `/competencies/:id` | view |
| PATCH | `/competencies/:id` | edit |
| DELETE | `/competencies/:id` | delete |

**Body (create/update):** `{ name, description?, status: 'active'|'inactive' }`

List supports pagination (`page`, `limit`) and `search`.

### Frontend

- Page: search, table, Add/Edit modal, status badge dropdown, delete confirmation.
- Inline status toggle via `PATCH` (same pattern as Goals).

---

## 7. Competency Templates

### Backend

| Method | Path | Permission |
|--------|------|------------|
| POST | `/competency-templates` | add |
| GET | `/competency-templates` | view |
| GET | `/competency-templates/:id` | view |
| PATCH | `/competency-templates/:id` | edit |
| DELETE | `/competency-templates/:id` | delete |
| PUT | `/competency-templates/:id/items` | edit |
| POST | `/competency-templates/:id/assignments` | edit |
| DELETE | `/competency-templates/:id/assignments/:assignmentId` | edit |

**Items:** replace full set; weightages must total **100%**.

**Assignment body examples:**

```json
{ "scope_type": "company" }
```

```json
{ "scope_type": "department", "department_id": 12 }
```

```json
{ "scope_type": "designation", "designation_id": 5 }
```

```json
{ "scope_type": "employee", "employee_id": 88 }
```

### Frontend

- CRUD for template metadata.
- Manage competencies (items) with weightages.
- Manage assignments by scope (company / department / designation / multi-employee).

---

## 8. Goals

### Backend

| Method | Path | Permission |
|--------|------|------------|
| GET | `/goals/me` | view (employee’s assigned goals) |
| POST | `/goals` | add |
| GET | `/goals` | view |
| GET | `/goals/:id` | view (includes `assignments`) |
| PATCH | `/goals/:id` | edit |
| DELETE | `/goals/:id` | delete |
| POST | `/goals/:id/assignments` | edit (upsert by employee) |
| DELETE | `/goals/:id/assignments/:assignmentId` | edit |

**Goal body:**

```json
{
  "title": "Improve delivery quality",
  "description": "...",
  "frequency": "quarterly",
  "start_date": "2026-07-01",
  "end_date": "2026-09-30",
  "default_weightage": 20,
  "status": "active"
}
```

**Frequencies:** `monthly`, `semi_monthly`, `quarterly`, `annually`.

**Assign:**

```json
{
  "employee_ids": [1, 2, 3],
  "weightage": 20
}
```

Assignments return `employee_name` / `employee_email`. Errors prefer name (email) over raw IDs.

### Frontend

- Create/Edit goal + multi-select employee assignment in the same modal.
- Edit loads existing assignees, syncs adds/removes on save.
- View modal shows assignees (name, email, weightage).
- Delete confirmation modal; status badge dropdown.

---

## 9. Appraisals

### Backend — cycles

| Method | Path | Permission |
|--------|------|------------|
| POST | `/appraisal-cycles` | add |
| GET | `/appraisal-cycles` | view |
| GET | `/appraisal-cycles/:id` | view |
| PATCH | `/appraisal-cycles/:id` | edit |
| DELETE | `/appraisal-cycles/:id` | delete |

**Cycle types:** `monthly`, `semi_monthly`, `yearly`, `quarterly`, `custom`  
**Statuses:** `draft`, `active`, `closed` (closed cycles cannot be edited/deleted)

**Create/update body:**

```json
{
  "name": "July appraisal",
  "cycle_type": "monthly",
  "start_date": "2026-07-01",
  "end_date": "2026-07-31",
  "rating_deadline": "2026-08-05",
  "goal_contribution": 50,
  "competency_contribution": 50,
  "status": "draft"
}
```

### Backend — participants & ratings

| Method | Path | Notes |
|--------|------|--------|
| GET | `/appraisal-cycles/participant-preview/:employeeId` | Goals + template competencies before adding |
| POST | `/appraisal-cycles/:id/participants` | Add employees; optional competency weight overrides; auto-activates draft cycle |
| GET | `/appraisal-cycles/:id/participants` | List |
| GET | `/appraisal-cycles/:id/participants/:participantId` | Detail + rating sheets |
| PUT | `.../competency-weights` | Override competency weightages (must total 100%) |
| PATCH | `.../ratings` | Save draft ratings |
| POST | `.../submit` | Submit; may set `pip_suggested` |
| GET | `.../summary` | Submitted summary |
| POST | `.../dismiss-pip` | `pip_suggested` → `pip_dismissed` |
| GET | `/summaries/me` | Employee’s own summaries |

**Add participants:**

```json
{
  "employee_ids": [10, 11],
  "overrides": [
    {
      "employee_id": 10,
      "competencies": [
        { "competency_id": 1, "weightage": 40 },
        { "competency_id": 2, "weightage": 60 }
      ]
    }
  ]
}
```

Also supports `company_wide: true` where implemented.

**Save ratings:**

```json
{
  "goals": [
    { "id": 101, "rating": 3.5, "achievement_status": "On track", "remarks": "..." }
  ],
  "competencies": [
    { "id": 201, "rating": 4, "remarks": "..." }
  ],
  "overall_remarks": "...",
  "strengths": "...",
  "areas_for_improvement": "..."
}
```

**Submit** may include `final_rating` override (1–5).

### Frontend

- Cycle list: search, pagination, inline **status badge** (`draft` / `active` / `closed`) via `PATCH` (does not create a new row).
- Add/Edit cycle modal: DatePickers, contribution split, optional multi-employee participants at create.
- Selecting an employee opens **Employee Details** preview (goals + editable competency weights totaling 100%).
- Participants modal: add employees / entire company, Rate / Summary / Create PIP / Dismiss PIP.
- Rate modal: number inputs (1–5, step 0.5) with **yellow star preview** below each rating field (`StarRating` read-only).
- View cycle details modal.

---

## 10. PIP (Performance Improvement Plans)

### Eligibility

Shown/createable when appraisal participant is:

- `pip_suggested`, or
- `submitted` with `final_rating ≤ 2`

(Frontend filters the Add PIP employee list the same way.)

### Backend

| Method | Path | Permission |
|--------|------|------------|
| GET | `/pips/me` | view (employee) |
| POST | `/pips` | add |
| GET | `/pips` | view |
| GET | `/pips/:id` | view |
| PATCH | `/pips/:id` | edit |
| DELETE | `/pips/:id` | delete (hard delete) |

**Create:**

```json
{
  "participant_id": 55,
  "duration_days": 60,
  "focus_areas": "...",
  "check_in_schedule": "Weekly Monday",
  "progress_notes": "..."
}
```

Creates/upserts PIP (`UNIQUE participant_id`) and sets participant status to `pip_created`.

**Update:**

```json
{
  "status": "completed",
  "duration_days": 90,
  "focus_areas": "...",
  "check_in_schedule": "...",
  "progress_notes": "...",
  "final_outcome": "..."
}
```

**Hard delete:** removes PIP row; if participant was `pip_created`, resets to `pip_suggested` so a new PIP can be created.

List includes `employee_name`, `employee_email`, `cycle_name`, `final_rating`.

### Frontend (Admin)

- Table aligned with Goals/Competencies UI (search, badges, pagination).
- Add PIP: pick appraisal cycle → multi-select eligible employees → chips list → create one PIP per selected participant.
- Deep link from Appraisals: `/performance/pip?participant_id=<id>` pre-selects that participant.
- View / Edit modals (centered, max-height 90vh, scrollable body).
- Delete confirmation (hard delete).

### Frontend (Employee)

- Read-only list of own PIPs + View details modal.

---

## 11. Frontend Shared Patterns

### Table / CRUD UX

Used across Competencies, Goals, Appraisals, PIP:

- `min-w-0 space-y-4` page shell (no extra page `h1` in list headers).
- Search input (`w-72`) + primary **Add** button.
- Table with `scrollbar-thin-dark`, shared `TABLE_*` classes from `performanceApi.js`.
- Pagination: “Show N entries” + “Showing X to Y of Z” + Previous / page / Next.
- `StatusBadgeDropdown` for status where applicable.
- View / Edit / Delete row actions; delete uses `AlertTriangle` confirm modal.

### Ratings UI

- Keep numeric `Input` (`min=1`, `max=5`, `step=0.5`).
- Below it, read-only `StarRating` preview:
  - `3` → 3 yellow filled + 2 empty
  - `2.5` → 2 full + 1 half filled + 2 empty

### Auth selector

```js
const { accessToken } = useSelector((state) => state.auth);
```

### Employees list (admin pickers)

```http
GET /v1/employees?no_pagination=true&status=active
```

---

## 12. API Quick Reference

All paths under `/api/v1/performance`.

### Competencies
`POST/GET /competencies` · `GET/PATCH/DELETE /competencies/:id`

### Templates
`POST/GET /competency-templates` · `GET/PATCH/DELETE /competency-templates/:id`  
`PUT /competency-templates/:id/items`  
`POST /competency-templates/:id/assignments` · `DELETE .../assignments/:assignmentId`

### Goals
`GET /goals/me` · `POST/GET /goals` · `GET/PATCH/DELETE /goals/:id`  
`POST /goals/:id/assignments` · `DELETE /goals/:id/assignments/:assignmentId`

### Appraisals
`GET /summaries/me`  
`POST/GET /appraisal-cycles` · `GET/PATCH/DELETE /appraisal-cycles/:id`  
`GET /appraisal-cycles/participant-preview/:employeeId`  
`POST/GET /appraisal-cycles/:id/participants`  
`GET /appraisal-cycles/:id/participants/:participantId`  
`PUT .../competency-weights` · `PATCH .../ratings` · `POST .../submit`  
`GET .../summary` · `POST .../dismiss-pip`

### PIP
`GET /pips/me` · `POST/GET /pips` · `GET/PATCH/DELETE /pips/:id`

> Literal routes `/goals/me`, `/summaries/me`, `/pips/me`, and `/appraisal-cycles/participant-preview/:employeeId` are registered **before** `/:id` routes.

---

## 13. Boot / Schema Notes

1. On server start, `ensurePerformanceModuleSchema()` applies additive SQL and idempotent constraint updates (goal frequencies, appraisal cycle types).
2. After pulling schema/service changes, **restart the backend**.
3. Roles need the corresponding Performance module permissions (`view` / `add` / `edit` / `delete`).
4. Template items and per-participant competency overrides must total **100%** weightage.
5. Cycle goal + competency contributions must total **100%**.
6. PIP eligibility is tied to appraisal final rating ≤ 2 / `pip_suggested`.

---

## Related UI components

| Component | Role |
|-----------|------|
| `StatusBadgeDropdown` | Status chips; `variant="appraisal_cycle"` for draft/active/closed |
| `StarRating` | Yellow star preview for 1–5 (half-star) ratings |
| `DatePicker` | Cycle/goal dates |
| `TableRowActionIcons` | View / Edit / Delete / Participants actions |

---

*Last updated to match the Competencies · Templates · Goals · Appraisals · PIP implementation in this repository.*
