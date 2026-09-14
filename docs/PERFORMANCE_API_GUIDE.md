# Performance Module — API Guide (Frontend Flow)

Easy reference for every Performance API, written in the same order the frontend uses them.

**Base URL:** `/api/v1/performance`  
**Auth:** `Authorization: Bearer <accessToken>`  
**Content-Type:** `application/json` (for POST / PATCH / PUT with body)

---

## Common response envelope

Every endpoint returns:

```json
{
  "error": false,
  "message": "Success message here.",
  "data": { }
}
```

On failure:

```json
{
  "error": true,
  "message": "Reason for failure.",
  "data": null
}
```

List endpoints usually include pagination:

```json
"pagination": {
  "page": 1,
  "limit": 10,
  "total_items": 25,
  "total": 25,
  "total_pages": 3,
  "has_next_page": true,
  "has_prev_page": false
}
```

Query params used on most lists: `page`, `limit`, `search`, `status`, `no_pagination=true`.

---

## Important ID rules (read once)

| Place | Field to send | Example | Where it comes from |
|-------|---------------|---------|---------------------|
| Add Participants overrides | `competency_id` | `7`, `6`, `4` | Participant Preview → `template.items` |
| Competency weights / ratings / submit | row `id` | `25`, `26`, `27` | Get Participant Detail → `competencies` / `goals` |
| Get / rate / submit participant routes | `participantId` | `9` | List Participants → `participants[].id` (**not** `employee_id`) |
| Create PIP | `participant_id` | `9` | Same participant `id` |

Frontend Goals / Templates UIs look like one form, but they call **two or more APIs** in sequence. The sections below show that real call order.

---

# 1. Competencies

**Frontend page:** `/performance/competencies`  
**Permission module:** `performance_competencies`

Used to create the skill/behavior catalog that later goes into templates.

---

### 1.1 Create Competency

Creates one competency for the company.

- **Method / Endpoint:** `POST /competencies`
- **Permission:** `add`
- **Request body:**

```json
{
  "name": "Communication",
  "description": "Ability to communicate clearly",
  "status": "active"
}
```

- **Success response (`201`):**

```json
{
  "error": false,
  "message": "Competency created successfully.",
  "data": {
    "competency": {
      "id": 7,
      "company_id": 87,
      "name": "Communication",
      "description": "Ability to communicate clearly",
      "status": "active",
      "created_at": "2026-07-29T11:00:00.000Z",
      "updated_at": "2026-07-29T11:00:00.000Z"
    }
  }
}
```

---

### 1.2 List Competencies

Loads the competencies table (search + pagination).

- **Method / Endpoint:** `GET /competencies?page=1&limit=10&search=&status=active`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competencies retrieved successfully.",
  "data": {
    "competencies": [
      {
        "id": 7,
        "company_id": 87,
        "name": "Communication",
        "description": "Ability to communicate clearly",
        "status": "active",
        "created_at": "2026-07-29T11:00:00.000Z",
        "updated_at": "2026-07-29T11:00:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1, "total_pages": 1 }
  }
}
```

---

### 1.3 Get Competency By Id

Opens one competency for view/edit.

- **Method / Endpoint:** `GET /competencies/:id`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency retrieved successfully.",
  "data": {
    "competency": {
      "id": 7,
      "company_id": 87,
      "name": "Communication",
      "description": "Ability to communicate clearly",
      "status": "active",
      "created_at": "2026-07-29T11:00:00.000Z",
      "updated_at": "2026-07-29T11:00:00.000Z"
    }
  }
}
```

---

### 1.4 Update Competency

Edits name/description/status (also used by the status badge dropdown).

- **Method / Endpoint:** `PATCH /competencies/:id`
- **Permission:** `edit`
- **Request body:**

```json
{
  "name": "Communication",
  "description": "Updated description",
  "status": "inactive"
}
```

- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency updated successfully.",
  "data": {
    "competency": { "id": 7, "name": "Communication", "status": "inactive" }
  }
}
```

---

### 1.5 Delete Competency

Removes a competency (fails if still used by a template).

- **Method / Endpoint:** `DELETE /competencies/:id`
- **Permission:** `delete`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency deleted successfully.",
  "data": { "deleted": true, "id": 7 }
}
```

