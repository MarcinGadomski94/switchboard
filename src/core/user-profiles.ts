/**
 * D165 · Profiles (`docs/profiles.md`): two people share one Switchboard. Every agent belongs to
 * one user profile (`Default` by default); a browser works in one profile at a time and sees only
 * its agents and what follows them. A profile may have a password to switch to it. Not protection
 * against the machine's OS user (transcripts are files on disk): an organiser with a lock.
 *
 * Named `UserProfile` in code so it never meets D63's CLI account profiles (`cli_profiles`,
 * `Session.profileId`); the UI says "Profiles".
 */

/** The profile every existing agent lands in (seeded by migration 0055); never deleted. */
export const DEFAULT_USER_PROFILE_ID = 'default';

/** The settings key of each profile's default account per CLI on this computer (`{ <profile>: { <cli>: <cli profile id> } }`). */
export const USER_PROFILE_ACCOUNTS_SETTING = 'userProfiles.defaultAccounts';

/**
 * 2026-11-16 · the profile a browser opens in before it ever chose one (Settings → Profiles →
 * *Open in*): a live profile's id; absent or gone = Default. This computer's own (not synced).
 */
export const USER_PROFILE_START_SETTING = 'userProfiles.startProfileId';

/**
 * 2026-11-16 · how long a browser keeps its profile (the cookie's `Max-Age`): 400 days, the longest a
 * browser keeps a cookie. A restart of Switchboard or of the browser keeps the browser in it, password
 * or not; a new password still signs every browser out of that profile.
 */
export const USER_PROFILE_COOKIE_MAX_AGE_S = 400 * 24 * 3600;

/** The colours a profile can carry (the rail switcher's dot). */
export const USER_PROFILE_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink', 'grey'] as const;
/** One of {@link USER_PROFILE_COLORS}. */
export type UserProfileColor = (typeof USER_PROFILE_COLORS)[number];

/** A profile's name: 1–40 characters after trimming. */
export const USER_PROFILE_NAME_MAX = 40;
/** A password: 4–200 characters (a short PIN is fine: it only switches profiles). */
export const USER_PROFILE_PASSWORD_MIN = 4;
export const USER_PROFILE_PASSWORD_MAX = 200;

/** Failed switches allowed per profile per {@link USER_PROFILE_SWITCH_WINDOW_MS} before 429. */
export const USER_PROFILE_SWITCH_ATTEMPTS = 5;
export const USER_PROFILE_SWITCH_WINDOW_MS = 60_000;

/** A profile as the API shows it (`GET /api/user-profiles`): never its password or hash. */
export interface UserProfile {
  readonly id: string;
  readonly name: string;
  readonly color: UserProfileColor;
  /** Whether switching to it asks for a password. */
  readonly hasPassword: boolean;
  /** `true` for {@link DEFAULT_USER_PROFILE_ID} (cannot be deleted). */
  readonly isDefault: boolean;
  /** D172: some computer's Default (this one's or a paired one's): never deleted, only merged. Absent from an older server. */
  readonly computerDefault?: boolean;
  /** Its default account per CLI on this computer (`{ claude: <cli profile id> }`); absent = the CLI's own default. */
  readonly defaultAccounts: Readonly<Record<string, string>>;
  /** D173: an admin profile (only admins change admins and computer access). Absent from an older server. */
  readonly admin?: boolean;
  /** D173: the computers (machine ids) it may use; `null` = every computer. Absent from an older server. */
  readonly computers?: readonly string[] | null;
  /** D173: whether it may be used on this computer ({@link profileAllowedOn}); the switcher lists only these. */
  readonly allowedHere?: boolean;
}

/** `GET /api/user-profiles`: the profiles and this browser's active one (`null`: none chosen yet / locked). */
export interface UserProfilesView {
  readonly profiles: readonly UserProfile[];
  readonly activeId: string | null;
  /** 2026-11-16: the profile a browser opens in before it chose one ({@link USER_PROFILE_START_SETTING}); absent from an older server. */
  readonly startId?: string;
}

