import { sha256Hex } from '../shared/utils.js';
import type {
  CommandDefinition,
  CommandGrant,
  CommandManager,
  CredentialRecord,
  GroupManager,
  PermissionCatalog,
  PermissionDefinition,
  UserManager,
  UserRecord,
} from './types.js';
import type { CoordStore } from './types.js';

/** Stored representation of one IAM group. */
type GroupRecord = {
  groupId: string;
  meta?: unknown;
  members: string[];
  subgroups: string[];
};

/**
 * Handles group key.
 * @param ns Ns.
 * @param groupId Group id.
 */
function groupKey(ns: string, groupId: string): string {
  return `iam/${ns}/groups/${groupId}`;
}

/**
 * Handles user key.
 * @param ns Ns.
 * @param userId User id.
 */
function userKey(ns: string, userId: string): string {
  return `iam/${ns}/users/${userId}`;
}

/**
 * Handles cred key.
 * @param ns Ns.
 * @param userId User id.
 */
function credKey(ns: string, userId: string): string {
  return `iam/${ns}/creds/${userId}`;
}

/**
 * Handles perm key.
 * @param ns Ns.
 * @param permId Perm id.
 */
function permKey(ns: string, permId: string): string {
  return `iam/${ns}/permissions/${permId}`;
}

/**
 * Handles command key.
 * @param ns Ns.
 * @param commandId Command id.
 */
function commandKey(ns: string, commandId: string): string {
  return `iam/${ns}/commands/${commandId}`;
}

/**
 * Handles grant key.
 * @param ns Ns.
 * @param subject Subject.
 * @param commandId Command id.
 */
function grantKey(ns: string, subject: string, commandId: string): string {
  return `iam/${ns}/grants/${subject}/${commandId}`;
}

/**
 * Returns whether record.
 * @param value Value to process.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Handles clone array.
 * @param value Value to process.
 */
function cloneArray(value: string[] | undefined): string[] {
  return [...(value ?? [])];
}

/**
 * Normalizes group.
 * @param value Value to process.
 * @param groupId Group id.
 */