---

# 2. Competency Templates

**Frontend page:** `/performance/templates`  
**Permission module:** `performance_templates`

Frontend save order:

1. Create / update template metadata  
2. Replace items (competencies + weightages totaling 100)  
3. Sync assignments (delete removed, create new scopes)

---

### 2.1 Create Template

Creates an empty template shell.

- **Method / Endpoint:** `POST /competency-templates`
- **Permission:** `add`
- **Request body:**

```json
{
  "name": "Standard Template",
  "description": "Default competency template",
  "status": "active"
}
```

- **Success response (`201`):**

```json
{
  "error": false,
  "message": "Competency template created successfully.",
  "data": {
    "template": {
      "id": 9,
      "company_id": 87,
      "name": "Standard Template",
      "description": "Default competency template",
      "status": "active",
      "created_at": "2026-07-29T11:00:00.000Z",
      "updated_at": "2026-07-29T11:00:00.000Z"
    }
  }
}
```

---

### 2.2 List Templates

- **Method / Endpoint:** `GET /competency-templates?page=1&limit=10&search=&status=active`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency templates retrieved successfully.",
  "data": {
    "templates": [ { "id": 9, "name": "Standard Template", "status": "active" } ],
    "pagination": { "page": 1, "limit": 10, "total": 1 }
  }
}
```

---

### 2.3 Get Template By Id

Returns template + items + assignments (used when opening edit / manage).

- **Method / Endpoint:** `GET /competency-templates/:id`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency template retrieved successfully.",
  "data": {
    "template": { "id": 9, "name": "Standard Template", "status": "active" },
    "items": [
      { "id": 1, "template_id": 9, "competency_id": 7, "competency_name": "Dressing-update", "weightage": 20 },
      { "id": 2, "template_id": 9, "competency_id": 6, "competency_name": "Regularity", "weightage": 60 },
      { "id": 3, "template_id": 9, "competency_id": 4, "competency_name": "Attendance updated", "weightage": 20 }
    ],
    "assignments": [
      { "id": 1, "template_id": 9, "scope_type": "company", "department_id": null, "designation_id": null, "employee_id": null }
    ]
  }
}
```

---

### 2.4 Update Template

Updates name / description / status only.

- **Method / Endpoint:** `PATCH /competency-templates/:id`
- **Permission:** `edit`
- **Request body:**

```json
{
  "name": "Standard Template",
  "description": "Updated description",
  "status": "active"
}
```

- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency template updated successfully.",
  "data": { "template": { "id": 9, "name": "Standard Template", "status": "active" } }
}
```

---

### 2.5 Replace Template Items

Replaces the full competency set. Weightages **must total exactly 100**.

- **Method / Endpoint:** `PUT /competency-templates/:id/items`
- **Permission:** `edit`
- **Request body:**

```json
{
  "items": [
    { "competency_id": 7, "weightage": 20 },
    { "competency_id": 6, "weightage": 60 },
    { "competency_id": 4, "weightage": 20 }
  ]
}
```

- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Template items updated successfully.",
  "data": {
    "items": [
      { "id": 1, "template_id": 9, "competency_id": 7, "competency_name": "Dressing-update", "weightage": 20 }
    ]
  }
}
```

---

### 2.6 Create Template Assignment

Assigns the template to company / department / designation / one employee.

- **Method / Endpoint:** `POST /competency-templates/:id/assignments`
- **Permission:** `edit`
- **Request body examples:**

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
{ "scope_type": "employee", "employee_id": 413 }
```

- **Success response (`201`):**

```json
{
  "error": false,
  "message": "Template assigned successfully.",
  "data": {
    "assignment": {
      "id": 1,
      "template_id": 9,
      "scope_type": "company",
      "department_id": null,
      "designation_id": null,
      "employee_id": null
    }
  }
}
```

---

### 2.7 Delete Template Assignment

- **Method / Endpoint:** `DELETE /competency-templates/:id/assignments/:assignmentId`
- **Permission:** `edit`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Template assignment deleted successfully.",
  "data": { "deleted": true, "id": 1 }
}
```

