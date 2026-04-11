from __future__ import annotations

from werkzeug.security import generate_password_hash

from db import get_connection, init_db
from seed_data import SEED_DATA


def clear_database(conn):
    tables = [
        "report_card_entries",
        "report_cards",
        "lecture_status",
        "admin_faculty_thread_reads",
        "support_thread_reads",
        "admin_faculty_messages",
        "support_messages",
        "assignments",
        "notification_reads",
        "notifications",
        "announcements",
        "attendance_sessions",
        "attendance_summary",
        "marks",
        "course_enrollments",
        "course_lectures",
        "courses",
        "student_profiles",
        "faculty_profiles",
        "subjects",
        "users",
    ]
    for table in tables:
        conn.execute(f"DELETE FROM {table}")


def seed_users(conn):
    admin = SEED_DATA["admin"]
    conn.execute(
        """
        INSERT OR REPLACE INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
        VALUES (?, 'admin', ?, ?, ?, ?, ?, 1)
        """,
        (
            admin["id"],
            admin["username"],
            generate_password_hash(admin["password"]),
            admin["name"],
            admin["email"],
            admin["phone"],
        ),
    )

    for faculty in SEED_DATA["faculty"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
            VALUES (?, 'faculty', ?, ?, ?, ?, ?, 1)
            """,
            (
                faculty["id"],
                faculty["username"],
                generate_password_hash(faculty["password"]),
                faculty["name"],
                faculty["email"],
                faculty["phone"],
            ),
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO faculty_profiles (user_id, department, bio)
            VALUES (?, ?, ?)
            """,
            (faculty["id"], faculty["department"], faculty["bio"]),
        )

    for student in SEED_DATA["students"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO users (id, role, username, password_hash, full_name, email, phone, is_active)
            VALUES (?, 'student', ?, ?, ?, ?, ?, ?)
            """,
            (
                student["id"],
                student["username"],
                generate_password_hash(student["password"]),
                student["name"],
                student["email"],
                student["phone"],
                1 if student["status"] == "Active" else 0,
            ),
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO student_profiles
            (user_id, course, year, gender, status, mentor_id, dob, address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                student["id"],
                student["course"],
                student["year"],
                student["gender"],
                student["status"],
                student["facultyId"],
                student["dob"],
                student["address"],
            ),
        )


def seed_courses(conn):
    for course in SEED_DATA["courses"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO courses (id, name, faculty_id)
            VALUES (?, ?, ?)
            """,
            (course["id"], course["name"], course["facultyId"]),
        )
        for lecture in course["schedule"]:
            conn.execute(
                """
                INSERT OR REPLACE INTO course_lectures (id, course_id, title, day, slot)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    lecture["id"],
                    course["id"],
                    lecture["title"],
                    lecture["day"],
                    lecture["slot"],
                ),
            )
        for student_id in course["students"]:
            conn.execute(
                """
                INSERT OR REPLACE INTO course_enrollments (course_id, student_id)
                VALUES (?, ?)
                """,
                (course["id"], student_id),
            )


def seed_subjects(conn):
    for subject in SEED_DATA["subjects"]:
        conn.execute("INSERT OR IGNORE INTO subjects (name) VALUES (?)", (subject,))


def seed_marks_and_attendance(conn):
    for student_id, courses in SEED_DATA["marks"].items():
        for course_id, marks in courses.items():
            conn.execute(
                """
                INSERT OR REPLACE INTO marks (student_id, course_id, marks)
                VALUES (?, ?, ?)
                """,
                (student_id, course_id, marks),
            )

    for student_id, courses in SEED_DATA["attendance"].items():
        for course_id, attendance_percent in courses.items():
            conn.execute(
                """
                INSERT OR REPLACE INTO attendance_summary (student_id, course_id, attendance_percent)
                VALUES (?, ?, ?)
                """,
                (student_id, course_id, attendance_percent),
            )


def seed_announcements(conn):
    for announcement in SEED_DATA["announcements"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO announcements
            (id, title, body, priority, date, created_by_user_id, created_by_role, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                announcement["id"],
                announcement["title"],
                announcement["body"],
                announcement["priority"],
                announcement["date"],
                announcement["createdByUserId"],
                announcement["createdByRole"],
                announcement["createdByName"],
            ),
        )


def seed_notifications(conn):
    for notification in SEED_DATA["notifications"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO notifications (id, title, body, priority, date)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                notification["id"],
                notification["title"],
                notification["body"],
                notification["priority"],
                notification["date"],
            ),
        )
        for student_id in notification["readBy"]:
            conn.execute(
                """
                INSERT OR REPLACE INTO notification_reads (notification_id, student_id)
                VALUES (?, ?)
                """,
                (notification["id"], student_id),
            )


def seed_assignments(conn):
    for assignment in SEED_DATA["assignments"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO assignments
            (id, course_id, topic, details, submission_date, created_by_user_id, created_by_name)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                assignment["id"],
                assignment["courseId"],
                assignment["topic"],
                assignment["details"],
                assignment["submissionDate"],
                assignment["createdByUserId"],
                assignment["createdByName"],
            ),
        )


def seed_report_cards(conn):
    for student_id, cards in SEED_DATA["reportCards"].items():
        for card in cards:
            conn.execute(
                """
                INSERT OR REPLACE INTO report_cards (id, student_id, semester, published_on, remarks)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    card["id"],
                    student_id,
                    card["semester"],
                    card["publishedOn"],
                    card["remarks"],
                ),
            )
            conn.execute(
                "DELETE FROM report_card_entries WHERE report_card_id = ?",
                (card["id"],),
            )
            for entry in card["entries"]:
                conn.execute(
                    """
                    INSERT INTO report_card_entries (report_card_id, course_name, marks)
                    VALUES (?, ?, ?)
                    """,
                    (card["id"], entry["course"], entry["marks"]),
                )


def seed_database() -> None:
    init_db()
    with get_connection() as conn:
        clear_database(conn)
        seed_users(conn)
        seed_courses(conn)
        seed_subjects(conn)
        seed_marks_and_attendance(conn)
        seed_announcements(conn)
        seed_notifications(conn)
        seed_assignments(conn)
        seed_report_cards(conn)
        conn.commit()


if __name__ == "__main__":
    seed_database()
    print("Database seeded successfully.")