function normalizeGroup(value: unknown, groupId: string): GroupRecord {
  const record = isRecord(value) ? value : {};
  return {
    groupId,
    meta: record.meta,
    members: Array.isArray(record.members)
      ? record.members.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    subgroups: Array.isArray(record.subgroups)
      ? record.subgroups.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

/**
 * Handles mask allows.
 * @param grant Grant.
 * @param requestedMask Requested mask.
 */
function maskAllows(grant: CommandGrant, requestedMask: number): boolean {
  if (requestedMask === 0) {
    return true;
  }
  if (grant.mask === undefined) {
    return true;
  }
  return (grant.mask & requestedMask) === requestedMask;
}

/**
 * Handles scope matches.
 * @param grantScope Grant scope.
 * @param requestedScope Requested scope.
 */
function scopeMatches(grantScope: unknown, requestedScope: unknown): boolean {
  if (grantScope === undefined) {
    return true;
  }
  if (!isRecord(grantScope)) {
    return Object.is(grantScope, requestedScope);
  }
  if (!isRecord(requestedScope)) {
    return false;
  }
  return Object.entries(grantScope).every(([key, value]) =>
    Object.is(requestedScope[key], value),
  );
}

/** Hierarchical group store and resolver used by the IAM layer. */
export class CordGroupManager implements GroupManager {
  /** Create the group manager on top of the shared coord store. */
  constructor(private readonly store: CoordStore) {}

  /** Create or replace one group. */
  async createGroup(
    ns: string,
    groupId: string,
    meta?: unknown,
  ): Promise<void> {
    const group = await this.readGroup(ns, groupId);
    await this.store.set(groupKey(ns, groupId), {
      groupId,
      meta,
      members: group?.members ?? [],
      subgroups: group?.subgroups ?? [],
    });
  }

  /** Delete one group and remove subgroup references pointing to it. */
  async deleteGroup(ns: string, groupId: string): Promise<void> {
    await this.store.del(groupKey(ns, groupId));
    for (const group of await this.listGroups(ns)) {
      if (group.subgroups.includes(groupId)) {
        group.subgroups = group.subgroups.filter((item) => item !== groupId);
        await this.writeGroup(ns, group);
      }
    }
  }

  /** Add one direct member to a group. */
  async addMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    if (!group.members.includes(itemRef)) {
      group.members.push(itemRef);
      group.members.sort();
      await this.writeGroup(ns, group);
    }
  }

  /** Remove one direct member from a group. */
  async removeMember(
    ns: string,
    groupId: string,
    itemRef: string,
  ): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    group.members = group.members.filter((item) => item !== itemRef);
    await this.writeGroup(ns, group);
  }

  /** Add a subgroup edge while preventing recursive cycles. */
  async addSubgroup(
    ns: string,
    groupId: string,
    childGroupId: string,
  ): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    await this.requireGroup(ns, childGroupId);
    if (
      groupId === childGroupId ||
      (await this.isMember(ns, childGroupId, `grp:${groupId}`, {
        recursive: true,
      }))
    ) {
      throw new Error(
        `Adding subgroup ${childGroupId} to ${groupId} would create a cycle`,
      );
    }
    if (!group.subgroups.includes(childGroupId)) {
      group.subgroups.push(childGroupId);
      group.subgroups.sort();
      await this.writeGroup(ns, group);
    }
  }

  /** Remove one subgroup edge. */
  async removeSubgroup(
    ns: string,
    groupId: string,
    childGroupId: string,
  ): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    group.subgroups = group.subgroups.filter((item) => item !== childGroupId);
    await this.writeGroup(ns, group);
  }

  /** List direct or recursive members for one group. */
  async listMembers(
    ns: string,
    groupId: string,
    opts: { recursive?: boolean } = {},
  ): Promise<string[]> {
    const group = await this.requireGroup(ns, groupId);
    if (!opts.recursive) {
      return cloneArray(group.members).sort();
    }

    const seenGroups = new Set<string>();
    const members = new Set<string>();
    /**
     * Handles visit.
     * @param currentId Current id.
     */
    const visit = async (currentId: string): Promise<void> => {
      if (seenGroups.has(currentId)) {
        return;
      }
      seenGroups.add(currentId);
      const current = await this.requireGroup(ns, currentId);
      for (const member of current.members) {
        members.add(member);
      }
      for (const child of current.subgroups) {
        members.add(`grp:${child}`);
        await visit(child);
      }
    };
    await visit(group.groupId);
    return [...members].sort();
  }

  /** Check whether a group contains a member, optionally through subgroups. */
  async isMember(
    ns: string,
    groupId: string,
    itemRef: string,
    opts: { recursive?: boolean } = {},
  ): Promise<boolean> {
    const group = await this.requireGroup(ns, groupId);
    if (group.members.includes(itemRef)) {
      return true;
    }
    if (!opts.recursive) {
      return false;
    }
    for (const child of group.subgroups) {
      if (
        itemRef === `grp:${child}` ||
        (await this.isMember(ns, child, itemRef, { recursive: true }))
      ) {
        return true;
      }
    }
    return false;
  }

  /** List all groups in one namespace. */
  async listGroups(ns: string): Promise<GroupRecord[]> {
    const items = await this.store.list(`iam/${ns}/groups/`);
    return items.map(({ key, value }) =>
      normalizeGroup(value, key.slice(`iam/${ns}/groups/`.length)),
    );
  }

  /**
   * Reads group.
   * @param ns Ns.
   * @param groupId Group id.
   */
  private async readGroup(
    ns: string,
    groupId: string,
  ): Promise<GroupRecord | null> {
    const value = await this.store.get(groupKey(ns, groupId));
    return value ? normalizeGroup(value, groupId) : null;
  }

  /**
   * Handles require group.
   * @param ns Ns.
   * @param groupId Group id.
   */
  private async requireGroup(
    ns: string,
    groupId: string,
  ): Promise<GroupRecord> {
    const group = await this.readGroup(ns, groupId);
    if (!group) {
      throw new Error(`Group ${groupId} does not exist in ${ns}`);
    }
    return group;
  }

  /**
   * Writes group.
   * @param ns Ns.
   * @param group Group.
   */
  private async writeGroup(ns: string, group: GroupRecord): Promise<void> {
    await this.store.set(groupKey(ns, group.groupId), group);
  }
}

/** Durable permission catalog used by the command and auth layers. */
export class CordPermissionCatalog implements PermissionCatalog {
  /** Create the permission catalog on top of the shared coord store. */
  constructor(private readonly store: CoordStore) {}

  /** Define or replace one permission id. */
  async definePermission(
    ns: string,
    permId: string,
    def: PermissionDefinition,
  ): Promise<void> {
    await this.store.set(permKey(ns, permId), def);
  }

  /** Read one permission definition by id. */
  async getPermission(
    ns: string,
    permId: string,
  ): Promise<PermissionDefinition | null> {
    return (await this.store.get(
      permKey(ns, permId),
    )) as PermissionDefinition | null;
  }

  /** List permissions in lexical order, optionally scoped by prefix. */
  async listPermissions(
    ns: string,
    prefix = '',
  ): Promise<Array<PermissionDefinition & { permId: string }>> {
    const items = await this.store.list(`iam/${ns}/permissions/${prefix}`);
    return items
      .map(({ key, value }) => ({
        permId: key.slice(`iam/${ns}/permissions/`.length),
        ...(value as PermissionDefinition),
      }))
      .sort((left, right) => left.permId.localeCompare(right.permId));
  }
}

/** User and credential manager for the reference coord IAM model. */
export class CordUserManager implements UserManager {
  /** Create the user manager on top of the shared coord store and group manager. */
  constructor(
    private readonly store: CoordStore,
    private readonly groups: CordGroupManager,
  ) {}