---

### 2.8 Delete Template

- **Method / Endpoint:** `DELETE /competency-templates/:id`
- **Permission:** `delete`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Competency template deleted successfully.",
  "data": { "deleted": true, "id": 9 }
}
```

---

# 3. Goals

**Frontend page:** `/performance/goals`  
**Permission module:** `performance_goals`

Frontend save order (one modal, two APIs):

1. `POST /goals` or `PATCH /goals/:id` (goal fields only — **no employees**)  
2. `POST /goals/:id/assignments` (and DELETE for removed assignees)

---

### 3.1 Create Goal

Creates the goal definition only. Does **not** assign employees.

- **Method / Endpoint:** `POST /goals`
- **Permission:** `add`
- **Request body:**

```json
{
  "title": "Improve delivery quality",
  "description": "Reduce production bugs",
  "frequency": "quarterly",
  "start_date": "2026-07-01",
  "end_date": "2026-09-30",
  "default_weightage": 20,
  "status": "active"
}
```

`frequency`: `monthly` | `semi_monthly` | `quarterly` | `annually`

- **Success response (`201`):**

```json
{
  "error": false,
  "message": "Goal created successfully.",
  "data": {
    "goal": {
      "id": 17,
      "company_id": 87,
      "title": "Improve delivery quality",
      "description": "Reduce production bugs",
      "frequency": "quarterly",
      "start_date": "2026-07-01",
      "end_date": "2026-09-30",
      "default_weightage": 20,
      "status": "active",
      "created_at": "2026-07-29T11:00:00.000Z",
      "updated_at": "2026-07-29T11:00:00.000Z"
    }
  }
}
```

---

### 3.2 Assign Goal To Employees

Second step after create/update. Upserts by employee. Per-employee goal weightages cannot exceed 100% total across all goals.

- **Method / Endpoint:** `POST /goals/:id/assignments`
- **Permission:** `edit`
- **Request body (frontend style):**

```json
{
  "employee_ids": [413, 414],
  "weightage": 20
}
```

Also supported: `department_id` and/or `designation_id` for bulk assign.

- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goal assigned successfully.",
  "data": {
    "assignments": [
      {
        "id": 5,
        "goal_id": 17,
        "employee_id": 413,
        "employee_name": "employee four",
        "employee_email": "employee4@gmail.com",
        "weightage": 20
      }
    ]
  }
}
```

---

### 3.3 List Goals

- **Method / Endpoint:** `GET /goals?page=1&limit=10&search=&status=active`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goals retrieved successfully.",
  "data": {
    "goals": [ { "id": 17, "title": "Improve delivery quality", "status": "active" } ],
    "pagination": { "page": 1, "limit": 10, "total": 1 }
  }
}
```

---

### 3.4 Get Goal By Id

Includes current assignments (frontend uses this when opening edit).

- **Method / Endpoint:** `GET /goals/:id`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goal retrieved successfully.",
  "data": {
    "goal": { "id": 17, "title": "Improve delivery quality", "default_weightage": 20 },
    "assignments": [
      {
        "id": 5,
        "goal_id": 17,
        "employee_id": 413,
        "employee_name": "employee four",
        "employee_email": "employee4@gmail.com",
        "weightage": 20
      }
    ]
  }
}
```

---

### 3.5 Update Goal

Updates goal fields only. Frontend then re-syncs assignments separately.

- **Method / Endpoint:** `PATCH /goals/:id`
- **Permission:** `edit`
- **Request body:** same fields as Create Goal.
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goal updated successfully.",
  "data": { "goal": { "id": 17, "title": "Improve delivery quality" } }
}
```

---

### 3.6 Delete Goal Assignment

Used when an employee is unchecked in the edit modal.

- **Method / Endpoint:** `DELETE /goals/:id/assignments/:assignmentId`
- **Permission:** `edit`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goal assignment deleted successfully.",
  "data": { "deleted": true, "id": 5 }
}
```

---

### 3.7 Delete Goal

