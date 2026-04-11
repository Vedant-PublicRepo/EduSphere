from __future__ import annotations

import os
import re
import secrets
import time
from json import dumps, loads
from datetime import timedelta
from functools import wraps
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix

from db import IntegrityError, get_connection, init_db


PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_local_env():
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_local_env()

app = Flask(
    __name__,
    static_folder=str(PROJECT_ROOT / "assets"),
    static_url_path="/assets",
)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.config["SECRET_KEY"] = os.environ.get("EDUSPHERE_SECRET_KEY", "dev-change-this-secret")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("EDUSPHERE_FORCE_SECURE_COOKIE", "0") == "1"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(
    minutes=int(os.environ.get("EDUSPHERE_SESSION_TIMEOUT_MINUTES", "480"))
)
UNASSIGNED_FACULTY_ID = "ADMIN1"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^[0-9+\-\s()]{7,20}$")
GEMINI_MODEL = "gemini-2.5-flash"
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_LOCK_SECONDS = 10 * 60
LOGIN_MAX_ATTEMPTS = 5
FAILED_LOGIN_ATTEMPTS: dict[str, list[float]] = {}


def row_to_dict(row):
    return dict(row) if row else None


def clean_text(value, *, field_name: str, min_len: int = 1, max_len: int = 120):
    text = str(value or "").strip()
    if len(text) < min_len:
        raise ValueError(f"{field_name} is required")
    if len(text) > max_len:
        raise ValueError(f"{field_name} is too long")
    return text


def normalize_email(value: str) -> str:
    email = str(value or "").strip().lower()
    if not EMAIL_RE.match(email):
        raise ValueError("Enter a valid email address")
    return email


def normalize_phone(value: str) -> str:
    phone = str(value or "").strip()
    if not PHONE_RE.match(phone):
        raise ValueError("Enter a valid phone number")
    return phone


def validate_password(value: str) -> str:
    password = str(value or "")
    if len(password.strip()) < 8:
        raise ValueError("Password must be at least 8 characters")
    if len(password) > 128:
        raise ValueError("Password is too long")
    return password.strip()


def get_client_ip() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.remote_addr or "unknown"


def get_csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def is_csrf_exempt() -> bool:
    return request.method in {"GET", "HEAD", "OPTIONS"} or not request.path.startswith("/api/")


def login_rate_limit_key(identifier: str) -> str:
    return f"{get_client_ip()}::{identifier.lower().strip()}"


def get_login_retry_after(key: str) -> int:
    now = time.time()
    attempts = [stamp for stamp in FAILED_LOGIN_ATTEMPTS.get(key, []) if now - stamp < LOGIN_WINDOW_SECONDS]
    FAILED_LOGIN_ATTEMPTS[key] = attempts
    if len(attempts) < LOGIN_MAX_ATTEMPTS:
        return 0
    oldest_relevant = attempts[-LOGIN_MAX_ATTEMPTS]
    retry_after = int(LOGIN_LOCK_SECONDS - (now - oldest_relevant))
    return max(retry_after, 0)


def record_failed_login(key: str) -> None:
    now = time.time()
    attempts = [stamp for stamp in FAILED_LOGIN_ATTEMPTS.get(key, []) if now - stamp < LOGIN_WINDOW_SECONDS]
    attempts.append(now)
    FAILED_LOGIN_ATTEMPTS[key] = attempts


def clear_failed_login(key: str) -> None:
    FAILED_LOGIN_ATTEMPTS.pop(key, None)


def ensure_initial_admin() -> None:
    email = os.environ.get("EDUSPHERE_ADMIN_EMAIL", "").strip().lower()
    password = os.environ.get("EDUSPHERE_ADMIN_PASSWORD", "").strip()
    name = os.environ.get("EDUSPHERE_ADMIN_NAME", "Admin").strip() or "Admin"
    phone = os.environ.get("EDUSPHERE_ADMIN_PHONE", "").strip()
    if not email or not password:
        return

    with get_connection() as conn:
        existing_admin = conn.execute(
            "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
        ).fetchone()
        if existing_admin:
            return
        conn.execute(
            """
            INSERT INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
            VALUES (?, 'admin', ?, ?, ?, ?, ?, 1)
            """,
            (
                "ADMIN1",
                email,
                generate_password_hash(password),
                name,
                email,
                phone,
            ),
        )
        conn.commit()


def ensure_email_available(conn, email: str, *, exclude_user_id: str | None = None):
    if exclude_user_id is None:
        row = conn.execute(
            """
            SELECT id
            FROM users
            WHERE lower(email) = lower(?)
            LIMIT 1
            """,
            (email,),
        ).fetchone()
    else:
        row = conn.execute(
            """
            SELECT id
            FROM users
            WHERE lower(email) = lower(?)
              AND id != ?
            LIMIT 1
            """,
            (email, exclude_user_id),
        ).fetchone()
    if row:
        raise ValueError("That email is already in use")


def ensure_faculty_exists(conn, faculty_id: str | None):
    if not faculty_id:
        return None
    row = conn.execute(
        "SELECT id FROM users WHERE id = ? AND role = 'faculty'",
        (faculty_id,),
    ).fetchone()
    if not row:
        raise ValueError("Selected mentor was not found")
    return faculty_id


def ensure_course_available(conn, name: str, faculty_id: str):
    row = conn.execute(
        """
        SELECT id
        FROM courses
        WHERE lower(name) = lower(?) AND faculty_id = ?
        LIMIT 1
        """,
        (name, faculty_id),
    ).fetchone()
    if row:
        raise ValueError("That course already exists for the selected faculty")


def ai_system_prompt(user):
    role = user["role"].capitalize()
    return (
        "You are EduSphere AI, a concise educational assistant inside a student management portal. "
        "Give safe, practical academic help, study guidance, simple explanations, and structured answers. "
        "Do not claim to perform actions in the portal, do not invent grades or records, and do not reveal secrets. "
        f"The current user role is {role}. Tailor examples to that role when useful."
    )


def generate_ai_reply(user, prompt: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not configured on the backend")

    endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
        f"?key={api_key}"
    )
    body = {
        "system_instruction": {
            "parts": [{"text": ai_system_prompt(user)}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {
            "temperature": 0.6,
            "maxOutputTokens": 500,
        },
    }
    request_obj = Request(
        endpoint,
        data=dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request_obj, timeout=30) as response:
            payload = loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"AI request failed: {detail or error.reason}") from error
    except URLError as error:
        raise RuntimeError("Unable to reach the AI service") from error

    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("AI service returned no response")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "\n".join(part.get("text", "").strip() for part in parts if part.get("text", "").strip()).strip()
    if not text:
        raise RuntimeError("AI service returned an empty response")
    return text


def get_user_by_credentials(role: str, username: str):
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT id, role, username, password_hash, full_name, email, phone, is_active
            FROM users
            WHERE role = ? AND (username = ? OR email = ?)
            """,
            (role, username, username),
        ).fetchone()


def get_user_by_login_identifier(username: str):
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT id, role, username, password_hash, full_name, email, phone, is_active
            FROM users
            WHERE username = ? OR email = ?
            LIMIT 1
            """,
            (username, username),
        ).fetchone()


def next_prefixed_id(rows, prefix: str, start: int) -> str:
    max_num = start - 1
    for row in rows:
        match = re.search(rf"{re.escape(prefix)}(\d+)$", row["id"])
        if match:
            max_num = max(max_num, int(match.group(1)))
    return f"{prefix}{max_num + 1}"


def next_username(rows, prefix: str, start: int = 1) -> str:
    max_num = start - 1
    for row in rows:
        match = re.search(rf"{re.escape(prefix)}(\d+)$", row["username"])
        if match:
            max_num = max(max_num, int(match.group(1)))
    return f"{prefix}{max_num + 1}"