  /** Ensure the namespace has a reusable guest user and group. */
  async ensureGuest(ns: string): Promise<string> {
    const userId = 'user:guest';
    if (!(await this.getUser(ns, userId))) {
      await this.createUser(ns, { userId, displayName: 'Guest' });
      await this.setCredential(ns, userId, { type: 'none' });
    }
    try {
      await this.groups.createGroup(ns, 'guest', { system: true });
    } catch {}
    await this.groups.addMember(ns, 'guest', userId);
    return userId;
  }

  /** Create or replace one user record. */
  async createUser(ns: string, user: UserRecord): Promise<void> {
    await this.store.set(userKey(ns, user.userId), user);
  }

  /** Read one user record. */
  async getUser(ns: string, userId: string): Promise<UserRecord | null> {
    return (await this.store.get(userKey(ns, userId))) as UserRecord | null;
  }

  /** Store one credential record, hashing secrets when needed. */
  async setCredential(
    ns: string,
    userId: string,
    cred: CredentialRecord,
  ): Promise<void> {
    const record: CredentialRecord =
      cred.type === 'none'
        ? { type: 'none' }
        : {
            type: cred.type,
            secretHash: cred.secretHash,
          };
    await this.store.set(credKey(ns, userId), record);
  }

  /** Verify one password/PIN/none credential proof. */
  async verifyCredential(
    ns: string,
    userId: string,
    proof: unknown,
  ): Promise<boolean> {
    const cred = (await this.store.get(
      credKey(ns, userId),
    )) as CredentialRecord | null;
    if (!cred) {
      return false;
    }
    if (cred.type === 'none') {
      return true;
    }
    if (typeof proof !== 'string') {
      return false;
    }
    return cred.secretHash === sha256Hex(proof);
  }

  /** Add a user to a named group. */
  async addUserToGroup(
    ns: string,
    userId: string,
    groupId: string,
  ): Promise<void> {
    await this.groups.addMember(ns, groupId, userId);
  }

  /** Remove a user from a named group. */
  async removeUserFromGroup(
    ns: string,
    userId: string,
    groupId: string,
  ): Promise<void> {
    await this.groups.removeMember(ns, groupId, userId);
  }
}

/** Durable command-definition and command-grant manager. */
export class CordCommandManager implements CommandManager {
  /** Create the command manager on top of the shared coord store and groups. */
  constructor(
    private readonly store: CoordStore,
    private readonly groups: CordGroupManager,
  ) {}

  /** Define or replace one command id. */
  async defineCommand(
    ns: string,
    commandId: string,
    def: CommandDefinition,
  ): Promise<void> {
    await this.store.set(commandKey(ns, commandId), def);
  }

  /** Grant a subject permission to invoke a command. */
  async grant(
    ns: string,
    subject: string,
    commandId: string,
    grant: CommandGrant,
  ): Promise<void> {
    await this.store.set(grantKey(ns, subject, commandId), grant);
  }

  /** Remove a previously granted command permission. */
  async revoke(ns: string, subject: string, commandId: string): Promise<void> {
    await this.store.del(grantKey(ns, subject, commandId));
  }

  /** Evaluate whether a caller can invoke a command with the requested mask and scope. */
  async canInvoke(
    ns: string,
    ctx: { userId: string; groups?: string[]; scope?: unknown },
    commandId: string,
    requestedMask = 0,
  ): Promise<boolean> {
    const subjects = await this.resolveSubjects(
      ns,
      ctx.userId,
      ctx.groups ?? [],
    );
    const grants: Array<{ subject: string; grant: CommandGrant }> = [];
    for (const subject of subjects) {
      const grant = (await this.store.get(
        grantKey(ns, subject, commandId),
      )) as CommandGrant | null;
      if (grant) {
        grants.push({ subject, grant });
      }
    }

    for (const { grant } of grants.filter(
      (entry) => entry.grant.allow === false,
    )) {
      if (
        maskAllows(grant, requestedMask) &&
        scopeMatches(grant.scope, ctx.scope)
      ) {
        return false;
      }
    }

    return grants.some(
      ({ grant }) =>
        grant.allow &&
        maskAllows(grant, requestedMask) &&
        scopeMatches(grant.scope, ctx.scope),
    );
  }

  /**
   * Resolves subjects.
   * @param ns Ns.
   * @param userId User id.
   * @param groups Groups.
   */
  private async resolveSubjects(
    ns: string,
    userId: string,
    groups: string[],
  ): Promise<string[]> {
    const result = new Set<string>([
      userId,
      ...groups.map((groupId) =>
        groupId.startsWith('grp:') ? groupId : `grp:${groupId}`,
      ),
    ]);
    for (const group of await this.groups.listGroups(ns)) {
      if (
        await this.groups.isMember(ns, group.groupId, userId, {
          recursive: true,
        })
      ) {
        result.add(`grp:${group.groupId}`);
      }
      for (const explicit of groups) {
        const normalized = explicit.startsWith('grp:')
          ? explicit.slice(4)
          : explicit;
        if (
          await this.groups.isMember(ns, group.groupId, `grp:${normalized}`, {
            recursive: true,
          })
        ) {
          result.add(`grp:${group.groupId}`);
        }
      }
    }
    return [...result];
  }
}