- **Method / Endpoint:** `DELETE /goals/:id`
- **Permission:** `delete`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goal deleted successfully.",
  "data": { "deleted": true, "id": 17 }
}
```

---

### 3.8 Employee Goal Summary (Admin preview)

Used in the Goals modal when previewing an employee’s current weightage total.

- **Method / Endpoint:** `GET /goals/employee/:employeeId/summary?exclude_goal_id=`
- **Permission:** `view`
- **Optional query:** `exclude_goal_id` — pass the goal being edited so it is not double-counted.
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Employee goal summary retrieved successfully.",
  "data": {
    "employee": { "id": 413, "name": "employee four", "email": "employee4@gmail.com" },
    "goals": [
      { "goal_id": 17, "title": "Improve delivery quality", "weightage": 20 }
    ],
    "total": 20
  }
}
```

---

### 3.9 Get My Goals (Employee)

Employee self-service list of assigned goals.

- **Method / Endpoint:** `GET /goals/me`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Goals retrieved successfully.",
  "data": {
    "goals": [
      {
        "goal_id": 17,
        "title": "Improve delivery quality",
        "weightage": 20,
        "frequency": "quarterly"
      }
    ]
  }
}
```

---

# 4. Appraisal Cycles

**Frontend page:** `/performance/appraisals`  
**Permission module:** `performance_appraisals`

Typical frontend flow:

1. Create cycle  
2. Preview employee (goals + template)  
3. Add participants  
4. (Optional) override competency weights  
5. Save draft ratings  
6. Submit  
7. Summary / dismiss PIP / create PIP

---

### 4.1 Create Appraisal Cycle

- **Method / Endpoint:** `POST /appraisal-cycles`
- **Permission:** `add`
- **Request body:**

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

`cycle_type`: `monthly` | `semi_monthly` | `yearly` | `quarterly` | `custom`  
`goal_contribution` + `competency_contribution` must equal **100**.

- **Success response (`201`):**

```json
{
  "error": false,
  "message": "Appraisal cycle created successfully.",
  "data": {
    "cycle": {
      "id": 21,
      "name": "July appraisal",
      "cycle_type": "monthly",
      "goal_contribution": 50,
      "competency_contribution": 50,
      "status": "draft"
    }
  }
}
```

---

### 4.2 List Appraisal Cycles

- **Method / Endpoint:** `GET /appraisal-cycles?page=1&limit=10&search=`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Appraisal cycles retrieved successfully.",
  "data": {
    "cycles": [ { "id": 21, "name": "July appraisal", "status": "active" } ],
    "pagination": { "page": 1, "limit": 10, "total": 1 }
  }
}
```

---

### 4.3 Get Appraisal Cycle By Id

- **Method / Endpoint:** `GET /appraisal-cycles/:id`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Appraisal cycle retrieved successfully.",
  "data": { "cycle": { "id": 21, "name": "July appraisal", "status": "active" } }
}
```

---

### 4.4 Update Appraisal Cycle

Also used for inline status badge (`draft` / `active` / `closed`). Closed cycles cannot be edited.

- **Method / Endpoint:** `PATCH /appraisal-cycles/:id`
- **Permission:** `edit`
- **Request body:** same fields as create (send only what you change, or full object as frontend does).
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Appraisal cycle updated successfully.",
  "data": { "cycle": { "id": 21, "status": "active" } }
}
```

---

### 4.5 Delete Appraisal Cycle

Closed cycles cannot be deleted.

- **Method / Endpoint:** `DELETE /appraisal-cycles/:id`
- **Permission:** `delete`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Appraisal cycle deleted successfully.",
  "data": { "deleted": true, "id": 21 }
}
```

---

### 4.6 Participant Preview (before adding)

Call this **before** Add Participants to see the employee’s goals and resolved template competencies.

- **Method / Endpoint:** `GET /appraisal-cycles/participant-preview/:employeeId`
- **Permission:** `view`
- **Note:** `:employeeId` is the **employee** id (e.g. `413`), not participant id.
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Participant preview retrieved successfully.",
  "data": {
    "employee": { "id": 413, "name": "employee four", "email": "employee4@gmail.com" },
    "goals": [
      { "goal_id": 17, "title": "Improve delivery quality", "weightage": 100 }
    ],
    "goals_total": 100,
    "template": {
      "template_id": 9,
      "template_name": "Standard Template",
      "items": [
        { "competency_id": 7, "name": "Dressing-update", "weightage": 20 },
        { "competency_id": 6, "name": "Regularity", "weightage": 60 },
        { "competency_id": 4, "name": "Attendance updated", "weightage": 20 }
      ],
      "total": 100
    },
    "ready": true,
    "errors": []
  }
}
```

