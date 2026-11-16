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
  /** Its default account per CLI on this computer (`{ claude: <cli profile id> }`); absent = the CLI's own default. */
  readonly defaultAccounts: Readonly<Record<string, string>>;
}

/** `GET /api/user-profiles`: the profiles and this browser's active one (`null`: none chosen yet / locked). */
export interface UserProfilesView {
  readonly profiles: readonly UserProfile[];
  readonly activeId: string | null;
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
