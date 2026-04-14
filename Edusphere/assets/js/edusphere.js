// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // DATA STORE
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      let db = {
        admin: {
          username: "",
          email: "",
          phone: "",
          name: "Admin",
          id: "ADMIN1",
        },
        admins: [],
        faculty: [],
        students: [],
        courses: [],
        subjects: [],
        marks: {},
        attendance: {},
        attendanceSessions: {},
        lectureStatus: {},
        notifications: [],
        announcements: [],
        assignments: [],
        reportCards: {},
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // STATE
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      let state = {
        user: null,
        section: "dashboard",
        search: "",
        listSearch: {
          students: "",
          faculty: "",
        },
        dark: false,
        sidebarCollapsed: false,
        support: {
          tab: "mentor",
          studentId: "",
          facultyId: "",
          counterpart: null,
          messages: [],
          loading: false,
          mentorDraft: "",
          aiDraft: "",
          summary: {
            mentor: [],
            admin: [],
            totalUnread: 0,
          },
        },
      };
      function resetSupportState(role = state.user?.role) {
        state.support = {
          tab: role === "admin" ? "admin" : "mentor",
          studentId: "",
          facultyId: "",
          counterpart: null,
          messages: [],
          loading: false,
          mentorDraft: "",
          aiDraft: "",
          summary: {
            mentor: [],
            admin: [],
            totalUnread: 0,
          },
        };
      }
      let pendingDeleteFn = null;
      let backendReady = false;
      let bootstrapPromise = null;
      let supportPollTimer = null;
      let csrfToken = "";
      const SUPPORT_POLL_MS = 12000;
      const THEME_STORAGE_KEY = "edusphere-theme";

      function persistThemePreference() {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, state.dark ? "dark" : "light");
        } catch (error) {
          console.warn("Theme preference could not be saved.", error);
        }
      }

      function applyTheme() {
        if (state.dark) {
          document.documentElement.setAttribute("data-theme", "dark");
        } else {
          document.documentElement.removeAttribute("data-theme");
        }
        byId("darkToggle").textContent = state.dark ? "☀️" : "🌙";
      }

      function restoreThemePreference() {
        try {
          state.dark = localStorage.getItem(THEME_STORAGE_KEY) === "dark";
        } catch (error) {
          state.dark = document.documentElement.getAttribute("data-theme") === "dark";
        }
        applyTheme();
      }

      async function apiRequest(path, options = {}) {
        const method = (options.method || "GET").toUpperCase();
        const headers = {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        };
        if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
          headers["X-CSRF-Token"] = csrfToken;
        }
        const response = await fetch(path, {
          headers,
          ...options,
        });

        const nextCsrfToken = response.headers.get("X-CSRF-Token");
        if (nextCsrfToken) {
          csrfToken = nextCsrfToken;
        }
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
          backendReady = false;
          state.user = null;
          showLoginScreen();
        }
        if (!response.ok) {
          throw new Error(data.error || `Request failed: ${response.status}`);
        }
        return data;
      }

      function applyBootstrapData(payload) {
        db = {
          ...db,
          admin: payload.admin ? { ...db.admin, ...payload.admin } : db.admin,
          admins: payload.admins || db.admins,
          faculty: payload.faculty || db.faculty,
          students: payload.students || db.students,
          courses: payload.courses || db.courses,
          subjects: payload.subjects || db.subjects,
          marks: payload.marks || db.marks,
          attendance: payload.attendance || db.attendance,
          announcements: payload.announcements || db.announcements,
          notifications: payload.notifications || db.notifications,
          assignments: payload.assignments || db.assignments,
          reportCards: payload.reportCards || db.reportCards,
          attendanceSessions: payload.attendanceSessions || {},
          lectureStatus: payload.lectureStatus || {},
        };
      }

      async function bootstrapFromApi(force = false) {
        if (bootstrapPromise && !force) return bootstrapPromise;
        bootstrapPromise = apiRequest("/api/bootstrap")
          .then((payload) => {
            applyBootstrapData(payload);
            backendReady = true;
            return payload;
          })
          .catch((error) => {
            backendReady = false;
            throw error;
          });
        return bootstrapPromise;
      }

      async function refreshDbFromApi() {
        await bootstrapFromApi(true);
        syncCurrentUserFromDb();
      }

      async function loadSupportSummary() {
        if (!state.user || !["student", "faculty", "admin"].includes(state.user.role)) {
          return;
        }
        try {
          state.support.summary = await apiRequest("/api/support/summary");
        } catch (error) {
          state.support.summary = { mentor: [], admin: [], totalUnread: 0 };
        }
      }

      async function pollSupportData() {
        if (!state.user || !backendReady || !["student", "faculty", "admin"].includes(state.user.role)) {
          return;
        }
        await bootstrapFromApi(true);
        await loadSupportSummary();
        renderNav();
        if (state.section === "support" && state.support.tab !== "ai") {
          await loadSupportMessages(true);
        }
      }

      function startSupportPolling() {
        stopSupportPolling();
        if (!state.user || !["student", "faculty", "admin"].includes(state.user.role)) return;
        supportPollTimer = setInterval(() => {
          pollSupportData().catch((error) => {
            console.warn("Support polling failed.", error);
          });
        }, SUPPORT_POLL_MS);
      }

      function stopSupportPolling() {
        if (supportPollTimer) {
          clearInterval(supportPollTimer);
          supportPollTimer = null;
        }
      }

      function showDashboard() {
        byId("loginScreen").classList.add("hidden");
        byId("dashboardShell").classList.remove("hidden");
      }

      function showLoginScreen() {
        stopSupportPolling();
        byId("dashboardShell").classList.add("hidden");
        byId("loginScreen").classList.remove("hidden");
        byId("loginForm").reset();
        byId("loginErr").textContent = "";
      }

      function hydrateUserFromDb(savedUser) {
        if (!savedUser?.id || !savedUser?.role) return savedUser || null;
        if (savedUser.role === "admin") return { ...db.admin, ...savedUser, role: "admin" };
        if (savedUser.role === "faculty") {
          const faculty = getFaculty(savedUser.id);
          return faculty ? { ...faculty, role: "faculty" } : savedUser;
        }
        if (savedUser.role === "student") {
          const student = getStudent(savedUser.id);
          return student ? { ...student, role: "student" } : savedUser;
        }
        return savedUser;
      }

      function syncCurrentUserFromDb() {
        if (!state.user) return;
        const hydrated = hydrateUserFromDb(state.user);
        if (hydrated) {
          state.user = hydrated;
        }
      }

      async function restoreSession() {
        try {
          const result = await apiRequest("/api/auth/session");
          if (!result.user) {
            state.user = null;
            showLoginScreen();
            return false;
          }
          state.user = result.user;
          resetSupportState(result.user.role);
          await bootstrapFromApi(true);
          await loadSupportSummary();
          syncCurrentUserFromDb();
          showDashboard();
          startSupportPolling();
          renderApp();
          return true;
        } catch (error) {
          state.user = null;
          showLoginScreen();
          return false;
        }
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // UTILS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const esc = (s) =>
        String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      const initials = (name) =>
        name
          .split(" ")
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
          .toUpperCase();
      const avg = (arr) =>
        arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
      const fmtDate = (d) =>
        new Date(d).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
      const fmtDateTime = (d) =>
        new Date(d).toLocaleString("en-IN", {
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit",
        });
      const today = () =>
        new Date().toLocaleDateString("en-IN", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      const byId = (id) => document.getElementById(id);
      const grade = (m) =>
        m >= 90
          ? { g: "A", r: "Excellent", p: 4 }
          : m >= 80
            ? { g: "B", r: "Very Good", p: 3.5 }
            : m >= 70
              ? { g: "C", r: "Good", p: 3 }
              : m >= 60
                ? { g: "D", r: "Needs Work", p: 2 }
                : { g: "F", r: "At Risk", p: 0 };
      const gradeColor = (g) =>
        ({
          A: "pill-success",
          B: "pill-info",
          C: "pill-warn",
          D: "pill-warn",
          F: "pill-danger",
        })[g] || "pill-gray";
      const getFaculty = (id) => db.faculty.find((f) => f.id === id);
      const getCourse = (id) => db.courses.find((c) => c.id === id);
      const getStudent = (id) => db.students.find((s) => s.id === id);
      const getStudentCourses = (studentId) =>
        db.courses.filter((c) => c.students.includes(studentId));
      const getAvailableCourses = (studentId) =>
        db.courses.filter((c) => !c.students.includes(studentId));
      const getStudentAssignments = (studentId) =>
        db.assignments.filter((a) =>
          getCourse(a.courseId)?.students.includes(studentId),
        );
      const getStudentReportCards = (studentId) => db.reportCards[studentId] || [];
      const nextId = (prefix) =>
        `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const hits = (txt, query = state.search) =>
        txt.toLowerCase().includes((query || "").toLowerCase());

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // TOAST
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function toast(msg, type = "info") {
        const stack = byId("toastStack");
        const el = document.createElement("div");
        const icons = { success: "✅", error: "❌", info: "💬" };
        el.className = `toast toast-${type}`;
        const icon = document.createElement("span");
        const text = document.createElement("span");
        icon.className = "toast-icon";
        icon.textContent = icons[type] || "💬";
        text.textContent = String(msg || "");
        el.append(icon, text);
        stack.appendChild(el);
        requestAnimationFrame(() => el.classList.add("show"));
        setTimeout(() => {
          el.classList.remove("show");
          setTimeout(() => el.remove(), 350);
        }, 3000);
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // CONFIRM DIALOG
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function confirm(title, msg, onOk) {
        byId("confirmTitle").textContent = title;
        byId("confirmMsg").textContent = msg;
        pendingDeleteFn = onOk;
        byId("confirmModal").classList.add("open");
      }
      byId("confirmCancel").onclick = () =>
        byId("confirmModal").classList.remove("open");
      byId("confirmOk").onclick = () => {
        byId("confirmModal").classList.remove("open");
        pendingDeleteFn && pendingDeleteFn();
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // DARK MODE
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      byId("darkToggle").onclick = () => {
        state.dark = !state.dark;
        applyTheme();
        persistThemePreference();
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // MODAL
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function openModal(title, sub, html, onSubmit) {
        byId("modalTitle").textContent = title;
        byId("modalSub").textContent = sub;
        const form = byId("entityForm");
        form.innerHTML = html;
        form.onsubmit = async (e) => {
          e.preventDefault();
          await onSubmit();
        };
        byId("entityModal").classList.add("open");
      }
      function closeModal() {
        byId("entityModal").classList.remove("open");
      }
      byId("closeModal").onclick = closeModal;
      byId("entityModal").onclick = (e) => {
        if (e.target === byId("entityModal")) closeModal();
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // COUNTER ANIMATION
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function animateCounters() {
        document.querySelectorAll("[data-count]").forEach((el) => {
          const target = parseFloat(el.dataset.count);
          const isFloat = el.dataset.count.includes(".");
          const isPercent = el.dataset.count.endsWith("%");
          const val = parseFloat(el.dataset.count);
          let start = null;
          const dur = 1200;
          function step(ts) {
            if (!start) start = ts;
            const p = Math.min((ts - start) / dur, 1);
            const ease = 1 - Math.pow(1 - p, 3);
            const cur = val * ease;
            el.textContent = isFloat
              ? cur.toFixed(2)
              : isPercent
                ? Math.round(cur) + "%"
                : Math.round(cur);
            if (p < 1) requestAnimationFrame(step);
            else el.textContent = el.dataset.count;
          }
          requestAnimationFrame(step);
        });
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // SKELETON
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function skeleton(rows = 4) {
        return `<div>${Array(rows).fill('<div class="skeleton skel-row"></div>').join("")}</div>`;
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // ICONS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const IC = {
        message: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
        plus: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,

        grid: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="10" width="7" height="11" rx="1.5"/><rect x="3" y="12" width="7" height="9" rx="1.5"/></svg>`,
        users: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
        cap: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9 12 4l10 5-10 5L2 9Z"/><path d="M6 12v4c0 2 2.7 4 6 4s6-2 6-4v-4"/><path d="M20 11v5"/></svg>`,
        book: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>`,
        chart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M7 16V8"/><path d="M12 16V4"/><path d="M17 16v-5"/></svg>`,
        gear: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
        bell: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17H5l1.4-1.4A2 2 0 0 0 7 14.2V11a5 5 0 0 1 10 0v3.2c0 .53.2 1.04.6 1.4L19 17h-4"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>`,
        activity: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 8-4-16-3 8H2"/></svg>`,
        edit: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
        trash: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
        save: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>`,
        export: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        file: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
        calendar: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`,
        inbox: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg>`,
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // NAV CONFIG
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const navConfig = {
        admin: [
          { key: "dashboard", label: "Dashboard", icon: "grid" },
          { key: "students", label: "Students", icon: "users" },
          { key: "faculty", label: "Faculty", icon: "cap" },
          { key: "courses", label: "Courses", icon: "book" },
          { key: "announcements", label: "Announcements", icon: "bell" },
          { key: "results", label: "Results", icon: "chart" },
          { key: "reports", label: "Reports", icon: "activity" },
          { key: "support", label: "Messages", icon: "message" },
          { key: "settings", label: "Settings", icon: "gear" },
        ],
        faculty: [
          { key: "dashboard", label: "Dashboard", icon: "grid" },
          { key: "my-courses", label: "My Courses", icon: "book" },
          { key: "my-students", label: "My Students", icon: "users" },
          { key: "upload-marks", label: "Upload Marks", icon: "chart" },
          { key: "attendance", label: "Attendance", icon: "activity" },
          { key: "schedule", label: "Schedule", icon: "calendar" },
          { key: "assignments", label: "Assignments", icon: "file" },
          { key: "announcements", label: "Announcements", icon: "bell" },
          { key: "profile", label: "Profile", icon: "gear" },
          { key: "support", label: "Support", icon: "message" },
        ],
        student: [
          { key: "dashboard", label: "Dashboard", icon: "grid" },
          { key: "my-details", label: "My Details", icon: "users" },
          { key: "my-courses", label: "My Courses", icon: "book" },
          { key: "assignments", label: "Assignments", icon: "file" },
          { key: "results", label: "Results", icon: "chart" },
          { key: "schedule", label: "Schedule", icon: "calendar" },
          { key: "announcements", label: "Announcements", icon: "bell" },
          { key: "notifications", label: "Notifications", icon: "inbox" },
          { key: "support", label: "Support", icon: "message" },
        ],
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // TIMETABLE HELPERS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      const TT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const TT_SLOTS = [
        "9:00 AM",
        "10:00 AM",
        "11:00 AM",
        "1:00 PM",
        "2:00 PM",
        "3:00 PM",
      ];

      function renderTT(courses) {
        let html = `<div class="tt-wrap"><div class="tt-grid">`;
        html += `<div class="tt-cell header">Day / Slot</div>`;
        TT_SLOTS.forEach(
          (s) => (html += `<div class="tt-cell header">${s}</div>`),
        );
        TT_DAYS.forEach((day) => {
          html += `<div class="tt-cell header">${day}</div>`;
          TT_SLOTS.forEach((slot) => {
            const match = courses
              .map((course) => ({
                course,
                lecture: course.schedule.find(
                  (e) => e.day === day && e.slot === slot,
                ),
              }))
              .find((entry) => entry.lecture);
            html += match
              ? `<div class="tt-cell slot"><strong>${match.course.name}</strong><span>${match.lecture.title || "Lecture"}</span></div>`
              : `<div class="tt-cell free"><span>Free</span></div>`;
          });
        });
        html += `</div></div>`;
        return html;
      }

      function reportCardMetrics(card) {
        const marks = card.entries.map((item) => item.marks);
        return {
          avgMarks: avg(marks),
          gpa: avg(marks.map((mark) => grade(mark).p)),
        };
      }

      function downloadReportCard(student, card) {
        const metrics = reportCardMetrics(card);
        const lines = [
          "EduSphere Report Card",
          `Student: ${student.name} (${student.id})`,
          `Course: ${student.course}`,
          `Semester: ${card.semester}`,
          `Published On: ${fmtDate(card.publishedOn)}`,
          "",
          "Subjects",
          ...card.entries.map((entry) => {
            const g2 = grade(entry.marks);
            return `${entry.course}: ${entry.marks}/100 (${g2.g} - ${g2.r})`;
          }),
          "",
          `Average Marks: ${metrics.avgMarks.toFixed(1)}`,
          `GPA: ${metrics.gpa.toFixed(2)}`,
          `Remarks: ${card.remarks || "NA"}`,
        ];
        const blob = new Blob([lines.join("\n")], {
          type: "text/plain;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${student.id}-${card.semester.replace(/\s+/g, "-").toLowerCase()}-report-card.txt`;
        link.click();
        URL.revokeObjectURL(url);
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // FORM FIELD BUILDERS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function ff(label, id, val = "", type = "text", req = true) {
        const inputHtml = `<input id="${id}" type="${type}" value="${esc(val)}" ${req ? "required" : ""}/>`;
        const toggleHtml = type === "password" ? `<button type="button" tabindex="-1" onclick="const el=document.getElementById('${id}');el.type=el.type==='password'?'text':'password';" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;opacity:0.6;font-size:1.1rem;top:50%;transform:translateY(-50%)">👁</button>` : ``;
        return `<div class="form-field"><label for="${id}">${label}</label><div style="position:relative;display:flex;flex:1">${inputHtml}${toggleHtml}</div></div>`;
      }
      function fsel(label, id, opts, val = "") {
        const ops = opts
          .map(
            (o) =>
              `<option value="${o}" ${o === val ? "selected" : ""}>${o}</option>`,
          )
          .join("");
        return `<div class="form-field"><label for="${id}">${label}</label><select id="${id}">${ops}</select></div>`;
      }
      function fta(label, id, val = "") {
        return `<div class="form-field" style="grid-column:1/-1"><label for="${id}">${label}</label><textarea id="${id}">${esc(val)}</textarea></div>`;
      }

      function previewGrade(input, sid, cid) {
        const badge = byId(`gshow-${sid}-${cid}`);
        if (!badge) return;
        const raw = input.value.trim();
        if (raw === "") {
          badge.className = "pill pill-gray";
          badge.textContent = "—";
          return;
        }
        const val = Number(raw);
        if (Number.isNaN(val)) {
          badge.className = "pill pill-gray";
          badge.textContent = "—";
          return;
        }
        const g2 = grade(val);
        badge.className = `pill ${gradeColor(g2.g)}`;
        badge.textContent = g2.g;
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // LOGIN
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      byId("loginForm").onsubmit = async (e) => {
        e.preventDefault();
        const u = byId("userInput").value.trim(),
          p = byId("passInput").value.trim();
        if (!u || !p) {
          byId("loginErr").textContent = "Email and password are required.";
          return;
        }
        byId("loginErr").textContent = "";

        try {
          const result = await apiRequest("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({
              username: u,
              password: p,
            }),
          });
          if (!result.ok || !result.user) {
            byId("loginErr").textContent =
              result.error || "Invalid credentials.";
            return;
          }
          state.user = result.user;
          resetSupportState();
          await bootstrapFromApi(true);
          await loadSupportSummary();
          syncCurrentUserFromDb();
          state.section = "dashboard";
          state.search = "";
          showDashboard();
          startSupportPolling();
          renderApp();
        } catch (error) {
          byId("loginErr").textContent =
            error.message || "Invalid credentials.";
        }
      };
      byId("eyeBtn").onclick = () => {
        const inp = byId("passInput");
        const isPass = inp.type === "password";
        inp.type = isPass ? "text" : "password";
        byId("eyeIcon").innerHTML = isPass
          ? `<path d="m3 3 18 18"/><path d="M10.6 10.6a2 2 0 1 0 2.8 2.8"/><path d="M9.88 5.08A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a20.8 20.8 0 0 1-4.18 4.9"/><path d="M6.61 6.61A20.2 20.2 0 0 0 1 12s4 7 11 7a10.94 10.94 0 0 0 2.12-.2"/>`
          : `<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z"/><circle cx="12" cy="12" r="3"/>`;
      };
      byId("forgotLink").onclick = (e) => {
        e.preventDefault();
        toast("Password resets are handled by the admin right now. Ask the admin to set a new password for your account.", "info");
      };
      byId("signupLink").onclick = (e) => {
        e.preventDefault();
        toast("Accounts are created by the admin.", "info");
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // LOGOUT
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      async function logout() {
        try {
          await apiRequest("/api/auth/logout", { method: "POST" });
        } catch (error) {
          console.warn("Logout request failed.", error);
        }
        state.user = null;
        state.section = "dashboard";
        state.search = "";
        resetSupportState();
        stopSupportPolling();
        closeSidebar();
        syncSidebarLayout();
        showLoginScreen();
        closeSidebar();
      }
      byId("logoutBtn").onclick = () => {
        logout();
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // SIDEBAR
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function openSidebar() {
        byId("sidebar").classList.add("open");
        byId("sidebarOverlay").classList.add("show");
      }
      function closeSidebar() {
        byId("sidebar").classList.remove("open");
        byId("sidebarOverlay").classList.remove("show");
      }
      function syncSidebarLayout() {
        byId("dashboardShell").classList.toggle(
          "sidebar-collapsed",
          !!state.sidebarCollapsed && window.innerWidth > 900,
        );
      }
      function toggleSidebar() {
        if (window.innerWidth <= 900) {
          const sidebar = byId("sidebar");
          const isOpen = sidebar.classList.contains("open");
          if (isOpen) closeSidebar();
          else openSidebar();
          return;
        }
        state.sidebarCollapsed = !state.sidebarCollapsed;
        syncSidebarLayout();
      }
      byId("hamburger").onclick = toggleSidebar;
      byId("sidebarOverlay").onclick = closeSidebar;
      window.addEventListener("resize", () => {
        if (window.innerWidth > 900) closeSidebar();
        syncSidebarLayout();
      });

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // SEARCH
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      byId("searchInput").oninput = (e) => {
        state.search = e.target.value;
        renderSections();
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // NOTIFICATIONS BELL
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      byId("notifBtn").onclick = () => {
        if (state.user?.role === "student") {
          navigateTo("notifications");
        } else
          toast(
            "Notifications are available in the Student dashboard.",
            "info",
          );
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // NAVIGATION
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function navigateTo(section) {
        if (!state.user) {
          showLoginScreen();
          return;
        }
        state.section = section;
        state.search = "";
        byId("searchInput").value = "";
        renderNav();
        renderSections();
        if (
          section === "support" &&
          state.user &&
          state.support.tab !== "ai"
        ) {
          loadSupportMessages();
        }
        closeSidebar();
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // TOPBAR RENDER
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function renderTopbar() {
        const u = state.user;
        if (!u) return;
        byId("userAvatar").textContent = initials(u.name);
        byId("userName").textContent = u.name;
        byId("userRole").textContent =
          u.role.charAt(0).toUpperCase() + u.role.slice(1);
        if (u.role === "student") {
          const unread = db.notifications.filter(
            (n) => !n.readBy.includes(u.id),
          ).length;
          byId("notifDot").classList.toggle("hidden", unread === 0);
        }
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // BANNER
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function renderBanner() {
        const u = state.user;
        if (!u) return;
        const first = u.name.split(" ")[0];
        const sub = {
          admin:
            "Manage students, faculty, courses and system settings from one place.",
          faculty:
            "Track your classes, upload marks, and monitor student attendance.",
          student: "Check your courses, results, schedule, and portal notices.",
        };
        byId("banner").innerHTML = `
    <div class="banner-copy">
      <div class="banner-date">${today()}</div>
      <h2>Welcome back, ${first}!</h2>
      <p>${sub[u.role]}</p>
    </div>
    <div class="banner-visual">
      <svg viewBox="0 0 280 200" fill="none">
        <circle cx="220" cy="36" r="14" fill="rgba(255,255,255,.22)"/>
        <circle cx="44" cy="156" r="10" fill="rgba(255,255,255,.18)"/>
        <circle cx="256" cy="150" r="18" fill="rgba(255,255,255,.13)"/>
        <path d="M140 66 174 82 140 98 106 82 140 66Z" fill="rgba(255,255,255,.22)"/>
        <path d="M117 97v18c0 8 11 16 23 16s23-8 23-16V97" fill="rgba(255,255,255,.14)"/>
        <path d="M173 84v24" stroke="#26124D" stroke-width="4" stroke-linecap="round"/>
        <path d="M173 108c3 0 7 4 7 8v8h-14v-8c0-4 4-8 7-8Z" fill="#F8F8F8"/>
        <circle cx="118" cy="134" r="40" fill="rgba(255,255,255,.9)"/>
        <path d="M83 186c5-20 28-36 47-36 20 0 41 16 47 36" fill="rgba(255,255,255,.9)"/>
        <path d="M101 128c0-18 13-32 31-32s31 14 31 32v14H101z" fill="#3B245D"/>
        <circle cx="132" cy="128" r="20" fill="#F6C7A8"/>
        <path d="M112 120c2-12 13-22 26-22 10 0 20 6 25 15-4-2-9-3-13-3-16 0-30 10-38 25z" fill="#3B245D"/>
        <circle cx="125" cy="129" r="2.5" fill="#2B1D42"/>
        <circle cx="140" cy="129" r="2.5" fill="#2B1D42"/>
        <path d="M127 139c4 3 10 3 14 0" stroke="#D97706" stroke-width="2.5" stroke-linecap="round"/>
        <rect x="196" y="108" width="50" height="58" rx="10" fill="rgba(255,255,255,.85)"/>
        <rect x="204" y="120" width="34" height="7" rx="3.5" fill="#A78BFA"/>
        <rect x="204" y="133" width="24" height="7" rx="3.5" fill="#EDE9FE"/>
        <rect x="204" y="146" width="28" height="7" rx="3.5" fill="#EDE9FE"/>
      </svg>
    </div>`;
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // NAV RENDER
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function renderNav() {
        if (!state.user) {
          byId("navList").innerHTML = "";
          return;
        }
        const items = navConfig[state.user.role] || [];
        const unreadMessages = state.support.summary?.totalUnread || 0;
        byId("navList").innerHTML = items
          .map(
            (item) => `
    <button class="nav-item ${state.section === item.key ? "active" : ""}" data-nav="${item.key}">
      ${IC[item.icon] || ""}<span>${item.label}</span>${item.key === "support" && unreadMessages ? `<strong class="nav-badge">${unreadMessages}</strong>` : ""}
    </button>`,
          )
          .join("");
        byId("navList")
          .querySelectorAll("[data-nav]")
          .forEach((btn) => {
            btn.onclick = () => navigateTo(btn.dataset.nav);
          });
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // STAT CARD
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function statCard(icon, value, label, color = "var(--p)") {
        return `<div class="stat-card" style="border-left-color:${color}">
    <div class="stat-icon" style="background:${color}18;color:${color}">${IC[icon] || ""}</div>
    <div><div class="stat-num" data-count="${value}">${value}</div><div class="stat-label">${label}</div></div>
  </div>`;
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // CSV EXPORT
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function exportCSV(rows, filename) {
        const csv = rows
          .map((r) =>
            r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","),
          )
          .join("\n");
        const a = document.createElement("a");
        a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
        a.download = filename;
        a.click();
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // ADMIN SECTIONS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function adminSections() {
        const students = db.students,
          faculty = db.faculty,
          courses = db.courses;
        const active = students.filter((s) => s.status === "Active");
        const topStuds = students
          .map((s) => {
            const vals = Object.values(db.marks[s.id] || {});
            return { ...s, avgMark: vals.length ? avg(vals) : 0 };
          })
          .sort((a, b) => b.avgMark - a.avgMark)
          .slice(0, 5);

        const attSummary = [
          {
            label: "Overall Average",
            desc: "Campus-wide",
            val: `${Math.round(avg(students.flatMap((s) => Object.values(db.attendance[s.id] || {})))) || 0}%`,
            cls: "pill-success",
          },
          {
            label: "Best Student",
            desc: topStuds[0]?.name || "N/A",
            val: `${Math.round(avg(Object.values(db.attendance[topStuds[0]?.id] || {}))) || 0}%`,
            cls: "pill-success",
          },
          {
            label: "Needs Attention",
            desc:
              students
                .slice()
                .sort(
                  (a, b) =>
                    avg(Object.values(db.attendance[a.id] || {})) -
                    avg(Object.values(db.attendance[b.id] || {})),
                )[0]?.name || "N/A",
            val: `${Math.round(avg(Object.values(db.attendance[students.slice().sort((a, b) => avg(Object.values(db.attendance[a.id] || {})) - avg(Object.values(db.attendance[b.id] || {})))[0]?.id] || {}))) || 0}%`,
            cls: "pill-warn",
          },
        ];

        const filtered_s = students.filter((s) =>
          hits(
            `${s.id} ${s.name} ${s.email} ${s.course} ${s.year} ${s.status}`,
            state.listSearch.students,
          ),
        );
        const filtered_f = faculty.filter((f) =>
          hits(`${f.id} ${f.name} ${f.email} ${f.department}`, state.listSearch.faculty),
        );

        const gradeData = [
          { g: "A", count: 0, color: "var(--success)" },
          { g: "B", count: 0, color: "var(--info)" },
          { g: "C", count: 0, color: "var(--warning)" },
          { g: "D", count: 0, color: "#f97316" },
          { g: "F", count: 0, color: "var(--danger)" },
        ];
        students.forEach((s) => {
          Object.values(db.marks[s.id] || {}).forEach((m) => {
            const gd = grade(m);
            gradeData.find((x) => x.g === gd.g).count++;
          });
        });
        const totalGrades = gradeData.reduce((s, x) => s + x.count, 0) || 1;
        const reportRows = students
          .flatMap((student) =>
            getStudentReportCards(student.id).map((card) => ({
              student,
              card,
              metrics: reportCardMetrics(card),
            })),
          )
          .sort((a, b) => new Date(b.card.publishedOn) - new Date(a.card.publishedOn));

        return `
<!-- DASHBOARD -->
<div class="page-section ${state.section === "dashboard" ? "active" : ""}">
  <div class="stats-grid">
    ${statCard("users", students.length, "Total Students")}
    ${statCard("cap", faculty.length, "Total Faculty", "#0284c7")}
    ${statCard("book", courses.length, "Total Courses", "#16a34a")}
    ${statCard("activity", active.length, "Active Students", "#d97706")}
  </div>
  <div class="split-grid">
    <div class="section-card">
      <div class="section-head"><div><h3>Top 5 Students</h3><p>By average mark across all subjects</p></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>Name</th><th>Course</th><th>Avg</th><th>GPA</th></tr></thead><tbody>
        ${topStuds
          .map((s, i) => {
            const g2 = grade(s.avgMark);
            return `<tr><td><strong>${i + 1}</strong></td><td>${s.name}</td><td>${s.course}</td><td>${s.avgMark.toFixed(1)}%</td><td><span class="pill ${gradeColor(g2.g)}">${g2.g}</span></td></tr>`;
          })
          .join("")}
      </tbody></table></div>
      <div class="bar-chart">
        ${topStuds.map((s) => `<div class="bar-item"><div class="bar-track"><div class="bar-fill" style="height:${s.avgMark}%"></div></div><strong>${Math.round(s.avgMark)}%</strong><span style="font-size:.75rem;color:var(--muted)">${s.name.split(" ")[0]}</span></div>`).join("")}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="section-card">
        <div class="section-head"><div><h3>Attendance</h3><p>Performance snapshot</p></div></div>
        <div class="summary-list">${attSummary.map((i) => `<div class="summary-item"><div><strong>${i.label}</strong><small>${i.desc}</small></div><span class="pill ${i.cls}">${i.val}</span></div>`).join("")}</div>
      </div>
      <div class="section-card">
        <div class="section-head"><div><h3>Grade Distribution</h3><p>All recorded marks</p></div></div>
        ${gradeData
          .map((x) => {
            const pct = Math.round((x.count / totalGrades) * 100);
            return `<div class="grade-bar-item"><span class="grade-bar-label">${x.g}</span><div class="grade-bar-track"><div class="grade-bar-fill" style="width:${pct}%;background:${x.color}"></div></div><span class="grade-bar-pct">${pct}%</span></div>`;
          })
          .join("")}
      </div>
    </div>
  </div>
</div>

<!-- STUDENTS -->
<div class="page-section ${state.section === "students" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Students</h3><p>${students.length} total · ${active.length} active</p></div>
      <div class="section-actions">
        <label class="search-input"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" id="stSearch" placeholder="Search students..." value="${esc(state.listSearch.students)}"/></label>
        <button class="btn btn-secondary" id="exportStudentsBtn">${IC.export} Export CSV</button>
        <button class="btn btn-primary" id="addStudentBtn">+ Add Student</button>
      </div>
    </div>
    ${
      filtered_s.length
        ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Course</th><th>Year</th><th>Mentor</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${filtered_s
        .map(
          (s) => `<tr id="srow-${s.id}">
        <td><code style="font-size:.82rem;color:var(--muted)">${s.id}</code></td>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar" style="width:30px;height:30px;font-size:.72rem">${initials(s.name)}</div>${s.name}</div></td>
        <td style="color:var(--muted);font-size:.88rem">${s.email}</td><td>${s.course}</td><td>${s.year}</td><td>${getFaculty(s.facultyId)?.name || "—"}</td>
        <td><span class="pill ${s.status === "Active" ? "pill-success" : "pill-gray"}">${s.status}</span></td>
        <td><div class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-edit-s="${s.id}">${IC.edit} Edit</button>
          <button class="btn btn-danger btn-sm" data-del-s="${s.id}">${IC.trash}</button>
        </div></td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>`
        : `<div class="empty"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><p>No students match your search.</p></div>`
    }
  </div>
</div>

<!-- FACULTY -->
<div class="page-section ${state.section === "faculty" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Faculty</h3><p>${faculty.length} members</p></div>
      <div class="section-actions">
        <label class="search-input"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" id="facSearch" placeholder="Search faculty..." value="${esc(state.listSearch.faculty)}"/></label>
        <button type="button" class="btn btn-primary" id="addFacultyBtn">+ Add Faculty</button>
      </div>
    </div>
    ${
      filtered_f.length
        ? `<div class="table-wrap"><table class="data-table">
      <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Department</th><th>Courses</th><th>Actions</th></tr></thead>
      <tbody>${filtered_f
        .map(
          (f) => `<tr id="frow-${f.id}">
        <td><code style="font-size:.82rem;color:var(--muted)">${f.id}</code></td>
        <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar" style="width:30px;height:30px;font-size:.72rem">${initials(f.name)}</div>${f.name}</div></td>
        <td style="color:var(--muted);font-size:.88rem">${f.email}</td><td>${f.department}</td>
        <td style="font-size:.88rem">${
          courses
            .filter((c) => c.facultyId === f.id)
            .map((c) => c.name)
            .join(", ") || "—"
        }</td>
        <td><div class="actions-cell">
          <button class="btn btn-secondary btn-sm" data-edit-f="${f.id}">${IC.edit} Edit</button>
          <button class="btn btn-danger btn-sm" data-del-f="${f.id}">${IC.trash}</button>
        </div></td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>`
        : `<div class="empty"><p>No faculty match your search.</p></div>`
    }
  </div>
</div>

<!-- COURSES -->
<div class="page-section ${state.section === "courses" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Courses</h3><p>${courses.length} active courses</p></div>
      <div class="section-actions"><button class="btn btn-primary" id="addCourseBtn">${IC.plus} Add Course</button></div>
    </div>
    <div class="courses-grid">
      ${courses
        .map((c) => {
          const f = getFaculty(c.facultyId);
          return `<div class="course-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <div class="stat-icon" style="width:40px;height:40px;border-radius:12px">${IC.book}</div>
          <h4>${c.name}</h4>
        </div>
        ${f ? `<div class="faculty-row"><div class="faculty-avatar">${initials(f.name)}</div><span style="font-size:.85rem;color:var(--muted)">${f.name}</span></div>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <span class="pill pill-purple">${c.students.length} students</span>
          ${c.schedule.map((e) => `<span class="pill pill-gray">${e.day} ${e.slot}</span>`).join("")}
        </div>
      </div>`;
        })
        .join("")}
    </div>
  </div>
</div>

<!-- ANNOUNCEMENTS -->
<div class="page-section ${state.section === "announcements" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Announcements</h3><p>Create campus-wide updates for students</p></div>
      <div class="section-actions"><button class="btn btn-primary" id="addAnnouncementBtn">${IC.plus} New Announcement</button></div>
    </div>
    <div class="notice-list">
      ${db.announcements
        .slice()
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(
          (item) => `<div class="notice-card unread">
        <div class="notice-header">
          <div>
            <span class="pill ${item.priority === "Urgent" ? "pill-danger" : item.priority === "Info" ? "pill-info" : "pill-gray"}" style="margin-bottom:6px">${item.priority}</span>
            <div class="notice-title">${item.title}</div>
            <div class="notice-date">${fmtDate(item.date)} · ${item.createdByName}</div>
          </div>
          <button class="btn btn-danger btn-sm" data-delete-announcement="${item.id}">${IC.trash}</button>
        </div>
        <div class="notice-body">${item.body}</div>
      </div>`,
        )
        .join("")}
    </div>
  </div>
</div>

<!-- RESULTS -->
<div class="page-section ${state.section === "results" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Results</h3><p>Create and publish semester report cards</p></div>
      <div class="section-actions"><button class="btn btn-primary" id="addResultBtn">${IC.plus} Create Result</button></div>
    </div>
    ${
      reportRows.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Semester</th><th>Published</th><th>Average</th><th>GPA</th><th>Actions</th></tr></thead><tbody>
      ${reportRows
        .map(
          ({ student, card, metrics }) => `<tr>
        <td>${student.name}</td>
        <td>${card.semester}</td>
        <td>${fmtDate(card.publishedOn)}</td>
        <td>${metrics.avgMarks.toFixed(1)}</td>
        <td><span class="pill ${gradeColor(grade(metrics.avgMarks).g)}">${metrics.gpa.toFixed(2)}</span></td>
        <td><button class="btn btn-secondary btn-sm" data-download-card="${student.id}|${card.id}">${IC.export} Download</button></td>
      </tr>`,
        )
        .join("")}</tbody></table></div>`
        : `<div class="empty"><p>No report cards published yet.</p></div>`
    }
  </div>
</div>

<!-- REPORTS -->
<div class="page-section ${state.section === "reports" ? "active" : ""}">
  <div class="split-grid">
    <div class="section-card">
      <div class="section-head"><div><h3>Student Performance</h3><p>Average marks ranking</p></div></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Rank</th><th>Name</th><th>Course</th><th>Avg Mark</th><th>Grade</th></tr></thead><tbody>
        ${topStuds
          .map((s, i) => {
            const g2 = grade(s.avgMark);
            return `<tr style="${i === 0 ? "background:rgba(124,58,237,.04)" : ""}"><td><strong style="color:${["#f59e0b", "#94a3b8", "#cd7c2f"][i] || "var(--muted)"}">${["🥇", "🥈", "🥉"][i] || i + 1}</strong></td><td>${s.name}</td><td>${s.course}</td><td>${s.avgMark.toFixed(1)}</td><td><span class="pill ${gradeColor(g2.g)}">${g2.g}</span></td></tr>`;
          })
          .join("")}
      </tbody></table></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="section-card">
        <div class="section-head"><div><h3>Grade Distribution</h3><p>Across all recorded marks</p></div></div>
        ${gradeData
          .map((x) => {
            const pct = Math.round((x.count / totalGrades) * 100);
            return `<div class="grade-bar-item"><span class="grade-bar-label" style="color:${x.color};font-weight:800">${x.g}</span><div class="grade-bar-track"><div class="grade-bar-fill" style="width:${pct}%;background:${x.color}"></div></div><span class="grade-bar-pct">${x.count} (${pct}%)</span></div>`;
          })
          .join("")}
      </div>
      <div class="section-card">
        <div class="section-head"><div><h3>Attendance</h3></div></div>
        <div class="summary-list">${attSummary.map((i) => `<div class="summary-item"><div><strong>${i.label}</strong><small>${i.desc}</small></div><span class="pill ${i.cls}">${i.val}</span></div>`).join("")}</div>
      </div>
    </div>
  </div>
</div>

<div class="page-section ${state.section === "support" ? "active" : ""}">
  ${supportTabHtml()}
</div>

<!-- SETTINGS -->
<div class="page-section ${state.section === "settings" ? "active" : ""}">
  <div class="split-grid">
    <div class="section-card">
      <div class="section-head"><div><h3>Manage Subjects</h3><p>Add or remove system subjects</p></div></div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <input id="newSubjectInput" class="form-field input" style="flex:1;padding:10px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--palest);color:var(--text);outline:none" placeholder="New subject name..."/>
        <button class="btn btn-primary" id="addSubjectBtn">Add</button>
      </div>
      <div class="subject-chips" id="subjectChips">
        ${db.subjects.map((s, i) => `<span class="subject-chip">${s}<button class="chip-remove" data-remove-subj="${i}">✕</button></span>`).join("")}
      </div>
    </div>
    <div class="section-card">
      <div class="section-head"><div><h3>Grading Scale</h3><p>Academic reference bands</p></div></div>
      ${[
        ["A", "90–100", 4.0, "Excellent", "pill-success"],
        ["B", "80–89", 3.5, "Very Good", "pill-info"],
        ["C", "70–79", 3.0, "Good", "pill-warn"],
        ["D", "60–69", 2.0, "Needs Work", "pill-warn"],
        ["F", "Below 60", 0, "Fail", "pill-danger"],
      ]
        .map(
          ([g, r, p, rem, cls]) =>
            `<div class="grade-row"><div style="display:flex;align-items:center;gap:10px"><span class="pill ${cls}" style="min-width:32px;justify-content:center">${g}</span><div><strong>${r}</strong><div style="font-size:.78rem;color:var(--muted)">Points: ${p} · ${rem}</div></div></div></div>`,
        )
        .join("")}
    </div>
    <div class="section-card">
      <div class="section-head">
        <div><h3>System Preferences</h3><p>Manage application-wide settings</p></div>
      </div>
      <div class="form-grid">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" checked/> Enable Email Notifications</label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox"/> Maintenance Mode</label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer"><input type="checkbox" checked/> Allow Student Registration</label>
      </div>
      <div class="form-actions" style="margin-top:16px"><button class="btn btn-secondary" onclick="toast('Preferences saved!', 'success')">Save Preferences</button></div>
    </div>
    
    <div class="section-card">
      <div class="section-head">
        <div><h3>Administrators</h3><p>Manage system administrators</p></div>
        <div class="section-actions"><button class="btn btn-primary" id="addAdminBtn">+ Add Admin</button></div>
      </div>
      <p style="font-size:0.9rem; color:var(--muted); margin-bottom:12px;">Admin accounts have full access to the system. You can add more administrators from here.</p>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Actions</th></tr></thead><tbody>
        ${(db.admins && db.admins.length > 0 ? db.admins : [db.admin]).map(a => `<tr><td>${a.name}</td><td>${a.email}</td><td><button class="btn btn-sm btn-ghost" data-edit-a="${a.id}">Edit</button> <button class="btn btn-sm btn-ghost" data-del-a="${a.id}">Delete</button></td></tr>`).join("")}
      </tbody></table></div>
    </div>
  </div>
</div>`;
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // SUPPORT COMPONENT
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function supportContacts(tab = state.support.tab) {
        if (state.user.role === "admin" && tab === "admin") {
          return db.faculty.slice().sort((a, b) => a.name.localeCompare(b.name));
        }
        if (state.user.role === "faculty" && tab === "mentor") {
          return db.students
            .filter((student) => student.facultyId === state.user.id)
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        if (state.user.role === "student" && tab === "mentor") {
          const mentor = getFaculty(getStudent(state.user.id)?.facultyId);
          return mentor ? [mentor] : [];
        }
        return [];
      }

      function ensureSupportSelection(tab = state.support.tab) {
        if (state.user.role === "faculty" && tab === "mentor") {
          const contacts = supportContacts(tab);
          if (!contacts.length) {
            state.support.studentId = "";
            return;
          }
          if (!contacts.some((student) => student.id === state.support.studentId)) {
            state.support.studentId = contacts[0].id;
          }
        }

        if (state.user.role === "admin" && tab === "admin") {
          const contacts = supportContacts(tab);
          if (!contacts.length) {
            state.support.facultyId = "";
            return;
          }
          if (!contacts.some((faculty) => faculty.id === state.support.facultyId)) {
            state.support.facultyId = contacts[0].id;
          }
        }

        if (state.user.role === "faculty" && tab === "admin") {
          const contacts = supportContacts(tab);
          if (!contacts.length) {
            state.support.adminId = "";
            return;
          }
          if (!contacts.some((a) => a.id === state.support.adminId)) {
            state.support.adminId = contacts[0].id;
          }
        }
      }

      function supportMessagesHtml() {
        if (state.support.loading) {
          return `<div class="chat-msg other">Loading conversation...</div>`;
        }
        if (!state.support.messages.length) {
          return `<div class="chat-msg other">No messages yet. Start the conversation here.</div>`;
        }
        return state.support.messages
          .map((msg) => {
            const self = msg.sender_id === state.user.id;
            return `<div class="chat-msg ${self ? "self" : "other"}">
              <div>${esc(msg.body)}</div>
              <div class="chat-meta">${esc(self ? "You" : msg.sender_name || "Mentor")} · ${fmtDateTime(msg.created_at)}</div>
            </div>`;
          })
          .join("");
      }

      function supportHeaderText() {
        if (state.user.role === "student") {
          return {
            title: "Mentor Support",
            subtitle: state.support.counterpart
              ? `Chat with ${state.support.counterpart.name}`
              : "No mentor assigned yet",
          };
        }
        if (state.user.role === "faculty" && state.support.tab === "mentor") {
          return {
            title: "Student Chats",
            subtitle: state.support.counterpart
              ? `Chat with ${state.support.counterpart.name}`
              : "Select a student to begin",
          };
        }
        if (state.user.role === "faculty" && state.support.tab === "admin") {
          return {
            title: "Admin Chat",
            subtitle: state.support.counterpart
              ? `Chat with ${state.support.counterpart.name}`
              : "Admin contact unavailable",
          };
        }
        return {
          title: "Faculty Messages",
          subtitle: state.support.counterpart
            ? `Chat with ${state.support.counterpart.name}`
            : "Select a faculty member to begin",
        };
      }

      function supportSummaryItems(tab = state.support.tab) {
        if (tab === "mentor") return state.support.summary?.mentor || [];
        if (tab === "admin") return state.support.summary?.admin || [];
        return [];
      }

      function supportSectionHtml() {
        return `<div class="page-section ${state.section === "support" ? "active" : ""}">
  ${supportTabHtml()}
</div>`;
      }

      function focusSearchInput(id, value) {
        requestAnimationFrame(() => {
          const input = byId(id);
          if (!input) return;
          input.focus();
          input.value = value;
          input.setSelectionRange(value.length, value.length);
        });
      }

      function supportTabHtml() {
        const role = state.user.role;
        const isFaculty = role === "faculty";
        const isAdmin = role === "admin";
        const tab = state.support.tab;
        const contacts = supportContacts(tab);
        const summaryItems = supportSummaryItems(tab);
        const counterpart = state.support.counterpart;
        const header = supportHeaderText();
        const showContactList = (isFaculty && tab === "mentor") || (isAdmin && tab === "admin");
        const activeLabel =
          role === "student"
            ? "Contact Mentor"
            : tab === "mentor"
              ? "Student Chats"
              : "Admin Chat";

        return `
  <div class="support-tabs">
    ${role !== "admin" ? `<button class="sup-tab ${tab === "mentor" ? "active" : ""}" onclick="switchSupportTab('mentor')">${activeLabel}</button>` : ""}
    ${role === "faculty" ? `<button class="sup-tab ${tab === "admin" ? "active" : ""}" onclick="switchSupportTab('admin')">Admin Chat</button>` : ""}
    ${role === "admin" ? `<button class="sup-tab ${tab === "admin" ? "active" : ""}" onclick="switchSupportTab('admin')">Faculty Messages</button>` : ""}
    ${role !== "admin" ? `<button class="sup-tab ${tab === "ai" ? "active" : ""}" onclick="switchSupportTab('ai')">AI Learning</button>` : ""}
  </div>
  
  <div id="supMentor" class="section-card" style="display:${tab !== "ai" ? "block" : "none"}">
    <div class="section-head">
      <div><h3>${header.title}</h3><p>${header.subtitle}</p></div>
      ${
        counterpart
          ? `<div style="text-align:right">
        <div style="font-size:0.9rem;color:var(--text)">Email: <strong>${esc(counterpart.email || "—")}</strong></div>
        <div style="font-size:0.9rem;color:var(--muted)">${
          tab === "mentor" && isFaculty
            ? `${esc(counterpart.course || "")}${counterpart.year ? ` · ${esc(counterpart.year)}` : ""}`
            : esc(counterpart.department || "")
        }${counterpart.phone ? ` · ${esc(counterpart.phone)}` : ""}</div>
      </div>`
          : ""
      }
    </div>
    ${
      showContactList
        ? `<div class="support-layout">
      <div class="support-contact-list">
        ${
          contacts.length
            ? contacts
                .map(
                  (contact) => {
                    const summary = summaryItems.find((item) => item.id === contact.id);
                    const preview = summary?.lastMessage?.body || (isAdmin ? "No messages yet" : "Start the conversation");
                    const unread = summary?.unread || 0;
                    return `<button class="support-contact ${
                    (isAdmin ? state.support.facultyId : (isFaculty && tab === "admin" ? state.support.adminId : state.support.studentId)) === contact.id ? "active" : ""
                  }" ${
                    isAdmin ? `data-support-faculty="${contact.id}"` : 
                    (isFaculty && tab === "admin" ? `data-support-admin="${contact.id}"` : `data-support-student="${contact.id}"`)
                  }>
            <div class="support-contact-head"><strong>${esc(contact.name)}</strong>${unread ? `<span class="support-unread">${unread}</span>` : ""}</div>
            <div class="support-contact-meta">${
              isAdmin
                ? esc(contact.department || contact.email || "")
                : isFaculty && tab === "admin"
                  ? esc(contact.email || "Administrator")
                  : `${esc(contact.course)} · ${esc(contact.year)}`
            }</div>
            <div class="support-preview">${esc(preview)}</div>
          </button>`;
                  },
                )
                .join("")
            : `<div class="empty"><p>${isAdmin ? "No faculty available yet." : isFaculty && tab === "admin" ? "No admins available yet." : "No students are assigned to you yet."}</p></div>`
        }
      </div>
      <div class="chat-box">`
        : `<div class="chat-box">`
    }
      <div class="chat-history" id="${tab}ChatHistory">
        ${supportMessagesHtml()}
      </div>
      <form class="chat-input" id="mentorChatForm">
        <input type="text" id="${tab}Input" placeholder="${
          counterpart
            ? "Type your message..."
            : role === "student"
              ? "Assign a mentor first"
              : role === "faculty" && tab === "mentor"
                ? "No student selected"
                : role === "faculty" && tab === "admin"
                  ? "No admin selected"
                  : role === "admin"
                    ? "No faculty selected"
                    : "Admin contact unavailable"
        }" value="${esc(tab === "admin" ? (state.support.adminDraft || "") : (state.support.mentorDraft || ""))}" ${counterpart ? "" : "disabled"} required autocomplete="off"/>
        <button type="submit" class="btn btn-primary" style="padding:0 24px;border-radius:999px" ${counterpart ? "" : "disabled"}>Send</button>
      </form>
    ${showContactList ? `</div></div>` : `</div>`}
  </div>

  <div id="supAi" class="section-card" style="display:${tab === "ai" ? "block" : "none"}">
    <div class="section-head"><div><h3>AI Learning Assistant</h3><p>Ask anything about your studies</p></div></div>
    <div class="chat-box">
      <div class="chat-history" id="aiChatHistory">
        <div class="chat-msg other">Hi! I'm your AI tutor. Ask me to explain a concept or help with a topic.</div>
      </div>
      <form class="chat-input" id="aiChatForm">
        <input type="text" id="aiInput" placeholder="Ask AI a question..." value="${esc(state.support.aiDraft || "")}" required autocomplete="off"/>
        <button type="submit" class="btn btn-primary" style="padding:0 24px;border-radius:999px;background:var(--p);color:#fff;border:none">Ask AI</button>
      </form>
    </div>
  </div>
`;
      }

      async function loadSupportMessages(isPolling = false) {
        if (!["student", "faculty", "admin"].includes(state.user.role)) return;
        if (state.support.tab === "ai") return;
        ensureSupportSelection(state.support.tab);
        state.support.loading = true;
        const activeInputId = document.activeElement?.id;
        try {
          let payload;
          if (state.support.tab === "mentor") {
            const query =
              state.user.role === "faculty" && state.support.studentId
                ? `?studentId=${encodeURIComponent(state.support.studentId)}`
                : "";
            payload = await apiRequest(`/api/support/messages${query}`);
          } else {
            const query =
              state.user.role === "admin" && state.support.facultyId
                ? `?facultyId=${encodeURIComponent(state.support.facultyId)}`
                : state.user.role === "faculty" && state.support.adminId
                  ? `?adminId=${encodeURIComponent(state.support.adminId)}`
                  : "";
            payload = await apiRequest(`/api/support/admin-messages${query}`);
          }
          state.support.counterpart = payload.counterpart;
          state.support.messages = payload.messages || [];
          await loadSupportSummary();
        } catch (error) {
          state.support.counterpart = null;
          state.support.messages = [];
          if (state.section === "support") toast(error.message || "Unable to load conversation.", "error");
        } finally {
          state.support.loading = false;
          if (state.section === "support") {
            const historyDiv = byId(state.support.tab + "ChatHistory");
            if (isPolling && historyDiv) {
              historyDiv.innerHTML = supportMessagesHtml();
            } else {
              renderSections();
              setTimeout(() => {
                const hist = byId(state.support.tab + "ChatHistory");
                hist?.scrollTo(0, hist.scrollHeight);
                if (activeInputId === "mentorInput" || activeInputId === "aiInput" || activeInputId === "adminInput") {
                  const input = byId(activeInputId);
                  if (input) {
                    input.focus();
                    const value = input.value;
                    input.setSelectionRange(value.length, value.length);
                  }
                }
              }, 10);
            }
          }
        }
      }

      window.switchSupportTab = function(tab) {
        state.support.tab = tab;
        renderSections();
        if (tab !== "ai") {
          loadSupportMessages();
        }
      };

      window.sendMessage = function(type) {
        const inp = byId(type + "Input");
        const hist = byId(type + "ChatHistory");
        const text = inp.value.trim();
        if (!text) return;
        hist.innerHTML += `<div class="chat-msg self"><div>${esc(text)}</div></div>`;
        inp.value = "";
        if (type === "ai") state.support.aiDraft = "";
        setTimeout(() => {
          hist.scrollTo(0, hist.scrollHeight);
        }, 10);
        if (type !== "ai") return;
        const loadingId = `ai-loading-${Date.now()}`;
        hist.innerHTML += `<div class="chat-msg other" id="${loadingId}"><div>Thinking...</div></div>`;
        setTimeout(() => {
          hist.scrollTo(0, hist.scrollHeight);
        }, 10);
        apiRequest("/api/ai-chat", {
          method: "POST",
          body: JSON.stringify({ message: text }),
        })
          .then((result) => {
            const loading = byId(loadingId);
            if (loading) {
              loading.outerHTML = `<div class="chat-msg other"><div>${esc(result.reply)}</div></div>`;
            } else {
              hist.innerHTML += `<div class="chat-msg other"><div>${esc(result.reply)}</div></div>`;
            }
          })
          .catch((error) => {
            const loading = byId(loadingId);
            const fallback = `<div class="chat-msg other"><div>${esc(error.message || "AI service is unavailable right now.")}</div></div>`;
            if (loading) loading.outerHTML = fallback;
            else hist.innerHTML += fallback;
          })
          .finally(() => {
            setTimeout(() => {
              hist.scrollTo(0, hist.scrollHeight);
            }, 10);
          });
      };

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // FACULTY SECTIONS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function facultySections() {
        const fid = state.user.id;
        const myCourses = db.courses.filter((c) => c.facultyId === fid);
        const mentoredStudentIds = db.students
          .filter((student) => student.facultyId === fid)
          .map((student) => student.id);
        const myStudentIds = [...new Set([...myCourses.flatMap((c) => c.students), ...mentoredStudentIds])];
        const myStudents = myStudentIds.map(getStudent).filter(Boolean);
        const visibleAnnouncements = db.announcements.filter(
          (item) =>
            item.createdByRole === "admin" ||
            item.createdByUserId === fid ||
            (item.createdByRole === "faculty" && item.createdByName === state.user.name),
        );
        const myAnnouncements = visibleAnnouncements.filter(
          (item) => item.createdByRole === "faculty" && item.createdByUserId === fid,
        );
        const latestAnnouncements = visibleAnnouncements
          .slice()
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 3);
        const myAssignments = db.assignments.filter((item) =>
          myCourses.some((course) => course.id === item.courseId),
        );
        const avgAtt = Math.round(
          avg(
            myStudents.flatMap((s) =>
              myCourses.map((c) => db.attendance[s.id]?.[c.id]).filter(Boolean),
            ),
          ) || 0,
        );

        const firstCourse = myCourses[0];
        const markCourseId = firstCourse?.id || "";
        const attCourseId = firstCourse?.id || "";
        const todayStr = new Date().toISOString().slice(0, 10);

        function markRows(cid) {
          const c = getCourse(cid);
          if (!c) return '<div class="empty"><p>No course selected.</p></div>';
          const studs = c.students.map(getStudent).filter(Boolean);
          return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Course</th><th>Marks (0–100)</th><th>Grade</th></tr></thead><tbody>
      ${studs
        .map((s) => {
          const m = db.marks[s.id]?.[cid];
          const g2 = m != null ? grade(m) : null;
          return `<tr><td>${s.name}</td><td>${c.name}</td><td><input class="mark-input" data-ms="${s.id}" data-mc="${cid}" type="number" min="0" max="100" value="${m ?? ""}" oninput="previewGrade(this,'${s.id}','${cid}')"/></td><td><span id="gshow-${s.id}-${cid}" class="pill ${g2 ? gradeColor(g2.g) : "pill-gray"}">${g2 ? g2.g : "—"}</span></td></tr>`;
        })
        .join("")}
    </tbody></table></div>`;
        }

        function attRows(cid, date) {
          const c = getCourse(cid);
          if (!c) return '<div class="empty"><p>No course selected.</p></div>';
          const sk = `${cid}_${date}`;
          if (!db.attendanceSessions[sk])
            db.attendanceSessions[sk] = Object.fromEntries(
              c.students.map((id) => [id, true]),
            );
          const sess = db.attendanceSessions[sk];
          const presentCount = Object.values(sess).filter(Boolean).length;
          return `<div style="margin-bottom:12px;font-size:.88rem;color:var(--muted)">
      <strong style="color:var(--text)">${presentCount}</strong> present · <strong style="color:var(--danger)">${c.students.length - presentCount}</strong> absent out of ${c.students.length}
    </div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Status</th></tr></thead><tbody>
      ${c.students
        .map((sid) => {
          const s = getStudent(sid);
          const present = sess[sid];
          return `<tr><td>${s?.name || sid}</td><td><button class="btn btn-sm ${present ? "btn-secondary" : "btn-danger"}" data-tog="${sid}" data-sk="${sk}">${present ? "✓ Present" : "✗ Absent"}</button></td></tr>`;
        })
        .join("")}
    </tbody></table></div>`;
        }

        return `
<div class="page-section ${state.section === "dashboard" ? "active" : ""}">
  <div class="stats-grid">
    ${statCard("users", myStudents.length, "My Students")}
    ${statCard("book", myCourses.length, "Courses", "#16a34a")}
    ${statCard("activity", avgAtt + "%", "Avg Attendance", "#d97706")}
    ${statCard("bell", visibleAnnouncements.length, "Announcements", "#0284c7")}
  </div>
  <div class="split-grid">
    <div class="section-card">
      <div class="section-head"><div><h3>Upcoming Assignments</h3><p>Tasks shared with your classes</p></div></div>
      ${
        myAssignments.length
          ? `<div class="notice-list">
        ${myAssignments
          .slice()
          .sort((a, b) => new Date(a.submissionDate) - new Date(b.submissionDate))
          .slice(0, 3)
          .map((item) => `<div class="notice-card unread">
          <div class="notice-header"><div><div class="notice-title">${item.topic}</div><div class="notice-date">${getCourse(item.courseId)?.name || item.courseId} · Due ${fmtDate(item.submissionDate)}</div></div></div>
          <div class="notice-body">${item.details}</div>
        </div>`)
          .join("")}
      </div>`
          : `<div class="empty"><p>No assignments created yet.</p></div>`
      }
    </div>
    <div class="section-card">
      <div class="section-head"><div><h3>Latest Announcements</h3><p>Updates from admin and your own notices</p></div></div>
      ${
        latestAnnouncements.length
          ? `<div class="notice-list">
        ${latestAnnouncements
          .map((item) => `<div class="notice-card unread">
          <div class="notice-header"><div><div class="notice-title">${item.title}</div><div class="notice-date">${fmtDate(item.date)} · ${item.createdByRole === "admin" ? "Admin" : "You"}</div></div></div>
          <div class="notice-body">${item.body}</div>
        </div>`)
          .join("")}
      </div>`
          : `<div class="empty"><p>No announcements posted yet.</p></div>`
      }
    </div>
  </div>
</div>

<div class="page-section ${state.section === "my-courses" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>My Courses</h3><p>Manage your course timetable and lecture slots</p></div>
    </div>
    ${
      myCourses.length
        ? `<div style="display:grid;gap:16px">
      ${myCourses
        .map(
          (course) => `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:18px;background:var(--palest)">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px">
          <div>
            <h4 style="font-family:var(--font);margin-bottom:4px">${course.name}</h4>
            <div style="font-size:.88rem;color:var(--muted)">${course.students.length} enrolled student${course.students.length !== 1 ? "s" : ""}</div>
          </div>
          <button class="btn btn-primary btn-sm" data-add-lecture="${course.id}">${IC.plus} Add Schedule</button>
        </div>
        ${
          course.schedule.length
            ? `<div style="display:grid;gap:10px">
          ${course.schedule
            .map(
              (lecture) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px">
            <div>
              <strong>${lecture.title || "Lecture"}</strong>
              <div style="font-size:.85rem;color:var(--muted)">${lecture.day} · ${lecture.slot}</div>
            </div>
            <div class="actions-cell">
              <button class="btn btn-secondary btn-sm" data-edit-lecture="${course.id}|${lecture.id}">${IC.edit} Edit</button>
              <button class="btn btn-danger btn-sm" data-remove-lecture="${course.id}|${lecture.id}">${IC.trash}</button>
            </div>
          </div>`,
            )
            .join("")}
        </div>`
            : `<div class="empty"><p>No schedule added yet for this course.</p></div>`
        }
      </div>`,
        )
        .join("")}
    </div>`
        : `<div class="empty"><p>No courses assigned yet.</p></div>`
    }
  </div>
</div>

<div class="page-section ${state.section === "my-students" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>My Students</h3><p>Marks & attendance across your classes</p></div></div>
    ${
      myStudents.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Course</th><th>Marks</th><th>Attendance</th></tr></thead><tbody>
      ${myStudents.flatMap((s) => {
        const assignedCourses = myCourses.filter((c) => c.students.includes(s.id));
        if (!assignedCourses.length) {
          return [`<tr><td>${s.name}</td><td>${s.course || "Mentor Assigned"}</td><td>—</td><td>—</td></tr>`];
        }
        return assignedCourses.map((c) => `<tr><td>${s.name}</td><td>${c.name}</td><td>${db.marks[s.id]?.[c.id] ?? "—"}</td><td>${db.attendance[s.id]?.[c.id] ? db.attendance[s.id][c.id] + "%" : "—"}</td></tr>`);
      }).join("")}
    </tbody></table></div>`
        : `<div class="empty"><p>No students assigned yet.</p></div>`
    }
  </div>
</div>

<div class="page-section ${state.section === "upload-marks" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Upload Marks</h3><p>Update marks for your assigned courses</p></div>
      <div class="section-actions">
        <select id="markCourseSelect" class="btn btn-ghost" style="padding:9px 14px">${myCourses.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
        <button class="btn btn-primary" id="saveMarksBtn">${IC.save} Save All</button>
      </div>
    </div>
    <div id="markTableHost">${markRows(markCourseId)}</div>
  </div>
</div>

<div class="page-section ${state.section === "attendance" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Attendance</h3><p>Mark attendance for a class session</p></div>
      <div class="section-actions">
        <select id="attCourseSelect" class="btn btn-ghost" style="padding:9px 14px">${myCourses.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
        <input id="attDateInput" type="date" value="${todayStr}" class="btn btn-ghost" style="padding:9px 14px"/>
        <button class="btn btn-primary" id="saveAttBtn">Submit</button>
      </div>
    </div>
    <div id="attTableHost">${attRows(attCourseId, todayStr)}</div>
  </div>
</div>

<div class="page-section ${state.section === "schedule" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>Weekly Schedule</h3><p>Your teaching timetable</p></div></div>
    ${renderTT(myCourses)}
    <div style="display:grid;gap:16px;margin-top:18px">
      ${myCourses
        .map(
          (course) => `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:18px;background:var(--palest)">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:12px">
          <div>
            <h4 style="font-family:var(--font);margin-bottom:4px">${course.name}</h4>
            <div style="font-size:.88rem;color:var(--muted)">${course.students.length} enrolled student${course.students.length !== 1 ? "s" : ""}</div>
          </div>
          <button class="btn btn-primary btn-sm" data-add-lecture="${course.id}">${IC.plus} Add Lecture</button>
        </div>
        <div style="display:grid;gap:10px">
          ${course.schedule
            .map(
              (lecture) => `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px">
            <div>
              <strong>${lecture.title || "Lecture"}</strong>
              <div style="font-size:.85rem;color:var(--muted)">${lecture.day} · ${lecture.slot}</div>
            </div>
            <div class="actions-cell">
              <button class="btn btn-secondary btn-sm" data-edit-lecture="${course.id}|${lecture.id}">${IC.edit} Edit</button>
              <button class="btn btn-danger btn-sm" data-remove-lecture="${course.id}|${lecture.id}">${IC.trash}</button>
            </div>
          </div>`,
            )
            .join("")}
        </div>
      </div>`,
        )
        .join("")}
    </div>
  </div>
</div>

<div class="page-section ${state.section === "assignments" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Assignments</h3><p>Create assignments for your students</p></div>
      <div class="section-actions"><button class="btn btn-primary" id="addAssignmentBtn">${IC.plus} New Assignment</button></div>
    </div>
    ${
      myAssignments.length
        ? `<div class="notice-list">
      ${myAssignments
        .slice()
        .sort((a, b) => new Date(a.submissionDate) - new Date(b.submissionDate))
        .map((item) => `<div class="notice-card unread">
        <div class="notice-header">
          <div>
            <div class="notice-title">${item.topic}</div>
            <div class="notice-date">${getCourse(item.courseId)?.name || item.courseId} · Due ${fmtDate(item.submissionDate)}</div>
          </div>
          <button class="btn btn-danger btn-sm" data-delete-assignment="${item.id}">${IC.trash}</button>
        </div>
        <div class="notice-body">${item.details}</div>
      </div>`)
        .join("")}
    </div>`
        : `<div class="empty"><p>No assignments created yet.</p></div>`
    }
  </div>
</div>

<div class="page-section ${state.section === "announcements" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Announcements</h3><p>Share notices with all students</p></div>
      <div class="section-actions"><button class="btn btn-primary" id="addFacultyAnnouncementBtn">${IC.plus} New Announcement</button></div>
    </div>
    ${
      visibleAnnouncements.length
        ? `<div class="notice-list">
      ${visibleAnnouncements
        .slice()
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map((item) => `<div class="notice-card unread">
        <div class="notice-header"><div><div class="notice-title">${item.title}</div><div class="notice-date">${fmtDate(item.date)} · ${item.priority} · ${item.createdByRole === "admin" ? "Admin" : "Faculty"}</div></div>${item.createdByRole === "admin" || item.createdByUserId === state.user.id ? `<button class="btn btn-danger btn-sm" data-delete-announcement="${item.id}">${IC.trash}</button>` : ""}</div>
        <div class="notice-body">${item.body}</div>
      </div>`)
        .join("")}
    </div>`
        : `<div class="empty"><p>No announcements posted yet.</p></div>`
    }
  </div>
</div>

<div class="page-section ${state.section === "profile" ? "active" : ""}">
  <div class="profile-layout">
    <div class="profile-card">
      <div class="avatar avatar-lg">${initials(state.user.name)}</div>
      <div class="profile-name">${state.user.name}</div>
      <div style="color:var(--muted);font-size:.9rem">${state.user.department}</div>
      <span class="pill pill-purple">${state.user.id}</span>
      <p style="font-size:.88rem;color:var(--muted);line-height:1.6;text-align:center">${state.user.bio || ""}</p>
    </div>
    <div class="section-card">
      <div class="section-head"><div><h3>Edit Profile</h3><p>Keep your information current</p></div></div>
      <form id="profileForm">
        <div class="form-grid">
          ${ff("Full Name", "pName", state.user.name)}
          ${ff("Email", "pEmail", state.user.email, "email")}
          ${ff("Phone", "pPhone", state.user.phone)}
          ${ff("Department", "pDept", state.user.department)}
          ${fta("Bio", "pBio", state.user.bio || "")}
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${IC.save} Save Profile</button></div>
      </form>
    </div>
  </div>
</div>` + supportSectionHtml();
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // STUDENT SECTIONS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function heatmapHTML(studentId) {
        return `<div class="heatmap-wrap">
    <div class="heatmap-title">30-Day Attendance Heatmap</div>
    <div class="empty" style="margin-top:10px"><p>No daily attendance trend available yet.</p></div>
  </div>`;
      }

      function studentSections() {
        const s = getStudent(state.user.id);
        if (!s)
          return `<div class="section-card"><div class="empty"><p>Student data not found.</p></div></div>`;
        const courses = getStudentCourses(s.id);
        const availableCourses = getAvailableCourses(s.id);
        const marks = db.marks[s.id] || {};
        const assignments = getStudentAssignments(s.id).sort(
          (a, b) => new Date(a.submissionDate) - new Date(b.submissionDate),
        );
        const reportCards = getStudentReportCards(s.id).slice().sort(
          (a, b) => new Date(b.publishedOn) - new Date(a.publishedOn),
        );
        const announcements = db.announcements
          .slice()
          .sort((a, b) => new Date(b.date) - new Date(a.date));
        const results = Object.entries(marks).map(([cid, m]) => ({
          subj: getCourse(cid)?.name || cid,
          mark: m,
          ...grade(m),
        }));
        const gpa = avg(results.map((r) => r.p));
        const attVals = Object.values(db.attendance[s.id] || {});
        const attAvg = Math.round(avg(attVals) || 0);
        const unread = db.notifications.filter(
          (n) => !n.readBy.includes(s.id),
        ).length;

        const gpaMax = 4;
        const gpaW = 300,
          gpaH = 80;
        const gpaTrendSource = reportCards.length
          ? reportCards
              .slice()
              .sort((a, b) => new Date(a.publishedOn) - new Date(b.publishedOn))
              .map((card, index) => ({
                label: card.semester || `Report ${index + 1}`,
                value: Number(reportCardMetrics(card).gpa.toFixed(2)),
              }))
          : Number.isFinite(gpa) && gpa > 0
            ? [{ label: "Current", value: Number(gpa.toFixed(2)) }]
            : [];
        const xStep = gpaTrendSource.length > 1 ? gpaW / (gpaTrendSource.length - 1) : 0;
        const pts = gpaTrendSource.map((point, i) => ({
          ...point,
          x: 20 + i * xStep,
          y: gpaH - (point.value / gpaMax) * gpaH + 8,
        }));
        const pathD = pts.length
          ? pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")
          : "";

        return `
<div class="page-section ${state.section === "dashboard" ? "active" : ""}">
  <div class="stats-grid">
    ${statCard("book", courses.length, "Enrolled Courses")}
    ${statCard("activity", attAvg + "%", "Attendance", "#16a34a")}
    ${statCard("chart", gpa ? gpa.toFixed(2) : "0.00", "GPA", "#d97706")}
    ${statCard("bell", announcements.length, "Announcements", "#0284c7")}
  </div>
  <div class="split-grid">
    <div class="section-card">
      <div class="section-head"><div><h3>My Courses</h3></div></div>
      <div class="courses-grid">
        ${courses
          .map((c) => {
            const f = getFaculty(c.facultyId);
            return `<div class="course-card">
          <h4>${c.name}</h4>
          ${f ? `<div class="faculty-row"><div class="faculty-avatar">${initials(f.name)}</div><span style="font-size:.82rem;color:var(--muted)">${f.name}</span></div>` : ""}
          ${c.schedule.map((e) => `<span class="pill pill-gray" style="font-size:.75rem">${e.day} ${e.slot}</span>`).join(" ")}
        </div>`;
          })
          .join("")}
      </div>
    </div>
    <div class="section-card">
      <div class="section-head"><div><h3>Recent Announcements</h3><p>${announcements.length} total</p></div></div>
      <div class="notice-list">
        ${announcements
          .slice(0, 2)
          .map(
            (n) => `<div class="notice-card unread">
          <div class="notice-header"><div class="notice-title">${n.title}</div><span class="pill ${n.priority === "Urgent" ? "priority-urgent pill-danger" : n.priority === "Info" ? "priority-info pill-info" : "pill-gray"}">${n.priority}</span></div>
          <div class="notice-body">${n.body.slice(0, 90)}...</div>
        </div>`,
          )
          .join("")}
      </div>
    </div>
  </div>
</div>

<div class="page-section ${state.section === "my-details" ? "active" : ""}">
  <div class="profile-layout">
    <div class="profile-card">
      <div class="avatar avatar-lg">${initials(s.name)}</div>
      <div class="profile-name">${s.name}</div>
      <code style="font-size:.85rem;color:var(--muted)">${s.id}</code>
      <span class="pill ${s.status === "Active" ? "pill-success" : "pill-gray"}">${s.status}</span>
    </div>
    <div class="section-card">
      <div class="section-head">
        <div><h3>Student Profile</h3><p>Academic and contact information</p></div>
        <div class="section-actions"><button class="btn btn-secondary" id="editMyDetailsBtn">${IC.edit} Edit Details</button></div>
      </div>
      <div class="meta-grid">
        <div class="meta-box"><small>Course</small><strong>${s.course}</strong></div>
        <div class="meta-box"><small>Year</small><strong>${s.year}</strong></div>
        <div class="meta-box"><small>Email</small><strong style="font-size:.88rem">${s.email}</strong></div>
        <div class="meta-box"><small>Phone</small><strong>${s.phone}</strong></div>
        <div class="meta-box"><small>Gender</small><strong>${s.gender}</strong></div>
        <div class="meta-box"><small>Date of Birth</small><strong>${fmtDate(s.dob || "2002-01-01")}</strong></div>
        <div class="meta-box"><small>Address</small><strong>${s.address || "—"}</strong></div>
        <div class="meta-box"><small>Faculty Mentor</small><strong style="font-size:.88rem">${getFaculty(s.facultyId)?.name || "—"}</strong></div>
      </div>
    </div>
  </div>
</div>

<div class="page-section ${state.section === "my-courses" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>My Courses</h3><p>${courses.length} enrolled</p></div></div>
    <div class="courses-grid">
      ${courses
        .map((c) => {
          const f = getFaculty(c.facultyId);
          return `<div class="course-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><div class="stat-icon" style="width:38px;height:38px;border-radius:10px">${IC.book}</div><h4>${c.name}</h4></div>
        ${f ? `<div class="faculty-row"><div class="faculty-avatar">${initials(f.name)}</div><span style="font-size:.84rem;color:var(--muted)">${f.name} · ${f.department}</span></div>` : ""}
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${c.schedule.map((e) => `<span class="pill pill-purple">${e.day} ${e.slot}</span>`).join("")}
          <span class="pill pill-gray">${c.students.length} enrolled</span>
        </div>
        <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px;display:flex;justify-content:center" onclick="document.getElementById('acc-${c.id}').classList.toggle('open')">View Lectures ▼</button>
        <div id="acc-${c.id}" class="lec-acc">
          ${c.schedule.map((lecture, index) => {
             const key = `${s.id}_${c.id}_${lecture.id}`;
             const seen = db.lectureStatus[key];
             return `<div class="lec-item ${seen ? 'seen' : ''}">
               <span>Lecture ${index + 1}: ${lecture.title} · ${lecture.day} ${lecture.slot}</span>
               <button class="btn btn-sm ${seen ? 'btn-ghost' : 'btn-primary'}" data-tog-lec="${key}">${seen ? '✓ Seen' : 'Mark Seen'}</button>
             </div>`;
          }).join("")}
        </div>
      </div>`;
        })
        .join("")}
    </div>
    <div class="section-head" style="margin-top:26px"><div><h3>Available Courses</h3><p>${availableCourses.length} open for enrollment</p></div></div>
    ${
      availableCourses.length
        ? `<div class="courses-grid">
      ${availableCourses
        .map((c) => {
          const f = getFaculty(c.facultyId);
          return `<div class="course-card">
        <h4>${c.name}</h4>
        ${f ? `<div class="faculty-row"><div class="faculty-avatar">${initials(f.name)}</div><span style="font-size:.84rem;color:var(--muted)">${f.name}</span></div>` : ""}
        <div style="display:flex;gap:6px;flex-wrap:wrap">${c.schedule.map((e) => `<span class="pill pill-gray">${e.day} ${e.slot}</span>`).join("")}</div>
        <button class="btn btn-primary btn-sm" style="width:100%;margin-top:14px;display:flex;justify-content:center" data-enroll-course="${c.id}">Enroll Now</button>
      </div>`;
        })
        .join("")}
    </div>`
        : `<div class="empty"><p>You are already enrolled in all available courses.</p></div>`
    }
  </div>
</div>

<div class="page-section ${state.section === "assignments" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>Assignments</h3><p>${assignments.length} active assignment${assignments.length !== 1 ? "s" : ""}</p></div></div>
    ${
      assignments.length
        ? `<div class="notice-list">
      ${assignments
        .map((item) => `<div class="notice-card unread">
        <div class="notice-header">
          <div>
            <div class="notice-title">${item.topic}</div>
            <div class="notice-date">${getCourse(item.courseId)?.name || item.courseId} · Due ${fmtDate(item.submissionDate)}</div>
          </div>
          <span class="pill pill-info">Assignment</span>
        </div>
        <div class="notice-body">${item.details}</div>
      </div>`)
        .join("")}
    </div>`
        : `<div class="empty"><p>No assignments available right now.</p></div>`
    }
  </div>
</div>

<div class="page-section ${state.section === "results" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head">
      <div><h3>Results</h3><p>Subject-wise marks and grades</p></div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="background:linear-gradient(135deg,var(--p),var(--pl));color:#fff;border-radius:var(--radius-sm);padding:10px 20px;text-align:center">
          <div style="font-size:.75rem;opacity:.8">Current GPA</div>
          <div style="font-family:var(--font);font-size:1.8rem;font-weight:800">${gpa ? gpa.toFixed(2) : "0.00"}</div>
        </div>
      </div>
    </div>
    <div style="display:grid;gap:14px;margin-bottom:18px">
      ${
        reportCards.length
          ? reportCards
              .map((card) => {
                const metrics = reportCardMetrics(card);
                return `<div style="border:1px solid var(--border);border-radius:var(--radius);padding:18px;background:var(--palest)">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
            <div>
              <h4 style="font-family:var(--font)">${card.semester}</h4>
              <div style="font-size:.86rem;color:var(--muted)">Published ${fmtDate(card.publishedOn)}</div>
            </div>
            <button class="btn btn-secondary btn-sm" data-download-card="${s.id}|${card.id}">${IC.export} Download Report Card</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">
            <span class="pill pill-purple">Avg ${metrics.avgMarks.toFixed(1)}</span>
            <span class="pill ${gradeColor(grade(metrics.avgMarks).g)}">GPA ${metrics.gpa.toFixed(2)}</span>
          </div>
          <div style="font-size:.9rem;color:var(--text)">${card.remarks}</div>
        </div>`;
              })
              .join("")
          : `<div class="empty"><p>No semester report cards published yet.</p></div>`
      }
    </div>
    ${
      results.length
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th>Marks</th><th>Max</th><th>Grade</th><th>Remarks</th></tr></thead><tbody>
      ${results.map((r) => `<tr style="${r.g === "A" ? "background:rgba(22,163,74,.04)" : r.g === "F" ? "background:rgba(220,38,38,.04)" : ""}"><td>${r.subj}</td><td><strong>${r.mark}</strong></td><td>100</td><td><span class="pill ${gradeColor(r.g)}">${r.g}</span></td><td>${r.r}</td></tr>`).join("")}
    </tbody></table></div>`
        : `<div class="empty"><p>No results recorded yet.</p></div>`
    }
    <div class="gpa-chart">
      <div style="font-weight:700;font-size:.9rem;margin-bottom:8px">GPA Trend</div>
      ${
        pts.length
          ? `<svg viewBox="0 0 320 96" width="100%" style="max-width:360px">
        <line x1="20" y1="${8}" x2="20" y2="${gpaH + 8}" stroke="var(--border)" stroke-width="1"/>
        ${[0, 1, 2, 3, 4].map((v) => `<text x="14" y="${gpaH + 8 - (v / gpaMax) * gpaH}" fill="var(--muted)" font-size="9" text-anchor="end" dominant-baseline="middle">${v}</text><line x1="20" y1="${gpaH + 8 - (v / gpaMax) * gpaH}" x2="${gpaW}" y2="${gpaH + 8 - (v / gpaMax) * gpaH}" stroke="var(--border)" stroke-width=".5"/>`).join("")}
        ${pts.length > 1 ? `<path d="${pathD}" fill="none" stroke="var(--pl)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="stroke-dasharray:300;stroke-dashoffset:300;animation:drawLine 1.2s ease forwards"/>` : ""}
        ${pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--p)"/><text x="${p.x}" y="${p.y - 10}" fill="var(--p)" font-size="10" text-anchor="middle" font-weight="bold">${p.value.toFixed(2)}</text>`).join("")}
        ${pts.map((p) => `<text x="${p.x}" y="${gpaH + 22}" fill="var(--muted)" font-size="9" text-anchor="middle">${esc(p.label)}</text>`).join("")}
      </svg>
      `
          : `<div class="empty"><p>No GPA trend available yet. Publish report cards or add marks to see progress over time.</p></div>`
      }
    </div>
  </div>
</div>

<div class="page-section ${state.section === "schedule" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>Weekly Schedule</h3><p>Your enrolled class timetable</p></div></div>
    ${renderTT(courses)}
  </div>
</div>

<div class="page-section ${state.section === "announcements" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>Announcements</h3><p>Latest updates from admin and faculty</p></div></div>
    <div class="notice-list">
      ${announcements
        .map((item) => `<div class="notice-card unread">
        <div class="notice-header">
          <div>
            <span class="pill ${item.priority === "Urgent" ? "pill-danger" : item.priority === "Info" ? "pill-info" : "pill-gray"}" style="margin-bottom:4px">${item.priority}</span>
            <div class="notice-title">${item.title}</div>
            <div class="notice-date">${fmtDate(item.date)} · ${item.createdByName}</div>
          </div>
        </div>
        <div class="notice-body">${item.body}</div>
      </div>`)
        .join("")}
    </div>
  </div>
</div>

<div class="page-section ${state.section === "notifications" ? "active" : ""}">
  <div class="section-card">
    <div class="section-head"><div><h3>Notifications</h3><p>${unread} unread notice${unread !== 1 ? "s" : ""}</p></div></div>
    ${heatmapHTML(s.id)}
    <div class="notice-list">
      ${db.notifications
        .map((n) => {
          const isRead = n.readBy.includes(s.id);
          return `<div class="notice-card ${isRead ? "read" : "unread"}">
        <div class="notice-header">
          <div>
            <span class="pill ${n.priority === "Urgent" ? "priority-urgent pill-danger" : n.priority === "Info" ? "priority-info pill-info" : "pill-gray"}" style="margin-bottom:4px">${n.priority}</span>
            <div class="notice-title">${n.title}</div>
            <div class="notice-date">${fmtDate(n.date)}</div>
          </div>
          <button class="btn btn-sm ${isRead ? "btn-ghost" : "btn-secondary"}" data-read="${n.id}">${isRead ? "✓ Read" : "Mark as read"}</button>
        </div>
        <div class="notice-body">${n.body}</div>
      </div>`;
        })
        .join("")}
    </div>
  </div>
</div>` + supportSectionHtml();
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // RENDER SECTIONS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function renderSections() {
        if (!state.user) {
          byId("sectionsHost").innerHTML = "";
          return;
        }
        const role = state.user.role;
        const host = byId("sectionsHost");
        host.innerHTML =
          role === "admin"
            ? adminSections()
            : role === "faculty"
              ? facultySections()
              : studentSections();
        try {
          attachEvents();
        } catch (error) {
          console.error("attachEvents failed", error);
        }
        setTimeout(animateCounters, 80);
      }

      function openAddFacultyModal() {
        openModal(
          "Add Faculty",
          "Fill in the faculty details",
          `
      <div class="form-grid">
        ${ff("Full Name", "mName")}${ff("Email", "mEmail", "", "email")}${ff("Phone", "mPhone")}
        ${ff("Password", "mPassword", "", "password")}
        ${ff("Department", "mDept")}
        ${fta("Bio", "mBio")}
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Add Faculty</button></div>
    `,
          async () => {
            const name = byId("mName").value.trim(),
              email = byId("mEmail").value.trim(),
              phone = byId("mPhone").value.trim(),
              dept = byId("mDept").value.trim(),
              password = byId("mPassword").value;
            if (!name || !email || !phone || !dept || !password) {
              toast("All fields required.", "error");
              return;
            }
            if (backendReady) {
              const created = await apiRequest("/api/faculty", {
                method: "POST",
                body: JSON.stringify({
                  name,
                  email,
                  phone,
                  department: dept,
                  password,
                  bio: byId("mBio").value.trim(),
                }),
              });
              await refreshDbFromApi();
              closeModal();
              toast(`Faculty account created for ${created.username}.`, "success");
              renderSections();
              return;
            }
            const n = 101 + db.faculty.length;
            db.faculty.push({
              id: `F${n}`,
              username: email.toLowerCase(),
              password,
              name,
              email,
              phone,
              department: dept,
              bio: byId("mBio").value.trim(),
            });
            closeModal();
            toast("Faculty added.", "success");
            renderSections();
          },
        );
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // ATTACH EVENTS
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function attachEvents() {
        if (!state.user) return;
        const role = state.user.role;

        document.querySelectorAll("[data-support-student]").forEach((btn) => {
          btn.onclick = () => {
            state.support.studentId = btn.dataset.supportStudent;
            loadSupportMessages();
          };
        });

        document.querySelectorAll("[data-support-faculty]").forEach((btn) => {
          btn.onclick = () => {
            state.support.facultyId = btn.dataset.supportFaculty;
            loadSupportMessages();
          };
        });

        document.querySelectorAll("[data-support-admin]").forEach((btn) => {
          btn.onclick = () => {
            state.support.adminId = btn.dataset.supportAdmin;
            loadSupportMessages();
          };
        });

        byId("mentorInput")?.addEventListener("input", (e) => {
          state.support.mentorDraft = e.target.value;
        });
        byId("adminInput")?.addEventListener("input", (e) => {
          state.support.adminDraft = e.target.value;
        });

        const handleChatSubmit = async (e, tabType) => {
          e.preventDefault();
          const input = byId(tabType + "Input");
          const body = input?.value.trim();
          if (!body) return;
          try {
            if (tabType === "admin") {
              state.support.adminDraft = "";
            } else {
              state.support.mentorDraft = "";
            }
            const payload = { body };
            let endpoint = "/api/support/messages";
            if (state.support.tab === "mentor") {
              if (role === "faculty") payload.studentId = state.support.studentId;
            } else {
              endpoint = "/api/support/admin-messages";
              if (role === "admin") payload.facultyId = state.support.facultyId;
              if (role === "faculty") payload.adminId = state.support.adminId;
            }
            const result = await apiRequest(endpoint, {
              method: "POST",
              body: JSON.stringify(payload),
            });
            state.support.messages = [...state.support.messages, result.message];
            await loadSupportSummary();
            renderSections();
            setTimeout(() => {
              byId(tabType + "ChatHistory")?.scrollTo(0, byId(tabType + "ChatHistory").scrollHeight);
            }, 10);
          } catch (error) {
            toast(error.message || "Unable to send message.", "error");
          }
        };

        byId("mentorChatForm")?.addEventListener("submit", (e) => handleChatSubmit(e, "mentor"));
        byId("adminChatForm")?.addEventListener("submit", (e) => handleChatSubmit(e, "admin"));

        byId("aiInput")?.addEventListener("input", (e) => {
          state.support.aiDraft = e.target.value;
        });

        byId("aiChatForm")?.addEventListener("submit", (e) => {
          e.preventDefault();
          window.sendMessage("ai");
        });

        // Profile interaction
        const uc = document.querySelector('.user-chip');
        if (uc) uc.onclick = () => {
          if (role === "admin") {
            openModal("Edit Profile", "Update Admin Details", 
              ff("Full Name", "pName", state.user.name) + ff("New Password", "pPass", "", "password") + `<div class="form-actions" style="margin-top:16px"><button type="submit" class="btn btn-primary">Save Changes</button></div>`, 
              async () => {
                const updatedName = byId('pName').value.trim();
                const updatedPassword = byId('pPass').value;
                if (backendReady) {
                  await apiRequest("/api/admin/profile", {
                    method: "PUT",
                    body: JSON.stringify({
                      id: state.user.id,
                      name: updatedName,
                      password: updatedPassword,
                    }),
                  });
                  await refreshDbFromApi();
                } else {
                  state.user.name = updatedName;
                }
                toast("Profile updated!", "success");
                closeModal();
                renderApp();
              }
            );
          } else if (role === "faculty") {
            navigateTo("profile");
          } else if (role === "student") {
            navigateTo("my-details");
          }
        };

        // Student Edit Details
        byId("editMyDetailsBtn")?.addEventListener('click', () => {
          const s = getStudent(state.user.id);
          openModal("Edit Details", "Update your contact info", 
            ff("Phone", "sPhone", s.phone) + fta("Address", "sAddress", s.address || "") + `<div class="form-actions" style="margin-top:16px"><button type="submit" class="btn btn-primary">Save Changes</button></div>`,
            async () => {
              const updated = {
                name: s.name,
                email: s.email,
                phone: byId('sPhone').value,
                course: s.course,
                year: s.year,
                gender: s.gender,
                status: s.status,
                facultyId: s.facultyId,
                dob: s.dob,
                address: byId('sAddress').value,
              };
              if (backendReady) {
                await apiRequest(`/api/students/${s.id}`, {
                  method: "PUT",
                  body: JSON.stringify(updated),
                });
                await refreshDbFromApi();
              } else {
                s.phone = updated.phone;
                s.address = updated.address;
              }
              toast("Details updated!", "success");
              closeModal();
              renderApp();
            }
          );
        });

        // Lecture Tracking
        document.querySelectorAll("[data-tog-lec]").forEach((btn) => {
          btn.onclick = async (e) => {
            const k = e.currentTarget.dataset.togLec;
            const [studentId, courseId, lectureId] = k.split("_");
            const nextSeen = !db.lectureStatus[k];
            if (backendReady) {
              await apiRequest("/api/lecture-status", {
                method: "POST",
                body: JSON.stringify({
                  studentId,
                  courseId,
                  lectureId,
                  seen: nextSeen,
                }),
              });
              await refreshDbFromApi();
            } else {
              db.lectureStatus[k] = nextSeen;
            }
            renderSections();
            // Re-open accordion after render
            const cid = courseId;
            setTimeout(() => {
              const acc = byId("acc-" + cid);
              if (acc) acc.classList.add("open");
            }, 10);
            toast((backendReady ? nextSeen : db.lectureStatus[k]) ? "Lecture marked as seen." : "Lecture mark removed.", "info");
          };
        });

        // Search inputs
        byId("stSearch")?.addEventListener("input", (e) => {
          state.listSearch.students = e.target.value;
          renderSections();
          focusSearchInput("stSearch", state.listSearch.students);
        });
        byId("facSearch")?.addEventListener("input", (e) => {
          state.listSearch.faculty = e.target.value;
          renderSections();
          focusSearchInput("facSearch", state.listSearch.faculty);
        });

        // Admin: add student
        byId("addStudentBtn")?.addEventListener("click", () => {
          const mentorOptions = db.faculty.length
            ? db.faculty
                .map(
                  (faculty) =>
                    `<option value="${faculty.id}">${esc(faculty.name)}${faculty.department ? ` · ${esc(faculty.department)}` : ""}</option>`,
                )
                .join("")
            : `<option value="">No faculty available</option>`;
          openModal(
            "Add Student",
            "Fill in the student details",
            `
      <div class="form-grid">
        ${ff("Full Name", "mName")}${ff("Email", "mEmail", "", "email")}${ff("Phone", "mPhone")}
        ${ff("Password", "mPassword", "", "password")}
        ${ff("Course", "mCourse")}
        ${fsel("Year", "mYear", ["1st Year", "2nd Year", "3rd Year", "4th Year"])}
        ${fsel("Gender", "mGender", ["Female", "Male", "Other"])}
        <div class="form-field"><label for="mMentor">Mentor</label><select id="mMentor">${mentorOptions}</select></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Add Student</button></div>
    `,
            async () => {
              const name = byId("mName").value.trim(),
                email = byId("mEmail").value.trim(),
                phone = byId("mPhone").value.trim(),
                password = byId("mPassword").value;
              if (!name || !email || !phone || !password) {
                toast("All fields are required.", "error");
                return;
              }
              if (backendReady) {
                const created = await apiRequest("/api/students", {
                  method: "POST",
                  body: JSON.stringify({
                    name,
                    email,
                    phone,
                    course: byId("mCourse").value,
                    year: byId("mYear").value,
                    gender: byId("mGender").value,
                    password,
                    status: "Active",
                    facultyId: byId("mMentor").value || null,
                    dob: "2002-01-01",
                    address: "",
                  }),
                });
                await refreshDbFromApi();
                closeModal();
                toast(`Student account created for ${created.username}.`, "success");
                renderSections();
                return;
              } else {
                const n = 101 + db.students.length;
                db.students.push({
                  id: `S${n}`,
                  username: email.toLowerCase(),
                  password,
                  name,
                  email,
                  phone,
                  course: byId("mCourse").value,
                  year: byId("mYear").value,
                  gender: byId("mGender").value,
                  status: "Active",
                  facultyId: byId("mMentor").value || "",
                  dob: "2002-01-01",
                  address: "",
                });
              }
              closeModal();
              toast("Student added successfully!", "success");
              renderSections();
            },
          );
        });

        // Admin: edit student
        document.querySelectorAll("[data-edit-s]").forEach((btn) => {
          btn.onclick = () => {
            const s = getStudent(btn.dataset.editS);
            if (!s) return;
            const mentorOptions = [
              `<option value="">Unassigned</option>`,
              ...db.faculty.map(
                (faculty) =>
                  `<option value="${faculty.id}" ${s.facultyId === faculty.id ? "selected" : ""}>${esc(faculty.name)}${faculty.department ? ` · ${esc(faculty.department)}` : ""}</option>`,
              ),
            ].join("");
            openModal(
              "Edit Student",
              "Update student information and reset login password if needed",
              `
        <div class="form-grid">
          ${ff("Full Name", "mName", s.name)}${ff("Email", "mEmail", s.email, "email")}${ff("Phone", "mPhone", s.phone)}
          ${ff("Set New Password", "mPassword", "", "password", false)}
          ${ff("Course", "mCourse", s.course)}
          ${fsel("Year", "mYear", ["1st Year", "2nd Year", "3rd Year", "4th Year"], s.year)}
          ${fsel("Gender", "mGender", ["Female", "Male", "Other"], s.gender)}
          ${fsel("Status", "mStatus", ["Active", "Inactive"], s.status)}
          <div class="form-field"><label for="mMentor">Mentor</label><select id="mMentor">${mentorOptions}</select></div>
        </div>
        <div style="margin-top:10px;font-size:.86rem;color:var(--muted)">Current passwords are not visible for security. Leave the password field blank to keep the existing password.</div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
      `,
              async () => {
                const updated = {
                  name: byId("mName").value.trim(),
                  email: byId("mEmail").value.trim(),
                  phone: byId("mPhone").value.trim(),
                  password: byId("mPassword").value,
                  course: byId("mCourse").value,
                  year: byId("mYear").value,
                  gender: byId("mGender").value,
                  status: byId("mStatus").value,
                  facultyId: byId("mMentor").value || null,
                  dob: s.dob,
                  address: s.address || "",
                };
                if (backendReady) {
                  await apiRequest(`/api/students/${s.id}`, {
                    method: "PUT",
                    body: JSON.stringify(updated),
                  });
                  await refreshDbFromApi();
                } else {
                  Object.assign(s, updated);
                }
                closeModal();
                toast("Student updated.", "success");
                renderSections();
              },
            );
          };
        });

        // Admin: delete student
        document.querySelectorAll("[data-del-s]").forEach((btn) => {
          btn.onclick = () => {
            const s = getStudent(btn.dataset.delS);
            if (!s) return;
            confirm(
              `Delete ${s.name}?`,
              `This will permanently remove all data for ${s.name}. This action cannot be undone.`,
              () => {
                const row = byId(`srow-${s.id}`);
                if (row) {
                  row.classList.add("deleting");
                  setTimeout(() => {
                    doDeleteStudent(s.id);
                  }, 400);
                } else doDeleteStudent(s.id);
              },
            );
          };
        });

        async function doDeleteStudent(id) {
          if (backendReady) {
            await apiRequest(`/api/students/${id}`, { method: "DELETE" });
            await refreshDbFromApi();
          } else {
            db.students = db.students.filter((x) => x.id !== id);
            delete db.marks[id];
            delete db.attendance[id];
            delete db.reportCards[id];
            db.courses.forEach(
              (c) => (c.students = c.students.filter((x) => x !== id)),
            );
          }
          toast("Student deleted.", "success");
          renderSections();
        }

        // Admin: add course
        byId("addCourseBtn")?.addEventListener("click", () => {
          openModal("Add Course", "Setup a new course", `
            <div class="form-grid">
              ${ff("Course Name", "mCourseName")}
              <div class="form-field"><label for="mCourseFac">Faculty</label><select id="mCourseFac">${db.faculty.map((f) => `<option value="${f.id}">${f.name}</option>`).join("")}</select></div>
              ${fsel("Schedule Day 1", "mDay1", TT_DAYS)}
              ${fsel("Time Slot 1", "mSlot1", TT_SLOTS)}
              ${fsel("Schedule Day 2", "mDay2", TT_DAYS)}
              ${fsel("Time Slot 2", "mSlot2", TT_SLOTS)}
            </div>
            <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Add Course</button></div>
          `, async () => {
             const name = byId("mCourseName").value.trim(),
                   fac = byId("mCourseFac").value,
                   d1 = byId("mDay1").value, s1 = byId("mSlot1").value,
                   d2 = byId("mDay2").value, s2 = byId("mSlot2").value;
             if (!name) return toast("Course name required", "error");
             if (backendReady) {
               await apiRequest("/api/courses", {
                 method: "POST",
                 body: JSON.stringify({
                   name,
                   facultyId: fac,
                   schedule: [
                     { title: "Lecture 1", day: d1, slot: s1 },
                     { title: "Lecture 2", day: d2, slot: s2 },
                   ],
                 }),
               });
               await refreshDbFromApi();
             } else {
               const n = 200 + db.courses.length + 1;
               db.courses.push({
                 id: "C" + n,
                 name,
                 facultyId: fac,
                 students: [],
                 schedule: [
                   { id: `C${n}-L1`, title: "Lecture 1", day: d1, slot: s1 },
                   { id: `C${n}-L2`, title: "Lecture 2", day: d2, slot: s2 }
                 ]
               });
             }
             closeModal(); toast("Course added!", "success"); renderSections();
          });
        });

        // Admin: add faculty
        byId("addFacultyBtn")?.addEventListener("click", openAddFacultyModal);

        // Admin: edit faculty
        document.querySelectorAll("[data-edit-f]").forEach((btn) => {
          btn.onclick = () => {
            const f = getFaculty(btn.dataset.editF);
            if (!f) return;
            openModal(
              "Edit Faculty",
              "Update faculty information",
              `
        <div class="form-grid">
          ${ff("Full Name", "mName", f.name)}${ff("Email", "mEmail", f.email, "email")}${ff("Phone", "mPhone", f.phone)}
          ${ff("Department", "mDept", f.department)}${fta("Bio", "mBio", f.bio || "")}
          ${ff("Set New Password", "mPassword", "", "password", false)}
        </div>
        <div style="margin-top:10px;font-size:.86rem;color:var(--muted)">Current passwords are not visible for security. Leave the password field blank to keep the existing password.</div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
      `,
              async () => {
                const updated = {
                  name: byId("mName").value.trim(),
                  email: byId("mEmail").value.trim(),
                  phone: byId("mPhone").value.trim(),
                  department: byId("mDept").value.trim(),
                  bio: byId("mBio").value.trim(),
                  password: byId("mPassword")?.value || "",
                };
                if (backendReady) {
                  await apiRequest(`/api/faculty/${f.id}`, {
                    method: "PUT",
                    body: JSON.stringify(updated),
                  });
                  await refreshDbFromApi();
                  if (state.user.id === f.id) {
                    Object.assign(state.user, getFaculty(f.id) || updated);
                  }
                } else {
                  Object.assign(f, updated);
                  if (state.user.id === f.id) Object.assign(state.user, f);
                }
                closeModal();
                toast("Faculty updated.", "success");
                renderSections();
              },
            );
          };
        });

        // Admin: delete faculty
        document.querySelectorAll("[data-del-f]").forEach((btn) => {
          btn.onclick = () => {
            const f = getFaculty(btn.dataset.delF);
            if (!f) return;
            confirm(
              `Delete ${f.name}?`,
              `Assigned courses will become unassigned. Cannot be undone.`,
              () => {
                const row = byId(`frow-${f.id}`);
                if (row) {
                  row.classList.add("deleting");
                  setTimeout(() => {
                    doDeleteFaculty(f.id);
                  }, 400);
                } else doDeleteFaculty(f.id);
              },
            );
          };
        });

        async function doDeleteFaculty(id) {
          if (backendReady) {
            await apiRequest(`/api/faculty/${id}`, { method: "DELETE" });
            await refreshDbFromApi();
          } else {
            db.faculty = db.faculty.filter((x) => x.id !== id);
            db.courses.forEach((c) => {
              if (c.facultyId === id) c.facultyId = "";
            });
          }
          toast("Faculty member deleted.", "success");
          renderSections();
        }

        // Admin: export CSV
        byId("exportStudentsBtn")?.addEventListener("click", () => {
          const rows = [
            ["ID", "Name", "Email", "Course", "Year", "Gender", "Status"],
            ...db.students.map((s) => [
              s.id,
              s.name,
              s.email,
              s.course,
              s.year,
              s.gender,
              s.status,
            ]),
          ];
          exportCSV(rows, "students.csv");
          toast("CSV exported!", "success");
        });

        // Admin: subjects
        byId("addSubjectBtn")?.addEventListener("click", async () => {
          const inp = byId("newSubjectInput"),
            val = inp.value.trim();
          if (!val) {
            toast("Enter a subject name.", "error");
            return;
          }
          if (db.subjects.includes(val)) {
            toast("Subject already exists.", "error");
            return;
          }
          if (backendReady) {
            await apiRequest("/api/subjects", {
              method: "POST",
              body: JSON.stringify({ name: val }),
            });
            await refreshDbFromApi();
          } else {
            db.subjects.push(val);
          }
          inp.value = "";
          toast("Subject added.", "success");
          renderSections();
        });
        document.querySelectorAll("[data-remove-subj]").forEach((btn) => {
          btn.onclick = async () => {
            const subjectName = db.subjects[Number(btn.dataset.removeSubj)];
            if (backendReady) {
              await apiRequest(`/api/subjects/${encodeURIComponent(subjectName)}`, {
                method: "DELETE",
              });
              await refreshDbFromApi();
            } else {
              db.subjects.splice(Number(btn.dataset.removeSubj), 1);
            }
            toast("Subject removed.", "success");
            renderSections();
          };
        });

        // Admin: add admin
        byId("addAdminBtn")?.addEventListener("click", () => {
          openModal(
            "Add Administrator",
            "Fill in administrator details",
            `
      <div class="form-grid">
        <div class="form-field"><label for="mAdminName">Full Name</label><input id="mAdminName" type="text" required/></div>
        <div class="form-field"><label for="mAdminEmail">Email</label><input id="mAdminEmail" type="email" required/></div>
        <div class="form-field"><label for="mAdminPhone">Phone</label><input id="mAdminPhone" type="text"/></div>
        <div class="form-field"><label for="mAdminPassword">Password</label><input id="mAdminPassword" type="password" required/></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Add Admin</button></div>
    `,
            async () => {
              const name = byId("mAdminName").value.trim(),
                email = byId("mAdminEmail").value.trim(),
                phone = byId("mAdminPhone").value.trim(),
                password = byId("mAdminPassword").value;
              if (!name || !email || !password) {
                toast("Name, email and password are required.", "error");
                return;
              }
              if (backendReady) {
                await apiRequest("/api/admins", {
                  method: "POST",
                  body: JSON.stringify({ name, email, phone, password }),
                });
                await refreshDbFromApi();
                closeModal();
                toast("Administrator added.", "success");
                renderSections();
              } else {
                toast("Admins can only be added when connected to backend.", "error");
              }
            },
          );
        });

        document.querySelectorAll("[data-edit-a]").forEach(btn => {
          btn.onclick = () => {
            const adminId = btn.dataset.editA;
            const a = (db.admins || [db.admin]).find(x => x.id === adminId);
            if (!a) return;
            openModal("Edit Administrator", "Update administrator details", `
              <div class="form-grid">
                ${ff("Full Name", "mAdminName", a.name)}
                ${ff("Email", "mAdminEmail", a.email, "email")}
                ${ff("Phone", "mAdminPhone", a.phone)}
                ${ff("Set New Password", "mAdminPassword", "", "password", false)}
              </div>
              <div style="margin-top:10px;font-size:.86rem;color:var(--muted)">Leave password blank to keep current password.</div>
              <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
            `, async () => {
              const name = byId("mAdminName").value.trim(),
                email = byId("mAdminEmail").value.trim(),
                phone = byId("mAdminPhone").value.trim(),
                password = byId("mAdminPassword")?.value || "";
              if (!name || !email) {
                toast("Name and email are required.", "error"); return;
              }
              if (backendReady) {
                await apiRequest(`/api/admins/${a.id}`, { method: "PUT", body: JSON.stringify({name, email, phone, password}) });
                await refreshDbFromApi();
                closeModal();
                toast("Administrator updated.", "success");
                renderSections();
              } else {
                toast("Must be connected to backend.", "error");
              }
            });
          };
        });

        document.querySelectorAll("[data-del-a]").forEach(btn => {
          btn.onclick = () => {
            const adminId = btn.dataset.delA;
            if (adminId === state.user.id) {
              toast("You cannot delete yourself.", "error"); return;
            }
            confirm("Delete Administrator?", "Are you sure you want to permanently delete this administrator?", async () => {
              if (backendReady) {
                try {
                  await apiRequest(`/api/admins/${adminId}`, { method: "DELETE" });
                  await refreshDbFromApi();
                  toast("Administrator deleted.", "success");
                } catch (e) {
                  toast(e.message || "Failed to delete.", "error");
                }
              }
              renderSections();
            });
          }
        });

        // Admin/faculty: announcements
        byId("addAnnouncementBtn")?.addEventListener("click", () => {
          openModal(
            "New Announcement",
            "Share an announcement with students",
            `
      <div class="form-grid">
        ${ff("Title", "annTitle")}
        ${fsel("Priority", "annPriority", ["Urgent", "Info", "General"])}
        ${fta("Announcement", "annBody")}
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Publish</button></div>
    `,
            async () => {
              const title = byId("annTitle").value.trim();
              const body = byId("annBody").value.trim();
              if (!title || !body) return toast("Title and announcement are required.", "error");
              if (backendReady) {
                await apiRequest("/api/announcements", {
                  method: "POST",
                  body: JSON.stringify({
                    title,
                    body,
                    priority: byId("annPriority").value,
                    date: new Date().toISOString().slice(0, 10),
                    createdByRole: "admin",
                    createdByUserId: state.user.id,
                    createdByName: state.user.name,
                  }),
                });
                await refreshDbFromApi();
              } else {
                db.announcements.unshift({
                  id: nextId("A"),
                  title,
                  body,
                  priority: byId("annPriority").value,
                  date: new Date().toISOString().slice(0, 10),
                  createdByRole: "admin",
                  createdByName: state.user.name,
                });
              }
              closeModal();
              toast("Announcement published.", "success");
              renderSections();
            },
          );
        });
        byId("addFacultyAnnouncementBtn")?.addEventListener("click", () => {
          openModal(
            "New Announcement",
            "Share an announcement with students",
            `
      <div class="form-grid">
        ${ff("Title", "annTitle")}
        ${fsel("Priority", "annPriority", ["Urgent", "Info", "General"])}
        ${fta("Announcement", "annBody")}
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Publish</button></div>
    `,
            async () => {
              const title = byId("annTitle").value.trim();
              const body = byId("annBody").value.trim();
              if (!title || !body) return toast("Title and announcement are required.", "error");
              if (backendReady) {
                await apiRequest("/api/announcements", {
                  method: "POST",
                  body: JSON.stringify({
                    title,
                    body,
                    priority: byId("annPriority").value,
                    date: new Date().toISOString().slice(0, 10),
                    createdByRole: "faculty",
                    createdByUserId: state.user.id,
                    createdByName: state.user.name,
                  }),
                });
                await refreshDbFromApi();
              } else {
                db.announcements.unshift({
                  id: nextId("A"),
                  title,
                  body,
                  priority: byId("annPriority").value,
                  date: new Date().toISOString().slice(0, 10),
                  createdByRole: "faculty",
                  createdByName: state.user.name,
                });
              }
              closeModal();
              toast("Announcement published.", "success");
              renderSections();
            },
          );
        });
        document.querySelectorAll("[data-delete-announcement]").forEach((btn) => {
          btn.onclick = async () => {
            const announcementId = btn.dataset.deleteAnnouncement;
            if (!announcementId) return;
            try {
              if (backendReady) {
                await apiRequest(`/api/announcements/${announcementId}`, {
                  method: "DELETE",
                });
                await refreshDbFromApi();
              } else {
                db.announcements = db.announcements.filter((item) => item.id !== announcementId);
              }
              toast("Announcement deleted.", "success");
            } catch (error) {
              console.warn(error);
              toast("Could not delete or already deleted.", "error");
              await refreshDbFromApi();
            }
            renderSections();
          };
        });

        // Admin: create result
        byId("addResultBtn")?.addEventListener("click", () => {
          openModal(
            "Create Result",
            "Publish a semester report card for a student",
            `
      <div class="form-grid">
        <div class="form-field"><label for="resStudent">Student</label><select id="resStudent">${db.students.map((student) => `<option value="${student.id}">${student.name}</option>`).join("")}</select></div>
        ${ff("Semester", "resSemester", "Sem 3")}
        ${ff("Published On", "resDate", new Date().toISOString().slice(0, 10), "date")}
        ${fta("Remarks", "resRemarks", "Published from current course marks.")}
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Publish Result</button></div>
    `,
            async () => {
              const studentId = byId("resStudent").value;
              const semester = byId("resSemester").value.trim();
              const publishedOn = byId("resDate").value;
              const student = getStudent(studentId);
              if (!student || !semester || !publishedOn) {
                return toast("Student, semester, and publish date are required.", "error");
              }
              const entries = getStudentCourses(studentId)
                .map((course) => ({
                  course: course.name,
                  marks: db.marks[studentId]?.[course.id],
                }))
                .filter((item) => typeof item.marks === "number");
              if (!entries.length) {
                return toast("This student has no recorded marks to publish yet.", "error");
              }
              if (backendReady) {
                await apiRequest("/api/report-cards", {
                  method: "POST",
                  body: JSON.stringify({
                    studentId,
                    semester,
                    publishedOn,
                    remarks: byId("resRemarks").value.trim(),
                    entries,
                  }),
                });
                await refreshDbFromApi();
              } else {
                if (!db.reportCards[studentId]) db.reportCards[studentId] = [];
                db.reportCards[studentId].push({
                  id: nextId("RC-"),
                  semester,
                  publishedOn,
                  remarks: byId("resRemarks").value.trim(),
                  entries,
                });
              }
              closeModal();
              toast("Result published successfully.", "success");
              renderSections();
            },
          );
        });

        // Faculty: marks
        byId("markCourseSelect")?.addEventListener("change", (e) => {
          byId("markTableHost").innerHTML =
            `<div class="skeleton skel-row"></div><div class="skeleton skel-row"></div>`;
          setTimeout(() => {
            byId("markTableHost").innerHTML = (() => {
              const cid = e.target.value;
              const c = getCourse(cid);
              if (!c) return "";
              const studs = c.students.map(getStudent).filter(Boolean);
              return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Course</th><th>Marks</th><th>Grade</th></tr></thead><tbody>
          ${studs
            .map((s) => {
              const m = db.marks[s.id]?.[cid];
              const g2 = m != null ? grade(m) : null;
              return `<tr><td>${s.name}</td><td>${c.name}</td><td><input class="mark-input" data-ms="${s.id}" data-mc="${cid}" type="number" min="0" max="100" value="${m ?? ""}" oninput="previewGrade(this,'${s.id}','${cid}')"/></td><td><span id="gshow-${s.id}-${cid}" class="pill ${g2 ? gradeColor(g2.g) : "pill-gray"}">${g2 ? g2.g : "—"}</span></td></tr>`;
            })
            .join("")}
        </tbody></table></div>`;
            })();
            attachEvents();
          }, 300);
        });

        byId("saveMarksBtn")?.addEventListener("click", async () => {
          const inputs = document.querySelectorAll("[data-ms]");
          for (const inp of inputs) {
            const v = Number(inp.value);
            if (inp.value !== "" && (isNaN(v) || v < 0 || v > 100)) {
              toast("Marks must be 0–100.", "error");
              return;
            }
          }
          if (backendReady) {
            const entries = [];
            inputs.forEach((inp) => {
              if (inp.value === "") return;
              entries.push({
                studentId: inp.dataset.ms,
                courseId: inp.dataset.mc,
                marks: Number(inp.value),
              });
            });
            await apiRequest("/api/marks/bulk", {
              method: "POST",
              body: JSON.stringify({ entries }),
            });
            await refreshDbFromApi();
          } else {
            inputs.forEach((inp) => {
              const sid = inp.dataset.ms,
                cid = inp.dataset.mc;
              if (!db.marks[sid]) db.marks[sid] = {};
              if (inp.value !== "") db.marks[sid][cid] = Number(inp.value);
            });
          }
          toast("Marks saved successfully!", "success");
          renderSections();
        });

        // Faculty: attendance
        const attCourse = byId("attCourseSelect"),
          attDate = byId("attDateInput");
        function repaintAtt() {
          if (!attCourse || !attDate) return;
          const cid = attCourse.value,
            date = attDate.value;
          const sk = `${cid}_${date}`;
          if (!db.attendanceSessions[sk]) {
            const c = getCourse(cid);
            if (c)
              db.attendanceSessions[sk] = Object.fromEntries(
                c.students.map((id) => [id, true]),
              );
          }
          byId("attTableHost").innerHTML = (() => {
            const c = getCourse(cid);
            if (!c) return "";
            const sess = db.attendanceSessions[sk] || {};
            const presentCount = Object.values(sess).filter(Boolean).length;
            return `<div style="margin-bottom:12px;font-size:.88rem;color:var(--muted)"><strong style="color:var(--text)">${presentCount}</strong> present · <strong style="color:var(--danger)">${c.students.length - presentCount}</strong> absent out of ${c.students.length}</div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Status</th></tr></thead><tbody>
        ${c.students
          .map((sid) => {
            const s = getStudent(sid);
            const present = sess[sid];
            return `<tr><td>${s?.name || sid}</td><td><button class="btn btn-sm ${present ? "btn-secondary" : "btn-danger"}" data-tog="${sid}" data-sk="${sk}">${present ? "✓ Present" : "✗ Absent"}</button></td></tr>`;
          })
          .join("")}
      </tbody></table></div>`;
          })();
          attachToggleAtt();
        }
        attCourse?.addEventListener("change", repaintAtt);
        attDate?.addEventListener("change", repaintAtt);

        function attachToggleAtt() {
          document.querySelectorAll("[data-tog]").forEach((btn) => {
            btn.onclick = () => {
              const sid = btn.dataset.tog,
                sk = btn.dataset.sk;
              const next = !db.attendanceSessions[sk][sid];
              db.attendanceSessions[sk][sid] = next;
              btn.className = `btn btn-sm ${next ? "btn-secondary" : "btn-danger"}`;
              btn.textContent = next ? "✓ Present" : "✗ Absent";
              repaintAtt();
            };
          });
        }
        attachToggleAtt();

        byId("saveAttBtn")?.addEventListener("click", async () => {
          if (!attCourse || !attDate) return;
          const cid = attCourse.value,
            date = attDate.value,
            sk = `${cid}_${date}`;
          const c = getCourse(cid);
          if (!c) return;
          const sess = db.attendanceSessions[sk] || {};
          if (backendReady) {
            await apiRequest("/api/attendance/submit", {
              method: "POST",
              body: JSON.stringify({
                courseId: cid,
                date,
                session: sess,
              }),
            });
            await refreshDbFromApi();
          } else {
            c.students.forEach((sid) => {
              if (!db.attendance[sid]) db.attendance[sid] = {};
              const cur = db.attendance[sid][cid] ?? 80;
              db.attendance[sid][cid] = Math.max(
                50,
                Math.min(100, cur + (sess[sid] ? 1 : -1)),
              );
            });
          }
          toast(`Attendance saved for ${c.name}!`, "success");
          renderSections();
        });

        // Faculty: timetable
        document.querySelectorAll("[data-add-lecture]").forEach((btn) => {
          btn.onclick = () => {
            const courseId = btn.dataset.addLecture;
            const course = getCourse(courseId);
            if (!course) return;
            openModal(
              "Add Lecture",
              `Add a timetable entry for ${course.name}`,
              `
        <div class="form-grid">
          ${ff("Lecture Title", "lecTitle")}
          ${fsel("Day", "lecDay", TT_DAYS)}
          ${fsel("Time Slot", "lecSlot", TT_SLOTS)}
        </div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Add Lecture</button></div>
      `,
              async () => {
                const title = byId("lecTitle").value.trim();
                if (!title) return toast("Lecture title is required.", "error");
                if (backendReady) {
                  await apiRequest(`/api/courses/${courseId}/lectures`, {
                    method: "POST",
                    body: JSON.stringify({
                      title,
                      day: byId("lecDay").value,
                      slot: byId("lecSlot").value,
                    }),
                  });
                  await refreshDbFromApi();
                } else {
                  course.schedule.push({
                    id: nextId(`${courseId}-L`),
                    title,
                    day: byId("lecDay").value,
                    slot: byId("lecSlot").value,
                  });
                }
                closeModal();
                toast("Lecture added to timetable.", "success");
                renderSections();
              },
            );
          };
        });
        document.querySelectorAll("[data-edit-lecture]").forEach((btn) => {
          btn.onclick = () => {
            const [courseId, lectureId] = btn.dataset.editLecture.split("|");
            const course = getCourse(courseId);
            const lecture = course?.schedule.find((item) => item.id === lectureId);
            if (!course || !lecture) return;
            openModal(
              "Edit Lecture",
              `Update timetable entry for ${course.name}`,
              `
        <div class="form-grid">
          ${ff("Lecture Title", "lecTitle", lecture.title || "")}
          ${fsel("Day", "lecDay", TT_DAYS, lecture.day)}
          ${fsel("Time Slot", "lecSlot", TT_SLOTS, lecture.slot)}
        </div>
        <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Save Changes</button></div>
      `,
              async () => {
                if (backendReady) {
                  await apiRequest(`/api/courses/${courseId}/lectures/${lectureId}`, {
                    method: "PUT",
                    body: JSON.stringify({
                      title: byId("lecTitle").value.trim(),
                      day: byId("lecDay").value,
                      slot: byId("lecSlot").value,
                    }),
                  });
                  await refreshDbFromApi();
                } else {
                  lecture.title = byId("lecTitle").value.trim();
                  lecture.day = byId("lecDay").value;
                  lecture.slot = byId("lecSlot").value;
                }
                closeModal();
                toast("Lecture updated.", "success");
                renderSections();
              },
            );
          };
        });
        document.querySelectorAll("[data-remove-lecture]").forEach((btn) => {
          btn.onclick = async () => {
            const [courseId, lectureId] = btn.dataset.removeLecture.split("|");
            const course = getCourse(courseId);
            if (!course) return;
            if (backendReady) {
              await apiRequest(`/api/courses/${courseId}/lectures/${lectureId}`, {
                method: "DELETE",
              });
              await refreshDbFromApi();
            } else {
              course.schedule = course.schedule.filter((item) => item.id !== lectureId);
            }
            toast("Lecture removed from timetable.", "success");
            renderSections();
          };
        });

        // Faculty: assignments
        byId("addAssignmentBtn")?.addEventListener("click", () => {
          openModal(
            "New Assignment",
            "Assign work to students",
            `
      <div class="form-grid">
        <div class="form-field"><label for="asgCourse">Course</label><select id="asgCourse">${db.courses.filter((course) => course.facultyId === state.user.id).map((course) => `<option value="${course.id}">${course.name}</option>`).join("")}</select></div>
        ${ff("Topic", "asgTopic")}
        ${ff("Submission Date", "asgDue", new Date().toISOString().slice(0, 10), "date")}
        ${fta("Assignment Details", "asgDetails")}
      </div>
      <div class="form-actions"><button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Assign</button></div>
    `,
            async () => {
              const topic = byId("asgTopic").value.trim();
              const details = byId("asgDetails").value.trim();
              if (!topic || !details) return toast("Topic and details are required.", "error");
              if (backendReady) {
                await apiRequest("/api/assignments", {
                  method: "POST",
                  body: JSON.stringify({
                    courseId: byId("asgCourse").value,
                    topic,
                    details,
                    submissionDate: byId("asgDue").value,
                    createdByUserId: state.user.id,
                    createdByName: state.user.name,
                  }),
                });
                await refreshDbFromApi();
              } else {
                db.assignments.unshift({
                  id: nextId("AS"),
                  courseId: byId("asgCourse").value,
                  topic,
                  details,
                  submissionDate: byId("asgDue").value,
                  createdBy: state.user.id,
                  createdAt: new Date().toISOString().slice(0, 10),
                });
              }
              closeModal();
              toast("Assignment created.", "success");
              renderSections();
            },
          );
        });
        document.querySelectorAll("[data-delete-assignment]").forEach((btn) => {
          btn.onclick = async () => {
            if (backendReady) {
              await apiRequest(`/api/assignments/${btn.dataset.deleteAssignment}`, {
                method: "DELETE",
              });
              await refreshDbFromApi();
            } else {
              db.assignments = db.assignments.filter((item) => item.id !== btn.dataset.deleteAssignment);
            }
            toast("Assignment removed.", "success");
            renderSections();
          };
        });

        // Faculty: profile
        byId("profileForm")?.addEventListener("submit", async (e) => {
          e.preventDefault();
          const f = getFaculty(state.user.id);
          if (!f) return;
          const updated = {
            name: byId("pName").value.trim(),
            email: byId("pEmail").value.trim(),
            phone: byId("pPhone").value.trim(),
            department: byId("pDept").value.trim(),
            bio: byId("pBio").value.trim(),
          };
          if (!updated.name || !updated.email) {
            toast("Name and email are required.", "error");
            return;
          }
          if (backendReady) {
            await apiRequest(`/api/faculty/${state.user.id}`, {
              method: "PUT",
              body: JSON.stringify(updated),
            });
            await refreshDbFromApi();
          } else {
            Object.assign(f, updated);
            Object.assign(state.user, updated);
          }
          toast("Profile updated!", "success");
          renderApp();
        });

        // Student: mark as read
        document.querySelectorAll("[data-read]").forEach((btn) => {
          btn.onclick = async () => {
            const n = db.notifications.find((x) => x.id === btn.dataset.read);
            if (n && !n.readBy.includes(state.user.id)) {
              if (backendReady) {
                await apiRequest(`/api/notifications/${n.id}/read`, {
                  method: "POST",
                  body: JSON.stringify({ studentId: state.user.id }),
                });
                await refreshDbFromApi();
              } else {
                n.readBy.push(state.user.id);
              }
              toast("Marked as read.", "success");
              renderTopbar();
              renderSections();
            }
          };
        });

        // Student: enroll and downloads
        document.querySelectorAll("[data-enroll-course]").forEach((btn) => {
          btn.onclick = async () => {
            const course = getCourse(btn.dataset.enrollCourse);
            if (!course || course.students.includes(state.user.id)) return;
            if (backendReady) {
              await apiRequest(`/api/courses/${course.id}/enroll`, {
                method: "POST",
                body: JSON.stringify({ studentId: state.user.id }),
              });
              await refreshDbFromApi();
            } else {
              course.students.push(state.user.id);
            }
            toast(`Enrolled in ${course.name}.`, "success");
            renderSections();
          };
        });
        document.querySelectorAll("[data-download-card]").forEach((btn) => {
          btn.onclick = () => {
            const [studentId, cardId] = btn.dataset.downloadCard.split("|");
            const student = getStudent(studentId);
            const card = getStudentReportCards(studentId).find((item) => item.id === cardId);
            if (!student || !card) return;
            downloadReportCard(student, card);
            toast("Report card downloaded.", "success");
          };
        });
      }

      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      // MAIN RENDER
      // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
      function renderApp() {
        if (!state.user) {
          showLoginScreen();
          return;
        }
        syncSidebarLayout();
        renderNav();
        renderTopbar();
        renderBanner();
        renderSections();
      }

      restoreThemePreference();
      restoreSession();

      document.addEventListener("click", (event) => {
        const addFacultyButton = event.target.closest("#addFacultyBtn");
        if (addFacultyButton) {
          event.preventDefault();
          openAddFacultyModal();
        }
      });

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          stopSupportPolling();
          return;
        }
        if (state.user) {
          startSupportPolling();
          pollSupportData().catch((error) => {
            console.warn("Support refresh failed.", error);
          });
        }
      });

