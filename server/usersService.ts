import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { config } from "./config";
import { pool } from "./db";

export type UserRole = "admin" | "editor" | "viewer";

export const USER_ROLES: UserRole[] = ["admin", "editor", "viewer"];

export interface UserRow extends RowDataPacket {
  id: number;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  role: UserRole;
  is_banned: number;
  last_login_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export type GoogleProfile = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

const normalizeEmail = (email: string | null | undefined): string =>
  String(email ?? "")
    .trim()
    .toLowerCase();

/**
 * Emails listed in CONTROL_PLANE_ADMIN_EMAILS are seeded into the users table as
 * admins on startup. They are also treated as admins live so a configured admin
 * can never be locked out, even before their row is claimed at first login.
 */
export const isSeedAdmin = (email: string | null | undefined): boolean => {
  const seeds = config.auth.adminEmails;
  if (!seeds.length) return false;
  return seeds.includes(normalizeEmail(email));
};

/**
 * Resolves the role actually applied to a user. Permissions are DB-driven; the
 * seed admin list only guarantees configured admins always resolve to admin.
 */
export const effectiveRole = (
  record: Pick<UserRow, "role"> | null | undefined,
  email: string | null | undefined,
): UserRole => {
  if (isSeedAdmin(email)) return "admin";
  return record?.role ?? "viewer";
};

export const canEditWithRole = (role: UserRole): boolean =>
  role === "admin" || role === "editor";

export const canManageUsersWithRole = (role: UserRole): boolean =>
  role === "admin";

export const getUserBySub = async (
  sub: string,
): Promise<UserRow | null> => {
  const [rows] = await pool.query<UserRow[]>(
    "SELECT * FROM users WHERE google_sub = ? LIMIT 1",
    [sub],
  );
  return rows[0] ?? null;
};

export const getUserById = async (id: number): Promise<UserRow | null> => {
  const [rows] = await pool.query<UserRow[]>(
    "SELECT * FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] ?? null;
};

export const listUsers = async (): Promise<UserRow[]> => {
  const [rows] = await pool.query<UserRow[]>(
    "SELECT * FROM users ORDER BY created_at ASC, id ASC",
  );
  return rows;
};

const getUserByEmail = async (email: string): Promise<UserRow | null> => {
  const [rows] = await pool.query<UserRow[]>(
    "SELECT * FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  return rows[0] ?? null;
};

/**
 * Resolves the signed-in Google account to a user row. An existing row (a seeded
 * admin awaiting first login, or a returning user) is matched by email and has
 * its google_sub / profile claimed; otherwise a new viewer row is inserted. Role
 * and ban status are never overwritten here — only the admin console changes them.
 */
export const upsertUserOnLogin = async (
  profile: GoogleProfile,
): Promise<UserRow> => {
  const email = normalizeEmail(profile.email);

  const existing = email
    ? await getUserByEmail(email)
    : await getUserBySub(profile.sub);

  if (existing) {
    await pool.query<ResultSetHeader>(
      `
        UPDATE users
           SET google_sub = ?, email = ?, name = ?, picture = ?, last_login_at = NOW()
         WHERE id = ?
      `,
      [
        profile.sub,
        email || existing.email,
        profile.name ?? null,
        profile.picture ?? null,
        existing.id,
      ],
    );
    const record = await getUserById(existing.id);
    if (!record) throw new Error("Failed to load user after login update");
    return record;
  }

  const initialRole: UserRole = isSeedAdmin(email) ? "admin" : "viewer";
  await pool.query<ResultSetHeader>(
    `
      INSERT INTO users (google_sub, email, name, picture, role, last_login_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `,
    [profile.sub, email, profile.name ?? null, profile.picture ?? null, initialRole],
  );

  const record = await getUserBySub(profile.sub);
  if (!record) throw new Error("Failed to persist user on login");
  return record;
};

/**
 * Ensures every email in CONTROL_PLANE_ADMIN_EMAILS exists as an active admin.
 * Runs on startup; re-asserts admin + un-bans on every boot so a configured
 * admin can always recover access. New rows are created without a google_sub,
 * which is claimed when the admin first signs in.
 */
export const seedAdminUsers = async (): Promise<void> => {
  const emails = config.auth.adminEmails;

  if (!emails.length) {
    const [rows] = await pool.query<({ active_admins: number } & RowDataPacket)[]>(
      "SELECT COUNT(*) AS active_admins FROM users WHERE role = 'admin' AND is_banned = 0",
    );
    if (!rows[0]?.active_admins) {
      console.warn(
        "[users] CONTROL_PLANE_ADMIN_EMAILS is empty and no active admin exists — " +
          "the Users console will be unreachable until an admin is seeded.",
      );
    }
    return;
  }

  for (const email of emails) {
    await pool.query<ResultSetHeader>(
      `
        INSERT INTO users (email, role) VALUES (?, 'admin')
        ON DUPLICATE KEY UPDATE role = 'admin', is_banned = 0
      `,
      [email],
    );
  }

  console.log(
    `[users] Ensured ${emails.length} admin account(s) from CONTROL_PLANE_ADMIN_EMAILS`,
  );
};

export const setUserRole = async (
  id: number,
  role: UserRole,
): Promise<void> => {
  await pool.query("UPDATE users SET role = ? WHERE id = ?", [role, id]);
};

export const setUserBanned = async (
  id: number,
  banned: boolean,
): Promise<void> => {
  await pool.query("UPDATE users SET is_banned = ? WHERE id = ?", [
    banned ? 1 : 0,
    id,
  ]);
};
