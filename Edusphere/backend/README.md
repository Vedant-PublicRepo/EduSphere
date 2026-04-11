# EduSphere Python Backend

This backend uses:

- Python
- Flask
- SQLite
- the built-in `sqlite3` module

## Files

- `app.py`: Flask entry point and API routes
- `db.py`: SQLite connection and schema initialization
- `schema.sql`: database tables
- `seed.py`: inserts demo data into SQLite
- `seed_data.py`: Python version of the current frontend demo dataset

## Setup

From the project root:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python backend\seed.py
.venv\Scripts\python backend\app.py
```

Then open:

- `http://127.0.0.1:5000/`

## Render Deployment

This app can be deployed to Render as a Python web service.

Important:

- Because this project uses SQLite, it needs a persistent disk.
- Render free web services do not support persistent disks.
- That means this exact SQLite setup requires a paid Render web service plan.

Files already added for deployment:

- `render.yaml`
- `backend/wsgi.py`
- `.gitignore`

Environment variables you should set in Render:

- `EDUSPHERE_SECRET_KEY`
- `EDUSPHERE_ADMIN_EMAIL`
- `EDUSPHERE_ADMIN_PASSWORD`
- `EDUSPHERE_ADMIN_NAME`
- `EDUSPHERE_ADMIN_PHONE` (optional)
- `GEMINI_API_KEY` (optional if you want AI chat)
- `DATABASE_PATH` should stay `/var/data/edusphere.db`

How it works:

- Render mounts a persistent disk at `/var/data`
- SQLite is stored at `/var/data/edusphere.db`
- On first boot, if no admin exists, the app creates one from:
  - `EDUSPHERE_ADMIN_EMAIL`
  - `EDUSPHERE_ADMIN_PASSWORD`
  - `EDUSPHERE_ADMIN_NAME`
  - `EDUSPHERE_ADMIN_PHONE`

Recommended deploy steps:

1. Push this project to GitHub.
2. In Render, create a new Blueprint or Web Service from that repo.
3. Use the settings from `render.yaml`.
4. Make sure the service has a persistent disk mounted.
5. Add the environment variables listed above.
6. Deploy.
7. Log in with the admin email/password you provided in Render.

## Current API

- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/bootstrap`

## Next frontend migration steps

1. Replace browser-side login in `assets/js/edusphere.js` with `POST /api/auth/login`.
2. Replace the hardcoded `const db = { ... }` with async loading from `GET /api/bootstrap`.
3. Add CRUD routes for students, faculty, courses, announcements, marks, attendance, and report cards.
4. Add session or token auth once login is connected.
