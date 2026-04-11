# EduSphere

EduSphere is a role-based student management system with a polished dashboard UI and a Python Flask backend. It supports admin, faculty, and student workflows for managing academic data, communication, and day-to-day campus operations.

## Highlights

- Role-based login for admin, faculty, and student users
- Student and faculty management
- Mentor assignment for students
- Course creation and lecture scheduling
- Marks and attendance management
- Semester report cards
- Announcements and notifications
- Support chat between:
  - student and assigned mentor
  - faculty and admin
- AI chat through a backend API integration
- Dark mode and responsive layout

## Tech Stack

- Frontend: HTML, CSS, JavaScript
- Backend: Python, Flask
- Database: SQLite
- Authentication: Flask session-based auth

## Project Structure

```text
EduSphere/
├─ assets/
│  ├─ css/
│  ├─ images/
│  └─ js/
├─ backend/
│  ├─ app.py
│  ├─ db.py
│  ├─ schema.sql
│  ├─ seed.py
│  ├─ seed_data.py
│  ├─ wsgi.py
│  └─ README.md
├─ database/
├─ EduSphere.html
├─ requirements.txt
├─ render.yaml
└─ README.md
```

## Run Locally

From the project root:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python backend\app.py
```

Then open:

```text
http://127.0.0.1:5000/
```

## Optional Environment Variables

Create a `.env` file in the project root if needed:

```env
GEMINI_API_KEY=your_gemini_api_key_here
EDUSPHERE_SECRET_KEY=change_this_for_production
EDUSPHERE_ADMIN_EMAIL=admin@example.com
EDUSPHERE_ADMIN_PASSWORD=change_this_password
EDUSPHERE_ADMIN_NAME=Admin
EDUSPHERE_ADMIN_PHONE=
```

## Current Capabilities

- Admin can manage students, faculty, courses, subjects, announcements, and reports
- Faculty can manage schedules, assignments, attendance, marks, and mentor chats
- Students can view courses, schedules, announcements, report cards, and mentor support
- Theme preference is persisted locally
- Major dashboard actions are backed by the database

## Deployment Note

This project currently uses SQLite.

That means:

- Local hosting works very well
- Paid Render with a persistent disk can work
- Free Render is not a good long-term fit for SQLite persistence

If you want fully free cloud deployment later, the recommended next step is migrating the database from SQLite to Postgres.

## Included Deployment Files

- `render.yaml`
- `backend/wsgi.py`
- `.gitignore`

## Status

This project is currently in a strong MVP/showcase state:

- real backend
- real persistence
- real dashboard flows
- real internal chat
- responsive UI suitable for demo and portfolio presentation

## Notes

- Do not commit `.env`
- Do not commit your local SQLite database if it contains real data
- AI chat requires a valid Gemini API key
- For full public production use, additional deployment and security hardening is still recommended