def load_attendance_sessions(conn):
    sessions = {}
    rows = conn.execute(
        """
        SELECT course_id, session_date, student_id, present
        FROM attendance_sessions
        ORDER BY course_id, session_date, student_id
        """
    ).fetchall()
    for row in rows:
        key = f"{row['course_id']}_{row['session_date']}"
        sessions.setdefault(key, {})[row["student_id"]] = bool(row["present"])
    return sessions


def get_user_by_id(user_id: str):
    with get_connection() as conn:
        return conn.execute(
            """
            SELECT id, role, username, password_hash, full_name, email, phone, is_active
            FROM users
            WHERE id = ?
            """,
            (user_id,),
        ).fetchone()


def build_user_response(user):
    if not user:
        return None

    response = {
        "id": user["id"],
        "role": user["role"],
        "username": user["username"],
        "name": user["full_name"],
        "email": user["email"],
        "phone": user["phone"],
        "isActive": bool(user["is_active"]),
    }

    with get_connection() as conn:
        if user["role"] == "faculty":
            faculty = conn.execute(
                """
                SELECT department, bio
                FROM faculty_profiles
                WHERE user_id = ?
                """,
                (user["id"],),
            ).fetchone()
            if faculty:
                response.update(row_to_dict(faculty))
        elif user["role"] == "student":
            student = conn.execute(
                """
                SELECT course, year, gender, status, mentor_id AS facultyId, dob, address
                FROM student_profiles
                WHERE user_id = ?
                """,
                (user["id"],),
            ).fetchone()
            if student:
                response.update(row_to_dict(student))

    return response


def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return get_user_by_id(user_id)


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return jsonify({"error": "Authentication required"}), 401
        request.current_user = user
        return view(*args, **kwargs)

    return wrapped


def require_roles(*roles):
    def decorator(view):
        @wraps(view)
        @require_auth
        def wrapped(*args, **kwargs):
            user = request.current_user
            if user["role"] not in roles:
                return jsonify({"error": "Forbidden"}), 403
            return view(*args, **kwargs)

        return wrapped

    return decorator


@app.before_request
def apply_request_security():
    get_csrf_token()
    if session.get("user_id"):
        session.permanent = True
        session.modified = True
    if is_csrf_exempt():
        return None
    header_token = request.headers.get("X-CSRF-Token", "")
    if not header_token or header_token != session.get("csrf_token"):
        return jsonify({"error": "CSRF validation failed"}), 403
    return None


@app.after_request
def apply_response_security(response):
    response.headers["X-CSRF-Token"] = get_csrf_token()
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: https:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "object-src 'none'; "
        "upgrade-insecure-requests"
    )
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


def bootstrap_for_user(user, payload):
    role = user["role"]
    if role == "admin":
        return payload

    if role == "faculty":
        own_courses = [course for course in payload["courses"] if course["facultyId"] == user["id"]]
        course_ids = {course["id"] for course in own_courses}
        student_ids = set()
        for course in own_courses:
            student_ids.update(course["students"])
        student_ids.update(
            student["id"] for student in payload["students"] if student.get("facultyId") == user["id"]
        )
        filtered_students = [student for student in payload["students"] if student["id"] in student_ids]
        filtered_faculty = [faculty for faculty in payload["faculty"] if faculty["id"] == user["id"]]
        filtered_marks = {
            student_id: {
                course_id: marks
                for course_id, marks in courses.items()
                if course_id in course_ids
            }
            for student_id, courses in payload["marks"].items()
            if student_id in student_ids
        }
        filtered_marks = {k: v for k, v in filtered_marks.items() if v}
        filtered_attendance = {
            student_id: {
                course_id: value
                for course_id, value in courses.items()
                if course_id in course_ids
            }
            for student_id, courses in payload["attendance"].items()
            if student_id in student_ids
        }
        filtered_attendance = {k: v for k, v in filtered_attendance.items() if v}
        filtered_assignments = [
            assignment for assignment in payload["assignments"] if assignment["courseId"] in course_ids
        ]
        filtered_report_cards = {
            student_id: cards
            for student_id, cards in payload["reportCards"].items()
            if student_id in student_ids
        }
        filtered_attendance_sessions = {
            key: session_data
            for key, session_data in payload["attendanceSessions"].items()
            if key.split("_", 1)[0] in course_ids
        }
        filtered_lecture_status = {
            key: value
            for key, value in payload["lectureStatus"].items()
            if key.split("_", 2)[1] in course_ids
        }
        return {
            "admin": None,
            "faculty": filtered_faculty,
            "students": filtered_students,
            "courses": own_courses,
            "subjects": payload["subjects"],
            "marks": filtered_marks,
            "attendance": filtered_attendance,
            "announcements": payload["announcements"],
            "notifications": [],
            "assignments": filtered_assignments,
            "reportCards": filtered_report_cards,
            "attendanceSessions": filtered_attendance_sessions,
            "lectureStatus": filtered_lecture_status,
        }

    student_id = user["id"]
    own_student = next((student for student in payload["students"] if student["id"] == student_id), None)
    own_courses = [course for course in payload["courses"] if student_id in course["students"]]
    course_ids = {course["id"] for course in own_courses}
    faculty_ids = {course["facultyId"] for course in payload["courses"]}
    if own_student and own_student.get("facultyId"):
        faculty_ids.add(own_student["facultyId"])
    filtered_notifications = []
    for notification in payload["notifications"]:
        filtered_notification = {**notification}
        filtered_notification["readBy"] = [sid for sid in notification.get("readBy", []) if sid == student_id]
        filtered_notifications.append(filtered_notification)
    filtered_lecture_status = {
        key: value
        for key, value in payload["lectureStatus"].items()
        if key.startswith(f"{student_id}_")
    }
    return {
        "admin": None,
        "faculty": [faculty for faculty in payload["faculty"] if faculty["id"] in faculty_ids],
        "students": [own_student] if own_student else [],
        "courses": payload["courses"],
        "subjects": payload["subjects"],
        "marks": {student_id: payload["marks"].get(student_id, {})},
        "attendance": {student_id: payload["attendance"].get(student_id, {})},
        "announcements": payload["announcements"],
        "notifications": filtered_notifications,
        "assignments": [assignment for assignment in payload["assignments"] if assignment["courseId"] in course_ids],
        "reportCards": {student_id: payload["reportCards"].get(student_id, [])},
        "attendanceSessions": {},
        "lectureStatus": filtered_lecture_status,
    }


def is_faculty_assigned_to_student(conn, faculty_id: str, student_id: str) -> bool:
    mentor_match = conn.execute(
        """
        SELECT 1
        FROM student_profiles
        WHERE user_id = ? AND mentor_id = ?
        """,
        (student_id, faculty_id),
    ).fetchone()
    if mentor_match:
        return True

    course_match = conn.execute(
        """
        SELECT 1
        FROM courses c
        JOIN course_enrollments ce ON ce.course_id = c.id
        WHERE c.faculty_id = ? AND ce.student_id = ?
        LIMIT 1
        """,
        (faculty_id, student_id),
    ).fetchone()
    return bool(course_match)


def support_counterpart_for_student(conn, student_id: str):
    mentor = conn.execute(
        """
        SELECT u.id, u.full_name AS name, u.email, u.phone, fp.department
        FROM student_profiles sp
        JOIN users u ON u.id = sp.mentor_id
        LEFT JOIN faculty_profiles fp ON fp.user_id = u.id
        WHERE sp.user_id = ?
        """,
        (student_id,),
    ).fetchone()
    return dict(mentor) if mentor else None


def support_messages_for_pair(conn, student_id: str, faculty_id: str):
    rows = conn.execute(
        """
        SELECT sm.id, sm.student_id, sm.faculty_id, sm.sender_id, sm.body, sm.created_at,
               u.role AS sender_role, u.full_name AS sender_name
        FROM support_messages sm
        JOIN users u ON u.id = sm.sender_id
        WHERE sm.student_id = ? AND sm.faculty_id = ?
        ORDER BY sm.created_at ASC, sm.id ASC
        """,
        (student_id, faculty_id),
    ).fetchall()
    return [dict(row) for row in rows]