Use `template.items[].competency_id` in Add Participants overrides.

---

### 4.7 Add Participants

Adds employees to the cycle and snapshots their goals + competencies.  
If cycle is `draft`, it auto-activates to `active`.

- **Method / Endpoint:** `POST /appraisal-cycles/:id/participants`
- **Permission:** `edit`
- **Simple body (recommended — uses template defaults):**

```json
{
  "employee_ids": [413]
}
```

- **With competency weight overrides** (use **competency_id** from preview, not rating-sheet row ids; final weights across all template items must total 100):

```json
{
  "employee_ids": [413],
  "overrides": [
    {
      "employee_id": 413,
      "competencies": [
        { "competency_id": 7, "weightage": 40 },
        { "competency_id": 6, "weightage": 40 }
      ]
    }
  ]
}
```

Also supported:

```json
{ "company": true }
```

```json
{ "department_id": 12 }
```

```json
{ "designation_id": 5 }
```

Employee must already have assigned goals (totaling 100%) and a resolved competency template.

- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Participants added successfully.",
  "data": {
    "participants": [
      { "participant_id": 9, "employee_id": 413 }
    ]
  }
}
```

---

### 4.8 List Participants

- **Method / Endpoint:** `GET /appraisal-cycles/:id/participants?page=1&limit=10&search=`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Participants retrieved successfully.",
  "data": {
    "cycle": { "id": 21, "name": "July appraisal", "status": "active" },
    "participants": [
      {
        "id": 9,
        "cycle_id": 21,
        "employee_id": 413,
        "employee_name": "employee four",
        "employee_email": "employee4@gmail.com",
        "template_id": 9,
        "status": "pending",
        "goal_score": null,
        "competency_score": null,
        "calculated_rating": null,
        "final_rating": null
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1 }
  }
}
```

Use `participants[].id` (here `9`) for all next participant APIs — **not** `employee_id`.

---

### 4.9 Get Participant Detail

Returns the live rating sheets. **This is the API to check actual goal/competency row ids** for weights, draft ratings, and submit.

