// Who may do what. Pure functions, no I/O, so every rule is easy to test.
//
//  owner       the MOM's creator, or the team owner (account holder)
//  participant listed in the MOM's attendees; sees PUBLISHED MOMs only
//  guest       opened a share link and confirmed their e-mail; read-only, one MOM
//  none        no access (drafts are visible to the owner only)

export type MomRole = 'owner' | 'participant' | 'guest' | 'none';

export interface Who {
  email: string;
  org_id: string;
  role: 'owner' | 'member';
}
export interface MomFacts {
  org_id: string;
  created_by: string;
  status: 'draft' | 'published';
}

export function momRole(user: Who, mom: MomFacts, attendees: readonly string[]): MomRole {
  if (user.org_id !== mom.org_id) return 'none';
  if (user.role === 'owner' || user.email === mom.created_by) return 'owner';
  if (mom.status === 'published' && attendees.includes(user.email)) return 'participant';
  return 'none';
}

export const canView = (r: MomRole) => r !== 'none';
/** Update details, publish, add/remove points, delete, merge. */
export const canManageMom = (r: MomRole) => r === 'owner';
/** Share, attach files, post updates. */
export const canContribute = (r: MomRole) => r === 'owner' || r === 'participant';
/** Change a point's status, text, due date or people. Participants only for points they are responsible for. */
export const canWorkOnPoint = (r: MomRole, email: string, owners: readonly string[]) =>
  r === 'owner' || (r === 'participant' && owners.includes(email));

export const DELETE_NOTICE = (byName: string, dateStr: string, timeStr: string) =>
  `This MOM has been deleted by @${byName} on ${dateStr} at ${timeStr}`;