def admin_profile(conn):
    admin = conn.execute(
        """
        SELECT id, full_name AS name, email, phone
        FROM users
        WHERE role = 'admin'
        ORDER BY id
        LIMIT 1
        """
    ).fetchone()
    return dict(admin) if admin else None


def admin_faculty_messages(conn, faculty_id: str):
    rows = conn.execute(
        """
        SELECT afm.id, afm.faculty_id, afm.sender_id, afm.body, afm.created_at,
               u.role AS sender_role, u.full_name AS sender_name
        FROM admin_faculty_messages afm
        JOIN users u ON u.id = afm.sender_id
        WHERE afm.faculty_id = ?
        ORDER BY afm.created_at ASC, afm.id ASC
        """,
        (faculty_id,),
    ).fetchall()
    return [dict(row) for row in rows]


def mark_support_thread_read(conn, user_id: str, student_id: str, faculty_id: str):
    latest = conn.execute(
        """
        SELECT id
        FROM support_messages
        WHERE student_id = ? AND faculty_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (student_id, faculty_id),
    ).fetchone()
    if not latest:
        return
    conn.execute(
        """
        INSERT INTO support_thread_reads (user_id, student_id, faculty_id, last_read_message_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, student_id, faculty_id)
        DO UPDATE SET last_read_message_id = excluded.last_read_message_id
        """,
        (user_id, student_id, faculty_id, latest["id"]),
    )


def mark_admin_faculty_thread_read(conn, user_id: str, faculty_id: str):
    latest = conn.execute(
        """
        SELECT id
        FROM admin_faculty_messages
        WHERE faculty_id = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (faculty_id,),
    ).fetchone()
    if not latest:
        return
    conn.execute(
        """
        INSERT INTO admin_faculty_thread_reads (user_id, faculty_id, last_read_message_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, faculty_id)
        DO UPDATE SET last_read_message_id = excluded.last_read_message_id
        """,
        (user_id, faculty_id, latest["id"]),
    )


def support_summary_for_user(conn, user):
    role = user["role"]
    if role == "student":
        counterpart = support_counterpart_for_student(conn, user["id"])
        if not counterpart:
            return {"mentor": [], "admin": [], "totalUnread": 0}
        last_read = conn.execute(
            """
            SELECT last_read_message_id
            FROM support_thread_reads
            WHERE user_id = ? AND student_id = ? AND faculty_id = ?
            """,
            (user["id"], user["id"], counterpart["id"]),
        ).fetchone()
        last_read_id = last_read["last_read_message_id"] if last_read and last_read["last_read_message_id"] else 0
        latest = conn.execute(
            """
            SELECT sm.id, sm.body, sm.created_at, sm.sender_id, u.full_name AS sender_name
            FROM support_messages sm
            JOIN users u ON u.id = sm.sender_id
            WHERE sm.student_id = ? AND sm.faculty_id = ?
            ORDER BY sm.id DESC
            LIMIT 1
            """,
            (user["id"], counterpart["id"]),
        ).fetchone()
        unread = conn.execute(
            """
            SELECT COUNT(*)
            FROM support_messages
            WHERE student_id = ? AND faculty_id = ? AND sender_id != ? AND id > ?
            """,
            (user["id"], counterpart["id"], user["id"], last_read_id),
        ).fetchone()[0]
        return {
            "mentor": [
                {
                    "id": counterpart["id"],
                    "name": counterpart["name"],
                    "unread": unread,
                    "lastMessage": dict(latest) if latest else None,
                }
            ],
            "admin": [],
            "totalUnread": unread,
        }

    if role == "faculty":
        mentor_rows = conn.execute(
            """
            SELECT u.id, u.full_name AS name, sp.course, sp.year,
                   r.last_read_message_id
            FROM users u
            JOIN student_profiles sp ON sp.user_id = u.id
            LEFT JOIN support_thread_reads r
              ON r.user_id = ? AND r.student_id = u.id AND r.faculty_id = ?
            WHERE sp.mentor_id = ?
            ORDER BY u.full_name
            """,
            (user["id"], user["id"], user["id"]),
        ).fetchall()
        mentor_summary = []
        total_unread = 0
        for row in mentor_rows:
            last_read_id = row["last_read_message_id"] or 0
            latest = conn.execute(
                """
                SELECT sm.id, sm.body, sm.created_at, sm.sender_id, u.full_name AS sender_name
                FROM support_messages sm
                JOIN users u ON u.id = sm.sender_id
                WHERE sm.student_id = ? AND sm.faculty_id = ?
                ORDER BY sm.id DESC
                LIMIT 1
                """,
                (row["id"], user["id"]),
            ).fetchone()
            unread = conn.execute(
                """
                SELECT COUNT(*)
                FROM support_messages
                WHERE student_id = ? AND faculty_id = ? AND sender_id != ? AND id > ?
                """,
                (row["id"], user["id"], user["id"], last_read_id),
            ).fetchone()[0]
            total_unread += unread
            mentor_summary.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "course": row["course"],
                    "year": row["year"],
                    "unread": unread,
                    "lastMessage": dict(latest) if latest else None,
                }
            )

        admin = admin_profile(conn)
        admin_summary = []
        if admin:
            last_read = conn.execute(
                """
                SELECT last_read_message_id
                FROM admin_faculty_thread_reads
                WHERE user_id = ? AND faculty_id = ?
                """,
                (user["id"], user["id"]),
            ).fetchone()
            last_read_id = last_read["last_read_message_id"] if last_read and last_read["last_read_message_id"] else 0
            latest = conn.execute(
                """
                SELECT afm.id, afm.body, afm.created_at, afm.sender_id, u.full_name AS sender_name
                FROM admin_faculty_messages afm
                JOIN users u ON u.id = afm.sender_id
                WHERE afm.faculty_id = ?
                ORDER BY afm.id DESC
                LIMIT 1
                """,
                (user["id"],),
            ).fetchone()
            unread = conn.execute(
                """
                SELECT COUNT(*)
                FROM admin_faculty_messages
                WHERE faculty_id = ? AND sender_id != ? AND id > ?
                """,
                (user["id"], user["id"], last_read_id),
            ).fetchone()[0]
            total_unread += unread
            admin_summary.append(
                {
                    "id": admin["id"],
                    "name": admin["name"],
                    "unread": unread,
                    "lastMessage": dict(latest) if latest else None,
                }
            )

        return {"mentor": mentor_summary, "admin": admin_summary, "totalUnread": total_unread}

    if role == "admin":
        rows = conn.execute(
            """
            SELECT u.id, u.full_name AS name, fp.department, r.last_read_message_id
            FROM users u
            LEFT JOIN faculty_profiles fp ON fp.user_id = u.id
            LEFT JOIN admin_faculty_thread_reads r
              ON r.user_id = ? AND r.faculty_id = u.id
            WHERE u.role = 'faculty'
            ORDER BY u.full_name
            """,
            (user["id"],),
        ).fetchall()
        items = []
        total_unread = 0
        for row in rows:
            last_read_id = row["last_read_message_id"] or 0
            latest = conn.execute(
                """
                SELECT afm.id, afm.body, afm.created_at, afm.sender_id, u.full_name AS sender_name
                FROM admin_faculty_messages afm
                JOIN users u ON u.id = afm.sender_id
                WHERE afm.faculty_id = ?
                ORDER BY afm.id DESC
                LIMIT 1
                """,
                (row["id"],),
            ).fetchone()
            unread = conn.execute(
                """
                SELECT COUNT(*)
                FROM admin_faculty_messages
                WHERE faculty_id = ? AND sender_id != ? AND id > ?
                """,
                (row["id"], user["id"], last_read_id),
            ).fetchone()[0]
            total_unread += unread
            items.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "department": row["department"],
                    "unread": unread,
                    "lastMessage": dict(latest) if latest else None,
                }
            )
        return {"mentor": [], "admin": items, "totalUnread": total_unread}

    return {"mentor": [], "admin": [], "totalUnread": 0}