- **Method / Endpoint:** `GET /appraisal-cycles/:id/participants/:participantId`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Participant appraisal retrieved successfully.",
  "data": {
    "cycle": { "id": 21, "name": "July appraisal" },
    "participant": {
      "id": 9,
      "employee_id": 413,
      "employee_name": "employee four",
      "status": "in_progress"
    },
    "goals": [
      {
        "id": 13,
        "goal_id": 17,
        "goal_title": "Improve delivery quality",
        "weightage": 100,
        "rating": null,
        "achievement_status": null,
        "remarks": null
      }
    ],
    "competencies": [
      {
        "id": 25,
        "competency_id": 7,
        "competency_name": "Dressing-update",
        "default_weightage": 20,
        "weightage": 20,
        "rating": null,
        "remarks": null
      },
      {
        "id": 26,
        "competency_id": 6,
        "competency_name": "Regularity",
        "default_weightage": 60,
        "weightage": 60,
        "rating": null,
        "remarks": null
      },
      {
        "id": 27,
        "competency_id": 4,
        "competency_name": "Attendance updated",
        "default_weightage": 20,
        "weightage": 20,
        "rating": null,
        "remarks": null
      }
    ]
  }
}
```

For ratings/weights/submit: send `goals[].id` and `competencies[].id` (25, 26, 27) — **not** `competency_id`.

---

### 4.10 Override Competency Weights

Changes weightages on an existing participant sheet.  
Send **all** rows; weightages must total 100. Uses rating-sheet row `id`.

- **Method / Endpoint:** `PUT /appraisal-cycles/:id/participants/:participantId/competency-weights`
- **Permission:** `edit`
- **Request body:**

```json
{
  "items": [
    { "id": 25, "weightage": 40 },
    { "id": 26, "weightage": 40 },
    { "id": 27, "weightage": 20 }
  ]
}
```

- **Success response (`200`):** same shape as Get Participant Detail  
  Message: `Competency weightages updated successfully.`

Cannot change weights after status is `submitted`.

---

### 4.11 Save Ratings (Draft)

Saves partial or full ratings. Does **not** require every row to be rated.

- **Method / Endpoint:** `PATCH /appraisal-cycles/:id/participants/:participantId/ratings`
- **Permission:** `edit`
- **Request body:**

```json
{
  "goals": [
    { "id": 13, "rating": 3.5, "achievement_status": "On track", "remarks": "Good progress" }
  ],
  "competencies": [
    { "id": 25, "rating": 4, "remarks": "Strong communication" }
  ],
  "overall_remarks": "Solid quarter overall.",
  "strengths": "Communication, ownership.",
  "areas_for_improvement": "Time management."
}
```

Ratings: `1`–`5` (0.5 steps).

- **Success response (`200`):** participant detail with saved values  
  Message: `Ratings saved successfully.`

---

### 4.12 Submit Appraisal

Finalizes the appraisal. **Every goal and every competency must have a rating** (null ratings cause 400).

- **Method / Endpoint:** `POST /appraisal-cycles/:id/participants/:participantId/submit`
- **Permission:** `edit`
- **Request body:**

```json
{
  "goals": [
    { "id": 13, "rating": 3.5, "achievement_status": "On track", "remarks": "Good progress" }
  ],
  "competencies": [
    { "id": 25, "rating": 4, "remarks": "Strong" },
    { "id": 26, "rating": 3.5, "remarks": "Regular" },
    { "id": 27, "rating": 4, "remarks": "Punctual" }
  ],
  "overall_remarks": "Solid quarter overall.",
  "strengths": "Ownership.",
  "areas_for_improvement": "Time management.",
  "final_rating": 4
}
```

`final_rating` is optional. If omitted, calculated weighted score is used.  
If final rating ≤ 2, participant status becomes `pip_suggested`.

- **Success response (`200`):**  
  Message: `Appraisal submitted successfully.`  
  Data: updated participant detail with scores / status.

- **Common error:**

```json
{
  "error": true,
  "message": "Please rate all competencies before submitting.",
  "data": null
}
```

---

### 4.13 Get Participant Summary

Read-only summary after submission.

- **Method / Endpoint:** `GET /appraisal-cycles/:id/participants/:participantId/summary`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Performance summary retrieved successfully.",
  "data": {
    "employee": { "name": "employee four", "email": "employee4@gmail.com" },
    "cycle": { "id": 21, "name": "July appraisal" },
    "goal_score": 3.5,
    "competency_score": 3.8,
    "calculated_rating": 3.65,
    "final_rating": 3.65,
    "status": "submitted"
  }
}
```

---

### 4.14 Dismiss PIP Suggestion

Only valid when participant status is `pip_suggested`.

- **Method / Endpoint:** `POST /appraisal-cycles/:id/participants/:participantId/dismiss-pip`
- **Permission:** `edit`
- **Request body:** `{}`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "PIP suggestion dismissed successfully.",
  "data": { "participant": { "id": 9, "status": "pip_dismissed" } }
}
```

---

### 4.15 Get My Summaries (Employee)

Employee self-service submitted appraisals.

- **Method / Endpoint:** `GET /summaries/me?page=1&limit=10`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "Performance summaries retrieved successfully.",
  "data": {
    "summaries": [ ],
    "pagination": { "page": 1, "limit": 10, "total": 0 }
  }
}
```

---

# 5. PIP (Performance Improvement Plans)

**Frontend page:** `/performance/pip` (admin), `/employee-performance/pip` (employee)  
**Permission module:** `performance_pip`

Eligible when participant is `pip_suggested`, or submitted with `final_rating ≤ 2`.

---

### 5.1 Create PIP

- **Method / Endpoint:** `POST /pips`
- **Permission:** `add`
- **Request body:**

```json
{
  "participant_id": 9,
  "duration_days": 60,
  "focus_areas": "Improve code quality and communication",
  "check_in_schedule": "Weekly on Monday",
  "progress_notes": "Initial check-in scheduled"
}
```