/** A trimmed, valid name, else `null`. */
export function userProfileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= USER_PROFILE_NAME_MAX ? name : null;
}

/** A known colour, else `null`. */
export function userProfileColor(value: unknown): UserProfileColor | null {
  return typeof value === 'string' && (USER_PROFILE_COLORS as readonly string[]).includes(value) ? (value as UserProfileColor) : null;
}

/** A password of a valid length, else `null` (never trimmed: spaces count). */
export function userProfilePassword(value: unknown): string | null {
  return typeof value === 'string' && value.length >= USER_PROFILE_PASSWORD_MIN && value.length <= USER_PROFILE_PASSWORD_MAX ? value : null;
}

/** A profile id: the default one or a UUID-like token (letters, digits, `-`), at most 64 characters. */
export function isUserProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

/**
 * The profile a record belongs to: its own id, else Default. An older paired computer sends
 * sessions without the field: they are Default's (the plan's "older peer → Default").
 */
export function profileOf(value: { readonly userProfileId?: string | null } | null | undefined): string {
  const id = value?.userProfileId;
  return typeof id === 'string' && id !== '' ? id : DEFAULT_USER_PROFILE_ID;
}

/**
 * What a request may see: one profile, or every profile (`'*'`: the peer API, the hook script,
 * Switchboard's own internal work). `null` = no profile chosen yet (the browser must pick one):
 * it sees nothing that belongs to a profile.
 */
export type ProfileScope = string | '*' | null;

/** Whether scope `scope` sees something of profile `profileId`. */
export function scopeSees(scope: ProfileScope, profileId: string): boolean {
  return scope === '*' || (scope !== null && scope === profileId);
}

/**
 * D173 (`docs/profiles.md` → *Admins and computer access*): whether a profile whose access list is
 * `computers` may be used on computer `machineId`. `null` (or absent) = every computer, the default;
 * an unknown machine id (`null`) is allowed (nothing to check against yet).
 */
export function profileAllowedOn(computers: readonly string[] | null | undefined, machineId: string | null): boolean {
  if (computers === null || computers === undefined || machineId === null) return true;
  return computers.includes(machineId);
}

/** D173: an access list as given (`'all'`, `null` or machine ids), cleaned: `null` = every computer; else unique ids. */
export function readComputerAccess(value: unknown): readonly string[] | null | undefined {
  if (value === 'all' || value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id));
  return ids.length === value.length ? [...new Set(ids)] : undefined;
}

/** D173: a profile as the admin rules read it. */
export interface AdminFacts {
  readonly id: string;
  readonly admin: boolean;
  readonly hasPassword: boolean;
}

/**
 * D173: whether the request's profile `actor` may change admins and computer access. An admin may;
 * while no live profile is an admin yet (the bootstrap), a profile with a password may make **itself**
 * the first admin (`target` = itself, `makingAdmin`). `actor` `null` (no profile): never.
 */
export function mayManageAccess(profiles: readonly AdminFacts[], actor: string | null, change: { readonly target: string; readonly makingAdmin: boolean }): 'admin' | 'bootstrap' | null {
  if (actor === null) return null;
  const me = profiles.find((profile) => profile.id === actor);
  if (!me) return null;
  if (me.admin) return 'admin';
  const anyAdmin = profiles.some((profile) => profile.admin);
  if (!anyAdmin && me.hasPassword && change.makingAdmin && change.target === actor) return 'bootstrap';
  return null;
}

/** D173: why an admin change would break the rules (the last admin, an admin without a password), else `null`. */
export function adminChangeProblem(profiles: readonly AdminFacts[], target: string, admin: boolean): string | null {
  const profile = profiles.find((candidate) => candidate.id === target);
  if (!profile) return null;
  if (admin && !profile.hasPassword) return 'An admin needs a password: set one for this profile first.';
  if (!admin && profile.admin && profiles.filter((candidate) => candidate.admin).length <= 1) return 'This is the last admin: make another profile an admin first.';
  return null;
}