@app.get("/")
def index():
    return send_from_directory(PROJECT_ROOT, "EduSphere.html")


@app.get("/robots.txt")
def robots():
    return app.response_class("User-agent: *\nDisallow:\n", mimetype="text/plain")


@app.get("/.well-known/security.txt")
def security_txt():
    contact_email = os.environ.get("EDUSPHERE_SECURITY_CONTACT", os.environ.get("EDUSPHERE_ADMIN_EMAIL", "security@example.com"))
    body = f"Contact: mailto:{contact_email}\nExpires: 2027-04-11T23:59:59Z\nPreferred-Languages: en\n"
    return app.response_class(body, mimetype="text/plain")


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": "EduSphere Python backend"})


@app.post("/api/auth/login")
def login():
    payload = request.get_json(silent=True) or {}
    username = payload.get("username", "").strip()
    password = payload.get("password", "").strip()

    if not username or not password:
        return jsonify({"ok": False, "error": "Email and password are required"}), 400

    limit_key = login_rate_limit_key(username)
    retry_after = get_login_retry_after(limit_key)
    if retry_after > 0:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": f"Too many login attempts. Try again in {retry_after} seconds.",
                }
            ),
            429,
        )

    user = get_user_by_login_identifier(username)
    if not user or not check_password_hash(user["password_hash"], password):
        record_failed_login(limit_key)
        return jsonify({"ok": False, "error": "Invalid credentials"})

    session.clear()
    clear_failed_login(limit_key)
    session.permanent = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    session["user_id"] = user["id"]
    session["role"] = user["role"]
    return jsonify({"ok": True, "user": build_user_response(user)})


@app.get("/api/auth/session")
def auth_session():
    user = current_user()
    return jsonify({"ok": bool(user), "user": build_user_response(user) if user else None})


@app.post("/api/auth/logout")
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/bootstrap")
@require_auth
def bootstrap():
    with get_connection() as conn:
        admin = conn.execute(
            """
            SELECT id, username, full_name AS name, email, phone
            FROM users
            WHERE role = 'admin'
            LIMIT 1
            """
        ).fetchone()
        faculty = [
            dict(row)
            for row in conn.execute(
                """
                SELECT u.id, u.username, u.full_name AS name, u.email, u.phone, fp.department, fp.bio
                FROM users u
                JOIN faculty_profiles fp ON fp.user_id = u.id
                WHERE u.role = 'faculty'
                ORDER BY u.id
                """
            ).fetchall()
        ]
        students = [
            dict(row)
            for row in conn.execute(
                """
                SELECT u.id, u.username, u.full_name AS name, u.email, u.phone,
                       sp.course, sp.year, sp.gender, sp.status, sp.mentor_id AS facultyId, sp.dob, sp.address
                FROM users u
                JOIN student_profiles sp ON sp.user_id = u.id
                WHERE u.role = 'student'
                ORDER BY u.id
                """
            ).fetchall()
        ]

        courses = []
        course_rows = conn.execute(
            """
            SELECT id, name, faculty_id AS facultyId
            FROM courses
            ORDER BY id
            """
        ).fetchall()
        for course in course_rows:
            course_dict = dict(course)
            course_dict["students"] = [
                row["student_id"]
                for row in conn.execute(
                    """
                    SELECT student_id
                    FROM course_enrollments
                    WHERE course_id = ?
                    ORDER BY student_id
                    """,
                    (course["id"],),
                ).fetchall()
            ]
            course_dict["schedule"] = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT id, title, day, slot
                    FROM course_lectures
                    WHERE course_id = ?
                    ORDER BY id
                    """,
                    (course["id"],),
                ).fetchall()
            ]
            courses.append(course_dict)

        subjects = [
            row["name"]
            for row in conn.execute("SELECT name FROM subjects ORDER BY id").fetchall()
        ]

        marks = {}
        for row in conn.execute("SELECT student_id, course_id, marks FROM marks").fetchall():
            marks.setdefault(row["student_id"], {})[row["course_id"]] = row["marks"]

        attendance = {}
        for row in conn.execute(
            "SELECT student_id, course_id, attendance_percent FROM attendance_summary"
        ).fetchall():
            attendance.setdefault(row["student_id"], {})[row["course_id"]] = row["attendance_percent"]

        announcements = [
            dict(row)
            for row in conn.execute(
                """
                SELECT id, title, body, priority, date,
                       created_by_role AS createdByRole,
                       created_by_user_id AS createdByUserId,
                       created_by_name AS createdByName
                FROM announcements
                ORDER BY date DESC
                """
            ).fetchall()
        ]

        notifications = []
        notification_rows = conn.execute(
            """
            SELECT id, title, body, priority, date
            FROM notifications
            ORDER BY date DESC
            """
        ).fetchall()
        for notification in notification_rows:
            notification_dict = dict(notification)
            notification_dict["readBy"] = [
                row["student_id"]
                for row in conn.execute(
                    """
                    SELECT student_id
                    FROM notification_reads
                    WHERE notification_id = ?
                    ORDER BY student_id
                    """,
                    (notification["id"],),
                ).fetchall()
            ]
            notifications.append(notification_dict)

        assignments = [
            {
                **dict(row),
                "courseId": row["courseId"],
                "submissionDate": row["submissionDate"],
                "createdByUserId": row["createdByUserId"],
                "createdByName": row["createdByName"],
            }
            for row in conn.execute(
                """
                SELECT id, course_id AS courseId, topic, details,
                       submission_date AS submissionDate,
                       created_by_user_id AS createdByUserId,
                       created_by_name AS createdByName
                FROM assignments
                ORDER BY submission_date ASC
                """
            ).fetchall()
        ]

        report_cards = {}
        report_card_rows = conn.execute(
            """
            SELECT id, student_id AS studentId, semester, published_on AS publishedOn, remarks
            FROM report_cards
            ORDER BY published_on DESC
            """
        ).fetchall()
        for card in report_card_rows:
            student_cards = report_cards.setdefault(card["studentId"], [])
            entries = [
                {
                    "course": row["course_name"],
                    "marks": row["marks"],
                }
                for row in conn.execute(
                    """
                    SELECT course_name, marks
                    FROM report_card_entries
                    WHERE report_card_id = ?
                    ORDER BY id
                    """,
                    (card["id"],),
                ).fetchall()
            ]
            student_cards.append(
                {
                    "id": card["id"],
                    "semester": card["semester"],
                    "publishedOn": card["publishedOn"],
                    "remarks": card["remarks"],
                    "entries": entries,
                }
            )
        attendance_sessions = load_attendance_sessions(conn)
        lecture_status = {}
        for row in conn.execute(
            """
            SELECT student_id, course_id, lecture_id, seen
            FROM lecture_status
            """
        ).fetchall():
            key = f"{row['student_id']}_{row['course_id']}_{row['lecture_id']}"
            lecture_status[key] = bool(row["seen"])

    payload = {
        "admin": dict(admin) if admin else None,
        "faculty": faculty,
        "students": students,
        "courses": courses,
        "subjects": subjects,
        "marks": marks,
        "attendance": attendance,
        "announcements": announcements,
        "notifications": notifications,
        "assignments": assignments,
        "reportCards": report_cards,
        "attendanceSessions": attendance_sessions,
        "lectureStatus": lecture_status,
    }

    return jsonify(bootstrap_for_user(request.current_user, payload))


@app.post("/api/students")
@require_roles("admin")
def create_student():
    payload = request.get_json(silent=True) or {}

    with get_connection() as conn:
        try:
            name = clean_text(payload.get("name"), field_name="Full name", max_len=120)
            email = normalize_email(payload.get("email"))
            phone = normalize_phone(payload.get("phone"))
            password = validate_password(payload.get("password"))
            course = clean_text(payload.get("course"), field_name="Course", max_len=80)
            year = clean_text(payload.get("year"), field_name="Year", max_len=40)
            gender = clean_text(payload.get("gender"), field_name="Gender", max_len=20)
            status = clean_text(payload.get("status", "Active"), field_name="Status", max_len=20)
            if status not in {"Active", "Inactive"}:
                raise ValueError("Invalid student status")
            ensure_email_available(conn, email)
            existing = conn.execute(
                "SELECT id, username FROM users WHERE role = 'student' ORDER BY id"
            ).fetchall()
            faculty = conn.execute(
                "SELECT id FROM users WHERE role = 'faculty' ORDER BY id LIMIT 1"
            ).fetchone()
            student_id = next_prefixed_id(existing, "S", 101)
            username = email
            mentor_id = ensure_faculty_exists(
                conn,
                payload.get("facultyId") or (faculty["id"] if faculty else None),
            )
        except ValueError as error:
            return jsonify({"error": str(error)}), 400

        conn.execute(
            """
            INSERT INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
            VALUES (?, 'student', ?, ?, ?, ?, ?, ?)
            """,
            (
                student_id,
                username,
                generate_password_hash(password),
                name,
                email,
                phone,
                1 if status == "Active" else 0,
            ),
        )
        conn.execute(
            """
            INSERT INTO student_profiles
            (user_id, course, year, gender, status, mentor_id, dob, address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                student_id,
                course,
                year,
                gender,
                status,
                mentor_id,
                payload.get("dob", "2002-01-01"),
                payload.get("address", ""),
            ),
        )
        conn.commit()

    return jsonify({"id": student_id, "username": username}), 201