`participant_id` = List Participants `id` (e.g. `9`), **not** employee id `413`.

Sets participant status to `pip_created`.

- **Success response (`201`):**

```json
{
  "error": false,
  "message": "PIP created successfully.",
  "data": {
    "pip": {
      "id": 3,
      "participant_id": 9,
      "employee_id": 413,
      "employee_name": "employee four",
      "employee_email": "employee4@gmail.com",
      "cycle_id": 21,
      "cycle_name": "July appraisal",
      "duration_days": 60,
      "status": "active",
      "final_rating": 1.65
    }
  }
}
```

---

### 5.2 List PIPs

- **Method / Endpoint:** `GET /pips?page=1&limit=10&search=&status=active`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "PIPs retrieved successfully.",
  "data": {
    "pips": [
      {
        "id": 3,
        "participant_id": 9,
        "employee_name": "employee four",
        "cycle_name": "July appraisal",
        "status": "active",
        "final_rating": 1.65
      }
    ],
    "pagination": { "page": 1, "limit": 10, "total": 1 }
  }
}
```

---

### 5.3 Get PIP By Id

- **Method / Endpoint:** `GET /pips/:id`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "PIP retrieved successfully.",
  "data": { "pip": { "id": 3, "status": "active", "focus_areas": "..." } }
}
```

---

### 5.4 Update PIP

- **Method / Endpoint:** `PATCH /pips/:id`
- **Permission:** `edit`
- **Request body:**

```json
{
  "status": "completed",
  "duration_days": 90,
  "focus_areas": "Updated focus areas",
  "check_in_schedule": "Bi-weekly",
  "progress_notes": "Employee showing improvement",
  "final_outcome": "Employee met expectations"
}
```

`status`: `active` | `completed` | `cancelled`

- **Success response (`200`):**

```json
{
  "error": false,
  "message": "PIP updated successfully.",
  "data": { "pip": { "id": 3, "status": "completed" } }
}
```

---

### 5.5 Delete PIP

Hard delete. If participant was `pip_created`, resets them to `pip_suggested`.

- **Method / Endpoint:** `DELETE /pips/:id`
- **Permission:** `delete`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "PIP deleted successfully.",
  "data": { "deleted": true, "id": 3 }
}
```

---

### 5.6 Get My PIPs (Employee)

- **Method / Endpoint:** `GET /pips/me?page=1&limit=10`
- **Permission:** `view`
- **Success response (`200`):**

```json
{
  "error": false,
  "message": "PIPs retrieved successfully.",
  "data": {
    "pips": [ ],
    "pagination": { "page": 1, "limit": 10, "total": 0 }
  }
}
```

---

# 6. Frontend call cheat sheet

| UI action | APIs called (in order) |
|-----------|-------------------------|
| Save Competency | `POST` or `PATCH /competencies` |
| Save Template | `POST/PATCH /competency-templates` → `PUT .../items` → sync `.../assignments` |
| Save Goal + employees | `POST/PATCH /goals` → `POST .../assignments` (+ DELETE removed) |
| Create cycle + add people | `POST /appraisal-cycles` → preview → `POST .../participants` |
| Rate then submit | `GET .../participants/:participantId` → `PATCH .../ratings` → `POST .../submit` (all rows rated) |
| Create PIP from appraisals | use `participant.id` → `POST /pips` |

---

# 7. Participant status values

| Status | Meaning |
|--------|---------|
| `pending` | Added, not rated yet |
| `in_progress` | Draft ratings / weights changed |
| `submitted` | Fully submitted |
| `pip_suggested` | Final rating ≤ 2 |
| `pip_dismissed` | Suggestion dismissed |
| `pip_created` | PIP record exists |

---

# 8. Permissions quick map

| Module key | Used for |
|------------|----------|
| `performance_competencies` | Competencies CRUD |
| `performance_templates` | Templates, items, assignments |
| `performance_goals` | Goals, assignments, `/goals/me` |
| `performance_appraisals` | Cycles, ratings, summaries |
| `performance_pip` | PIP admin + `/pips/me` |

Actions: `view` | `add` | `edit` | `delete`