@app.put("/api/students/<student_id>")
@require_auth
def update_student(student_id: str):
    payload = request.get_json(silent=True) or {}
    user = request.current_user
    if user["role"] not in {"admin", "student"}:
        return jsonify({"error": "Forbidden"}), 403
    if user["role"] == "student" and user["id"] != student_id:
        return jsonify({"error": "Forbidden"}), 403

    with get_connection() as conn:
        existing = conn.execute(
            """
            SELECT u.id
            FROM users u
            JOIN student_profiles sp ON sp.user_id = u.id
            WHERE u.id = ? AND u.role = 'student'
            """,
            (student_id,),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Student not found"}), 404

        if user["role"] == "admin":
            try:
                name = clean_text(payload.get("name"), field_name="Full name", max_len=120)
                email = normalize_email(payload.get("email"))
                phone = normalize_phone(payload.get("phone"))
                course = clean_text(payload.get("course"), field_name="Course", max_len=80)
                year = clean_text(payload.get("year"), field_name="Year", max_len=40)
                gender = clean_text(payload.get("gender"), field_name="Gender", max_len=20)
                status = clean_text(payload.get("status", "Active"), field_name="Status", max_len=20)
                if status not in {"Active", "Inactive"}:
                    raise ValueError("Invalid student status")
                ensure_email_available(conn, email, exclude_user_id=student_id)
                mentor_id = ensure_faculty_exists(conn, payload.get("facultyId"))
                password = str(payload.get("password", "")).strip()
                if password:
                    password = validate_password(password)
            except ValueError as error:
                return jsonify({"error": str(error)}), 400
            if password:
                conn.execute(
                    """
                    UPDATE users
                    SET full_name = ?, username = ?, email = ?, phone = ?, is_active = ?, password_hash = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        email,
                        email,
                        phone,
                        1 if status == "Active" else 0,
                        generate_password_hash(password),
                        student_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    UPDATE users
                    SET full_name = ?, username = ?, email = ?, phone = ?, is_active = ?
                    WHERE id = ?
                    """,
                    (
                        name,
                        email,
                        email,
                        phone,
                        1 if status == "Active" else 0,
                        student_id,
                    ),
                )
            conn.execute(
                """
                UPDATE student_profiles
                SET course = ?, year = ?, gender = ?, status = ?, mentor_id = ?, dob = ?, address = ?
                WHERE user_id = ?
                """,
                (
                    course,
                    year,
                    gender,
                    status,
                    mentor_id,
                    payload.get("dob", "2002-01-01"),
                    payload.get("address", ""),
                    student_id,
                ),
            )
        else:
            try:
                phone = normalize_phone(payload.get("phone"))
                address = str(payload.get("address", "")).strip()
                if len(address) > 255:
                    raise ValueError("Address is too long")
            except ValueError as error:
                return jsonify({"error": str(error)}), 400
            conn.execute(
                """
                UPDATE users
                SET phone = ?
                WHERE id = ?
                """,
                (phone, student_id),
            )
            conn.execute(
                """
                UPDATE student_profiles
                SET address = ?
                WHERE user_id = ?
                """,
                (address, student_id),
            )
        conn.commit()

    return jsonify({"ok": True})


@app.delete("/api/students/<student_id>")
@require_roles("admin")
def delete_student(student_id: str):
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM users WHERE id = ? AND role = 'student'",
            (student_id,),
        )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/faculty")
@require_roles("admin")
def create_faculty():
    payload = request.get_json(silent=True) or {}

    with get_connection() as conn:
        try:
            name = clean_text(payload.get("name"), field_name="Full name", max_len=120)
            email = normalize_email(payload.get("email"))
            phone = normalize_phone(payload.get("phone"))
            department = clean_text(payload.get("department"), field_name="Department", max_len=80)
            bio = str(payload.get("bio", "")).strip()
            if len(bio) > 500:
                raise ValueError("Bio is too long")
            password = validate_password(payload.get("password"))
            ensure_email_available(conn, email)
            existing = conn.execute(
                "SELECT id, username FROM users WHERE role = 'faculty' ORDER BY id"
            ).fetchall()
            faculty_id = next_prefixed_id(existing, "F", 101)
            username = email
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        conn.execute(
            """
            INSERT INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
            VALUES (?, 'faculty', ?, ?, ?, ?, ?, 1)
            """,
            (
                faculty_id,
                username,
                generate_password_hash(password),
                name,
                email,
                phone,
            ),
        )
        conn.execute(
            """
            INSERT INTO faculty_profiles (user_id, department, bio)
            VALUES (?, ?, ?)
            """,
            (
                faculty_id,
                department,
                bio,
            ),
        )
        conn.commit()

    return jsonify({"id": faculty_id, "username": username}), 201


@app.post("/api/admins")
@require_roles("admin")
def create_admin():
    payload = request.get_json(silent=True) or {}

    with get_connection() as conn:
        try:
            name = clean_text(payload.get("name"), field_name="Full name", max_len=120)
            email = normalize_email(payload.get("email"))
            phone = normalize_phone(payload.get("phone"))
            password = validate_password(payload.get("password"))

            ensure_email_available(conn, email)

            existing = conn.execute(
                "SELECT id FROM users WHERE role = 'admin' ORDER BY id"
            ).fetchall()
            admin_id = next_prefixed_id(existing, "ADMIN", 101)
            username = email

        except ValueError as error:
            return jsonify({"error": str(error)}), 400

        conn.execute(
            """
            INSERT INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
            VALUES (?, 'admin', ?, ?, ?, ?, ?, 1)
            """,
            (
                admin_id,
                username,
                generate_password_hash(password),
                name,
                email,
                phone,
            ),
        )
        conn.commit()

    return jsonify({"id": admin_id, "username": username}), 201


@app.put("/api/faculty/<faculty_id>")
@require_auth
def update_faculty(faculty_id: str):
    payload = request.get_json(silent=True) or {}
    user = request.current_user
    if user["role"] not in {"admin", "faculty"}:
        return jsonify({"error": "Forbidden"}), 403
    if user["role"] == "faculty" and user["id"] != faculty_id:
        return jsonify({"error": "Forbidden"}), 403

    with get_connection() as conn:
        existing = conn.execute(
            """
            SELECT u.id
            FROM users u
            JOIN faculty_profiles fp ON fp.user_id = u.id
            WHERE u.id = ? AND u.role = 'faculty'
            """,
            (faculty_id,),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Faculty not found"}), 404

        try:
            name = clean_text(payload.get("name"), field_name="Full name", max_len=120)
            email = normalize_email(payload.get("email"))
            phone = normalize_phone(payload.get("phone"))
            department = clean_text(payload.get("department"), field_name="Department", max_len=80)
            bio = str(payload.get("bio", "")).strip()
            if len(bio) > 500:
                raise ValueError("Bio is too long")
            ensure_email_available(conn, email, exclude_user_id=faculty_id)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400

        conn.execute(
            """
            UPDATE users
            SET full_name = ?, username = ?, email = ?, phone = ?
            WHERE id = ?
            """,
            (
                name,
                email,
                email,
                phone,
                faculty_id,
            ),
        )
        conn.execute(
            """
            UPDATE faculty_profiles
            SET department = ?, bio = ?
            WHERE user_id = ?
            """,
            (
                department,
                bio,
                faculty_id,
            ),
        )
        conn.commit()

    return jsonify({"ok": True})


@app.delete("/api/faculty/<faculty_id>")
@require_roles("admin")
def delete_faculty(faculty_id: str):
    if faculty_id == UNASSIGNED_FACULTY_ID:
        return jsonify({"error": "Cannot delete the default admin user"}), 400

    with get_connection() as conn:
        conn.execute(
            "UPDATE student_profiles SET mentor_id = NULL WHERE mentor_id = ?",
            (faculty_id,),
        )
        conn.execute(
            "UPDATE courses SET faculty_id = ? WHERE faculty_id = ?",
            (UNASSIGNED_FACULTY_ID, faculty_id),
        )
        conn.execute(
            "DELETE FROM users WHERE id = ? AND role = 'faculty'",
            (faculty_id,),
        )
        conn.commit()

    return jsonify({"ok": True})


@app.post("/api/courses")
@require_roles("admin")
def create_course():
    payload = request.get_json(silent=True) or {}
    schedule = payload.get("schedule", [])
    if not isinstance(schedule, list):
        return jsonify({"error": "Schedule must be a list"}), 400

    with get_connection() as conn:
        try:
            name = clean_text(payload.get("name"), field_name="Course name", max_len=100)
            faculty_id = ensure_faculty_exists(conn, str(payload.get("facultyId", "")).strip())
            if not faculty_id:
                raise ValueError("Faculty is required")
            ensure_course_available(conn, name, faculty_id)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        existing = conn.execute("SELECT id FROM courses ORDER BY id").fetchall()
        course_id = next_prefixed_id(existing, "C", 201)
        conn.execute(
            "INSERT INTO courses (id, name, faculty_id) VALUES (?, ?, ?)",
            (course_id, name, faculty_id),
        )
        for index, lecture in enumerate(schedule, start=1):
            conn.execute(
                """
                INSERT INTO course_lectures (id, course_id, title, day, slot)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    f"{course_id}-L{index}",
                    course_id,
                    lecture.get("title", f"Lecture {index}"),
                    lecture.get("day", "Mon"),
                    lecture.get("slot", "9:00 AM"),
                ),
            )
        conn.commit()

    return jsonify({"id": course_id}), 201


@app.post("/api/courses/<course_id>/lectures")
@require_auth
def create_lecture(course_id: str):
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", "")).strip()
    day = str(payload.get("day", "")).strip()
    slot = str(payload.get("slot", "")).strip()
    if not title or not day or not slot:
        return jsonify({"error": "Lecture title, day, and slot are required"}), 400

    with get_connection() as conn:
        course = conn.execute(
            "SELECT faculty_id FROM courses WHERE id = ?",
            (course_id,),
        ).fetchone()
        if not course:
            return jsonify({"error": "Course not found"}), 404
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and course["faculty_id"] != user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        existing = conn.execute(
            "SELECT id FROM course_lectures WHERE course_id = ? ORDER BY id",
            (course_id,),
        ).fetchall()
        lecture_id = f"{course_id}-L{len(existing) + 1}"
        while any(row["id"] == lecture_id for row in existing):
            lecture_id = f"{course_id}-L{len(existing) + 2}"
        conn.execute(
            """
            INSERT INTO course_lectures (id, course_id, title, day, slot)
            VALUES (?, ?, ?, ?, ?)
            """,
            (lecture_id, course_id, title, day, slot),
        )
        conn.commit()

    return jsonify({"id": lecture_id}), 201


@app.put("/api/courses/<course_id>/lectures/<lecture_id>")
@require_auth
def update_lecture(course_id: str, lecture_id: str):
    payload = request.get_json(silent=True) or {}
    with get_connection() as conn:
        course = conn.execute(
            "SELECT faculty_id FROM courses WHERE id = ?",
            (course_id,),
        ).fetchone()
        if not course:
            return jsonify({"error": "Course not found"}), 404
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and course["faculty_id"] != user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        conn.execute(
            """
            UPDATE course_lectures
            SET title = ?, day = ?, slot = ?
            WHERE id = ? AND course_id = ?
            """,
            (
                payload.get("title", "").strip(),
                payload.get("day", "").strip(),
                payload.get("slot", "").strip(),
                lecture_id,
                course_id,
            ),
        )
    return jsonify({"ok": True})


@app.delete("/api/courses/<course_id>/lectures/<lecture_id>")
@require_auth
def delete_lecture(course_id: str, lecture_id: str):
    with get_connection() as conn:
        course = conn.execute(
            "SELECT faculty_id FROM courses WHERE id = ?",
            (course_id,),
        ).fetchone()
        if not course:
            return jsonify({"error": "Course not found"}), 404
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and course["faculty_id"] != user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        conn.execute(
            "DELETE FROM course_lectures WHERE id = ? AND course_id = ?",
            (lecture_id, course_id),
        )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/announcements")
@require_roles("admin", "faculty")
def create_announcement():
    payload = request.get_json(silent=True) or {}
    title = str(payload.get("title", "")).strip()
    body = str(payload.get("body", "")).strip()
    priority = str(payload.get("priority", "")).strip() or "General"
    date = str(payload.get("date", "")).strip()
    user = request.current_user
    if not all([title, body, date]):
        return jsonify({"error": "Missing required announcement fields"}), 400

    with get_connection() as conn:
        existing = conn.execute("SELECT id FROM announcements ORDER BY id").fetchall()
        announcement_id = next_prefixed_id(existing, "A", 1)
        conn.execute(
            """
            INSERT INTO announcements
            (id, title, body, priority, date, created_by_user_id, created_by_role, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                announcement_id,
                title,
                body,
                priority,
                date,
                user["id"],
                user["role"],
                user["full_name"],
            ),
        )
        conn.commit()
    return jsonify({"id": announcement_id}), 201


@app.delete("/api/announcements/<announcement_id>")
@require_auth
def delete_announcement(announcement_id: str):
    with get_connection() as conn:
        announcement = conn.execute(
            """
            SELECT created_by_user_id
            FROM announcements
            WHERE id = ?
            """,
            (announcement_id,),
        ).fetchone()
        if not announcement:
            return jsonify({"error": "Announcement not found"}), 404
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and announcement["created_by_user_id"] != user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        conn.execute("DELETE FROM announcements WHERE id = ?", (announcement_id,))
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/assignments")
@require_auth
def create_assignment():
    payload = request.get_json(silent=True) or {}
    course_id = str(payload.get("courseId", "")).strip()
    topic = str(payload.get("topic", "")).strip()
    details = str(payload.get("details", "")).strip()
    submission_date = str(payload.get("submissionDate", "")).strip()
    user = request.current_user
    if not all([course_id, topic, details, submission_date]):
        return jsonify({"error": "Missing required assignment fields"}), 400

    with get_connection() as conn:
        course = conn.execute(
            "SELECT faculty_id FROM courses WHERE id = ?",
            (course_id,),
        ).fetchone()
        if not course:
            return jsonify({"error": "Course not found"}), 404
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and course["faculty_id"] != user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        existing = conn.execute("SELECT id FROM assignments ORDER BY id").fetchall()
        assignment_id = next_prefixed_id(existing, "AS", 1)
        conn.execute(
            """
            INSERT INTO assignments
            (id, course_id, topic, details, submission_date, created_by_user_id, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                assignment_id,
                course_id,
                topic,
                details,
                submission_date,
                user["id"],
                user["full_name"],
            ),
        )
        conn.commit()
    return jsonify({"id": assignment_id}), 201


@app.delete("/api/assignments/<assignment_id>")
@require_auth
def delete_assignment(assignment_id: str):
    with get_connection() as conn:
        assignment = conn.execute(
            """
            SELECT a.created_by_user_id, c.faculty_id
            FROM assignments a
            JOIN courses c ON c.id = a.course_id
            WHERE a.id = ?
            """,
            (assignment_id,),
        ).fetchone()
        if not assignment:
            return jsonify({"error": "Assignment not found"}), 404
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and assignment["faculty_id"] != user["id"]:
            return jsonify({"error": "Forbidden"}), 403
        conn.execute("DELETE FROM assignments WHERE id = ?", (assignment_id,))
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/marks/bulk")
@require_auth
def save_marks_bulk():
    payload = request.get_json(silent=True) or {}
    entries = payload.get("entries", [])
    if not isinstance(entries, list):
        return jsonify({"error": "entries must be a list"}), 400

    with get_connection() as conn:
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        for entry in entries:
            student_id = str(entry.get("studentId", "")).strip()
            course_id = str(entry.get("courseId", "")).strip()
            marks = entry.get("marks")
            if not student_id or not course_id or marks is None:
                continue
            if user["role"] == "faculty":
                course = conn.execute(
                    "SELECT faculty_id FROM courses WHERE id = ?",
                    (course_id,),
                ).fetchone()
                if not course or course["faculty_id"] != user["id"]:
                    return jsonify({"error": "Forbidden"}), 403
            conn.execute(
                """
                INSERT INTO marks (student_id, course_id, marks)
                VALUES (?, ?, ?)
                ON CONFLICT(student_id, course_id) DO UPDATE SET marks = excluded.marks
                """,
                (student_id, course_id, int(marks)),
            )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/attendance/submit")
@require_auth
def submit_attendance():
    payload = request.get_json(silent=True) or {}
    course_id = str(payload.get("courseId", "")).strip()
    session_date = str(payload.get("date", "")).strip()
    session = payload.get("session", {})
    if not course_id or not session_date or not isinstance(session, dict):
        return jsonify({"error": "courseId, date, and session are required"}), 400

    with get_connection() as conn:
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty":
            course = conn.execute(
                "SELECT faculty_id FROM courses WHERE id = ?",
                (course_id,),
            ).fetchone()
            if not course or course["faculty_id"] != user["id"]:
                return jsonify({"error": "Forbidden"}), 403
        previous_rows = conn.execute(
            """
            SELECT student_id, present
            FROM attendance_sessions
            WHERE course_id = ? AND session_date = ?
            """,
            (course_id, session_date),
        ).fetchall()
        previous_map = {row["student_id"]: bool(row["present"]) for row in previous_rows}
        conn.execute(
            "DELETE FROM attendance_sessions WHERE course_id = ? AND session_date = ?",
            (course_id, session_date),
        )
        for student_id, present in session.items():
            conn.execute(
                """
                INSERT INTO attendance_sessions (course_id, session_date, student_id, present)
                VALUES (?, ?, ?, ?)
                """,
                (course_id, session_date, student_id, 1 if present else 0),
            )

            current = conn.execute(
                """
                SELECT attendance_percent
                FROM attendance_summary
                WHERE student_id = ? AND course_id = ?
                """,
                (student_id, course_id),
            ).fetchone()
            cur = current["attendance_percent"] if current else 80
            old_score = 1 if previous_map.get(student_id) is True else -1 if student_id in previous_map else 0
            new_score = 1 if present else -1
            next_val = max(50, min(100, cur + (new_score - old_score)))
            conn.execute(
                """
                INSERT INTO attendance_summary (student_id, course_id, attendance_percent)
                VALUES (?, ?, ?)
                ON CONFLICT(student_id, course_id) DO UPDATE SET attendance_percent = excluded.attendance_percent
                """,
                (student_id, course_id, next_val),
            )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/report-cards")
@require_auth
def create_report_card():
    payload = request.get_json(silent=True) or {}
    student_id = str(payload.get("studentId", "")).strip()
    semester = str(payload.get("semester", "")).strip()
    published_on = str(payload.get("publishedOn", "")).strip()
    remarks = str(payload.get("remarks", "")).strip()
    entries = payload.get("entries", [])
    if not student_id or not semester or not published_on or not entries:
        return jsonify({"error": "Missing required report card fields"}), 400

    with get_connection() as conn:
        user = request.current_user
        if user["role"] not in {"admin", "faculty"}:
            return jsonify({"error": "Forbidden"}), 403
        if user["role"] == "faculty" and not is_faculty_assigned_to_student(conn, user["id"], student_id):
            return jsonify({"error": "Forbidden"}), 403
        existing = conn.execute("SELECT id FROM report_cards ORDER BY id").fetchall()
        report_card_id = next_prefixed_id(existing, "RC", 1)
        conn.execute(
            """
            INSERT INTO report_cards (id, student_id, semester, published_on, remarks)
            VALUES (?, ?, ?, ?, ?)
            """,
            (report_card_id, student_id, semester, published_on, remarks),
        )
        for entry in entries:
            conn.execute(
                """
                INSERT INTO report_card_entries (report_card_id, course_name, marks)
                VALUES (?, ?, ?)
                """,
                (
                    report_card_id,
                    str(entry.get("course", "")).strip(),
                    int(entry.get("marks")),
                ),
            )
        conn.commit()
    return jsonify({"id": report_card_id}), 201


@app.post("/api/subjects")
@require_roles("admin")
def create_subject():
    payload = request.get_json(silent=True) or {}
    try:
        name = clean_text(payload.get("name"), field_name="Subject name", max_len=80)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    with get_connection() as conn:
        try:
            conn.execute("INSERT INTO subjects (name) VALUES (?)", (name,))
            conn.commit()
        except IntegrityError:
            return jsonify({"error": "That subject already exists"}), 400
    return jsonify({"ok": True}), 201


@app.delete("/api/subjects/<path:name>")
@require_roles("admin")
def delete_subject(name: str):
    with get_connection() as conn:
        conn.execute("DELETE FROM subjects WHERE name = ?", (name,))
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/notifications/<notification_id>/read")
@require_roles("student")
def mark_notification_read(notification_id: str):
    student_id = request.current_user["id"]
    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO notification_reads (notification_id, student_id)
            VALUES (?, ?)
            """,
            (notification_id, student_id),
        )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/courses/<course_id>/enroll")
@require_roles("student")
def enroll_student(course_id: str):
    student_id = request.current_user["id"]
    with get_connection() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO course_enrollments (course_id, student_id)
            VALUES (?, ?)
            """,
            (course_id, student_id),
        )
        conn.commit()
    return jsonify({"ok": True})


@app.post("/api/lecture-status")
@require_roles("student")
def save_lecture_status():
    payload = request.get_json(silent=True) or {}
    student_id = request.current_user["id"]
    course_id = str(payload.get("courseId", "")).strip()
    lecture_id = str(payload.get("lectureId", "")).strip()
    seen = bool(payload.get("seen"))
    if not course_id or not lecture_id:
        return jsonify({"error": "courseId and lectureId are required"}), 400
    with get_connection() as conn:
        enrollment = conn.execute(
            """
            SELECT 1
            FROM course_enrollments
            WHERE course_id = ? AND student_id = ?
            """,
            (course_id, student_id),
        ).fetchone()
        if not enrollment:
            return jsonify({"error": "Forbidden"}), 403
        conn.execute(
            """
            INSERT INTO lecture_status (student_id, course_id, lecture_id, seen)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(student_id, course_id, lecture_id)
            DO UPDATE SET seen = excluded.seen
            """,
            (student_id, course_id, lecture_id, 1 if seen else 0),
        )
        conn.commit()
    return jsonify({"ok": True})


@app.get("/api/support/messages")
@require_auth
def get_support_messages():
    user = request.current_user
    with get_connection() as conn:
        if user["role"] == "student":
            counterpart = support_counterpart_for_student(conn, user["id"])
            if not counterpart:
                return jsonify({"counterpart": None, "messages": []})
            messages = support_messages_for_pair(conn, user["id"], counterpart["id"])
            mark_support_thread_read(conn, user["id"], user["id"], counterpart["id"])
            conn.commit()
            return jsonify({"counterpart": counterpart, "messages": messages})

        if user["role"] == "faculty":
            student_id = str(request.args.get("studentId", "")).strip()
            if not student_id:
                return jsonify({"error": "studentId is required"}), 400
            if not is_faculty_assigned_to_student(conn, user["id"], student_id):
                return jsonify({"error": "Forbidden"}), 403
            student = conn.execute(
                """
                SELECT u.id, u.full_name AS name, u.email, u.phone, sp.course, sp.year
                FROM users u
                JOIN student_profiles sp ON sp.user_id = u.id
                WHERE u.id = ? AND u.role = 'student'
                """,
                (student_id,),
            ).fetchone()
            if not student:
                return jsonify({"error": "Student not found"}), 404
            messages = support_messages_for_pair(conn, student_id, user["id"])
            mark_support_thread_read(conn, user["id"], student_id, user["id"])
            conn.commit()
            return jsonify({"counterpart": dict(student), "messages": messages})

    return jsonify({"error": "Forbidden"}), 403


@app.post("/api/support/messages")
@require_auth
def create_support_message():
    user = request.current_user
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body", "")).strip()
    if not body:
        return jsonify({"error": "Message body is required"}), 400

    with get_connection() as conn:
        if user["role"] == "student":
            counterpart = support_counterpart_for_student(conn, user["id"])
            if not counterpart:
                return jsonify({"error": "No mentor assigned yet"}), 400
            student_id = user["id"]
            faculty_id = counterpart["id"]
        elif user["role"] == "faculty":
            student_id = str(payload.get("studentId", "")).strip()
            if not student_id:
                return jsonify({"error": "studentId is required"}), 400
            if not is_faculty_assigned_to_student(conn, user["id"], student_id):
                return jsonify({"error": "Forbidden"}), 403
            faculty_id = user["id"]
        else:
            return jsonify({"error": "Forbidden"}), 403

        message_row = conn.execute(
            """
            INSERT INTO support_messages (student_id, faculty_id, sender_id, body)
            VALUES (?, ?, ?, ?)
            RETURNING id
            """,
            (student_id, faculty_id, user["id"], body),
        ).fetchone()
        conn.commit()
        message = conn.execute(
            """
            SELECT sm.id, sm.student_id, sm.faculty_id, sm.sender_id, sm.body, sm.created_at,
                   u.role AS sender_role, u.full_name AS sender_name
            FROM support_messages sm
            JOIN users u ON u.id = sm.sender_id
            WHERE sm.id = ?
            """,
            (message_row["id"],),
        ).fetchone()

    return jsonify({"message": dict(message)}), 201


@app.get("/api/support/admin-messages")
@require_auth
def get_admin_messages():
    user = request.current_user
    with get_connection() as conn:
        if user["role"] == "faculty":
            counterpart = admin_profile(conn)
            if not counterpart:
                return jsonify({"counterpart": None, "messages": []})
            messages = admin_faculty_messages(conn, user["id"])
            mark_admin_faculty_thread_read(conn, user["id"], user["id"])
            conn.commit()
            return jsonify({"counterpart": counterpart, "messages": messages})

        if user["role"] == "admin":
            faculty_id = str(request.args.get("facultyId", "")).strip()
            if not faculty_id:
                return jsonify({"error": "facultyId is required"}), 400
            faculty = conn.execute(
                """
                SELECT u.id, u.full_name AS name, u.email, u.phone, fp.department
                FROM users u
                LEFT JOIN faculty_profiles fp ON fp.user_id = u.id
                WHERE u.id = ? AND u.role = 'faculty'
                """,
                (faculty_id,),
            ).fetchone()
            if not faculty:
                return jsonify({"error": "Faculty not found"}), 404
            messages = admin_faculty_messages(conn, faculty_id)
            mark_admin_faculty_thread_read(conn, user["id"], faculty_id)
            conn.commit()
            return jsonify({"counterpart": dict(faculty), "messages": messages})

    return jsonify({"error": "Forbidden"}), 403


@app.post("/api/support/admin-messages")
@require_auth
def create_admin_message():
    user = request.current_user
    payload = request.get_json(silent=True) or {}
    body = str(payload.get("body", "")).strip()
    if not body:
        return jsonify({"error": "Message body is required"}), 400

    with get_connection() as conn:
        if user["role"] == "faculty":
            faculty_id = user["id"]
        elif user["role"] == "admin":
            faculty_id = str(payload.get("facultyId", "")).strip()
            if not faculty_id:
                return jsonify({"error": "facultyId is required"}), 400
            faculty = conn.execute(
                "SELECT 1 FROM users WHERE id = ? AND role = 'faculty'",
                (faculty_id,),
            ).fetchone()
            if not faculty:
                return jsonify({"error": "Faculty not found"}), 404
        else:
            return jsonify({"error": "Forbidden"}), 403

        message_row = conn.execute(
            """
            INSERT INTO admin_faculty_messages (faculty_id, sender_id, body)
            VALUES (?, ?, ?)
            RETURNING id
            """,
            (faculty_id, user["id"], body),
        ).fetchone()
        conn.commit()
        message = conn.execute(
            """
            SELECT afm.id, afm.faculty_id, afm.sender_id, afm.body, afm.created_at,
                   u.role AS sender_role, u.full_name AS sender_name
            FROM admin_faculty_messages afm
            JOIN users u ON u.id = afm.sender_id
            WHERE afm.id = ?
            """,
            (message_row["id"],),
        ).fetchone()

    return jsonify({"message": dict(message)}), 201


@app.get("/api/support/summary")
@require_auth
def get_support_summary():
    with get_connection() as conn:
        return jsonify(support_summary_for_user(conn, request.current_user))


@app.post("/api/ai-chat")
@require_auth
def ai_chat():
    payload = request.get_json(silent=True) or {}
    prompt = str(payload.get("message", "")).strip()
    if not prompt:
        return jsonify({"error": "Message is required"}), 400
    if len(prompt) > 4000:
        return jsonify({"error": "Message is too long"}), 400

    try:
        reply = generate_ai_reply(request.current_user, prompt)
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 502

    return jsonify({"reply": reply})


@app.put("/api/admin/profile")
@require_roles("admin")
def update_admin_profile():
    payload = request.get_json(silent=True) or {}
    admin_id = request.current_user["id"]
    try:
        name = clean_text(payload.get("name"), field_name="Full name", max_len=120)
        password = str(payload.get("password", "")).strip()
        if password:
            password = validate_password(password)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    with get_connection() as conn:
        if password:
            conn.execute(
                """
                UPDATE users
                SET full_name = ?, password_hash = ?
                WHERE id = ? AND role = 'admin'
                """,
                (name, generate_password_hash(password), admin_id),
            )
        else:
            conn.execute(
                """
                UPDATE users
                SET full_name = ?
                WHERE id = ? AND role = 'admin'
                """,
                (name, admin_id),
            )
        conn.commit()
    return jsonify({"ok": True})


def create_app():
    init_db()
    ensure_initial_admin()
    return app


if __name__ == "__main__":
    init_db()
    ensure_initial_admin()
    app.run(
        host=os.environ.get("FLASK_HOST", "0.0.0.0"),
        port=int(os.environ.get("FLASK_PORT", "5000")),
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )
