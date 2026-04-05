import { sha256Hex } from "../shared/utils.js";
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
} from "./types.js";
import type { CoordStore } from "./types.js";

type GroupRecord = {
  groupId: string;
  meta?: unknown;
  members: string[];
  subgroups: string[];
};

function groupKey(ns: string, groupId: string): string {
  return `iam/${ns}/groups/${groupId}`;
}

function userKey(ns: string, userId: string): string {
  return `iam/${ns}/users/${userId}`;
}

function credKey(ns: string, userId: string): string {
  return `iam/${ns}/creds/${userId}`;
}

function permKey(ns: string, permId: string): string {
  return `iam/${ns}/permissions/${permId}`;
}

function commandKey(ns: string, commandId: string): string {
  return `iam/${ns}/commands/${commandId}`;
}

function grantKey(ns: string, subject: string, commandId: string): string {
  return `iam/${ns}/grants/${subject}/${commandId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneArray(value: string[] | undefined): string[] {
  return [...(value ?? [])];
}

function normalizeGroup(value: unknown, groupId: string): GroupRecord {
  const record = isRecord(value) ? value : {};
  return {
    groupId,
    meta: record.meta,
    members: Array.isArray(record.members) ? record.members.filter((item): item is string => typeof item === "string") : [],
    subgroups: Array.isArray(record.subgroups) ? record.subgroups.filter((item): item is string => typeof item === "string") : [],
  };
}

function maskAllows(grant: CommandGrant, requestedMask: number): boolean {
  if (requestedMask === 0) {
    return true;
  }
  if (grant.mask === undefined) {
    return true;
  }
  return (grant.mask & requestedMask) === requestedMask;
}

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
  return Object.entries(grantScope).every(([key, value]) => Object.is(requestedScope[key], value));
}

export class CordGroupManager implements GroupManager {
  constructor(private readonly store: CoordStore) {}

  async createGroup(ns: string, groupId: string, meta?: unknown): Promise<void> {
    const group = await this.readGroup(ns, groupId);
    await this.store.set(groupKey(ns, groupId), {
      groupId,
      meta,
      members: group?.members ?? [],
      subgroups: group?.subgroups ?? [],
    });
  }

  async deleteGroup(ns: string, groupId: string): Promise<void> {
    await this.store.del(groupKey(ns, groupId));
    for (const group of await this.listGroups(ns)) {
      if (group.subgroups.includes(groupId)) {
        group.subgroups = group.subgroups.filter((item) => item !== groupId);
        await this.writeGroup(ns, group);
      }
    }
  }

  async addMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    if (!group.members.includes(itemRef)) {
      group.members.push(itemRef);
      group.members.sort();
      await this.writeGroup(ns, group);
    }
  }

  async removeMember(ns: string, groupId: string, itemRef: string): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    group.members = group.members.filter((item) => item !== itemRef);
    await this.writeGroup(ns, group);
  }

  async addSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    await this.requireGroup(ns, childGroupId);
    if (groupId === childGroupId || (await this.isMember(ns, childGroupId, `grp:${groupId}`, { recursive: true }))) {
      throw new Error(`Adding subgroup ${childGroupId} to ${groupId} would create a cycle`);
    }
    if (!group.subgroups.includes(childGroupId)) {
      group.subgroups.push(childGroupId);
      group.subgroups.sort();
      await this.writeGroup(ns, group);
    }
  }

  async removeSubgroup(ns: string, groupId: string, childGroupId: string): Promise<void> {
    const group = await this.requireGroup(ns, groupId);
    group.subgroups = group.subgroups.filter((item) => item !== childGroupId);
    await this.writeGroup(ns, group);
  }

  async listMembers(ns: string, groupId: string, opts: { recursive?: boolean } = {}): Promise<string[]> {
    const group = await this.requireGroup(ns, groupId);
    if (!opts.recursive) {
      return cloneArray(group.members).sort();
    }

    const seenGroups = new Set<string>();
    const members = new Set<string>();
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

  async isMember(ns: string, groupId: string, itemRef: string, opts: { recursive?: boolean } = {}): Promise<boolean> {
    const group = await this.requireGroup(ns, groupId);
    if (group.members.includes(itemRef)) {
      return true;
    }
    if (!opts.recursive) {
      return false;
    }
    for (const child of group.subgroups) {
      if (itemRef === `grp:${child}` || (await this.isMember(ns, child, itemRef, { recursive: true }))) {
        return true;
      }
    }
    return false;
  }

  async listGroups(ns: string): Promise<GroupRecord[]> {
    const items = await this.store.list(`iam/${ns}/groups/`);
    return items.map(({ key, value }) => normalizeGroup(value, key.slice(`iam/${ns}/groups/`.length)));
  }

  private async readGroup(ns: string, groupId: string): Promise<GroupRecord | null> {
    const value = await this.store.get(groupKey(ns, groupId));
    return value ? normalizeGroup(value, groupId) : null;
  }

  private async requireGroup(ns: string, groupId: string): Promise<GroupRecord> {
    const group = await this.readGroup(ns, groupId);
    if (!group) {
      throw new Error(`Group ${groupId} does not exist in ${ns}`);
    }
    return group;
  }

  private async writeGroup(ns: string, group: GroupRecord): Promise<void> {
    await this.store.set(groupKey(ns, group.groupId), group);
  }
}

export class CordPermissionCatalog implements PermissionCatalog {
  constructor(private readonly store: CoordStore) {}

  async definePermission(ns: string, permId: string, def: PermissionDefinition): Promise<void> {
    await this.store.set(permKey(ns, permId), def);
  }

  async getPermission(ns: string, permId: string): Promise<PermissionDefinition | null> {
    return (await this.store.get(permKey(ns, permId))) as PermissionDefinition | null;
  }

  async listPermissions(ns: string, prefix = ""): Promise<Array<PermissionDefinition & { permId: string }>> {
    const items = await this.store.list(`iam/${ns}/permissions/${prefix}`);
    return items
      .map(({ key, value }) => ({
        permId: key.slice(`iam/${ns}/permissions/`.length),
        ...(value as PermissionDefinition),
      }))
      .sort((left, right) => left.permId.localeCompare(right.permId));
  }
}

export class CordUserManager implements UserManager {
  constructor(private readonly store: CoordStore, private readonly groups: CordGroupManager) {}

  async ensureGuest(ns: string): Promise<string> {
    const userId = "user:guest";
    if (!(await this.getUser(ns, userId))) {
      await this.createUser(ns, { userId, displayName: "Guest" });
      await this.setCredential(ns, userId, { type: "none" });
    }
    try {
      await this.groups.createGroup(ns, "guest", { system: true });
    } catch {}
    await this.groups.addMember(ns, "guest", userId);
    return userId;
  }

  async createUser(ns: string, user: UserRecord): Promise<void> {
    await this.store.set(userKey(ns, user.userId), user);
  }

  async getUser(ns: string, userId: string): Promise<UserRecord | null> {
    return (await this.store.get(userKey(ns, userId))) as UserRecord | null;
  }

  async setCredential(ns: string, userId: string, cred: CredentialRecord): Promise<void> {
    const record: CredentialRecord =
      cred.type === "none"
        ? { type: "none" }
        : {
            type: cred.type,
            secretHash: cred.secretHash,
          };
    await this.store.set(credKey(ns, userId), record);
  }

  async verifyCredential(ns: string, userId: string, proof: unknown): Promise<boolean> {
    const cred = (await this.store.get(credKey(ns, userId))) as CredentialRecord | null;
    if (!cred) {
      return false;
    }
    if (cred.type === "none") {
      return true;
    }
    if (typeof proof !== "string") {
      return false;
    }
    return cred.secretHash === sha256Hex(proof);
  }

  async addUserToGroup(ns: string, userId: string, groupId: string): Promise<void> {
    await this.groups.addMember(ns, groupId, userId);
  }

  async removeUserFromGroup(ns: string, userId: string, groupId: string): Promise<void> {
    await this.groups.removeMember(ns, groupId, userId);
  }
}

export class CordCommandManager implements CommandManager {
  constructor(private readonly store: CoordStore, private readonly groups: CordGroupManager) {}

  async defineCommand(ns: string, commandId: string, def: CommandDefinition): Promise<void> {
    await this.store.set(commandKey(ns, commandId), def);
  }

  async grant(ns: string, subject: string, commandId: string, grant: CommandGrant): Promise<void> {
    await this.store.set(grantKey(ns, subject, commandId), grant);
  }

  async revoke(ns: string, subject: string, commandId: string): Promise<void> {
    await this.store.del(grantKey(ns, subject, commandId));
  }

  async canInvoke(ns: string, ctx: { userId: string; groups?: string[]; scope?: unknown }, commandId: string, requestedMask = 0): Promise<boolean> {
    const subjects = await this.resolveSubjects(ns, ctx.userId, ctx.groups ?? []);
    const grants: Array<{ subject: string; grant: CommandGrant }> = [];
    for (const subject of subjects) {
      const grant = (await this.store.get(grantKey(ns, subject, commandId))) as CommandGrant | null;
      if (grant) {
        grants.push({ subject, grant });
      }
    }

    for (const { grant } of grants.filter((entry) => entry.grant.allow === false)) {
      if (maskAllows(grant, requestedMask) && scopeMatches(grant.scope, ctx.scope)) {
        return false;
      }
    }

    return grants.some(({ grant }) => grant.allow && maskAllows(grant, requestedMask) && scopeMatches(grant.scope, ctx.scope));
  }

  private async resolveSubjects(ns: string, userId: string, groups: string[]): Promise<string[]> {
    const result = new Set<string>([userId, ...groups.map((groupId) => (groupId.startsWith("grp:") ? groupId : `grp:${groupId}`))]);
    for (const group of await this.groups.listGroups(ns)) {
      if (await this.groups.isMember(ns, group.groupId, userId, { recursive: true })) {
        result.add(`grp:${group.groupId}`);
      }
      for (const explicit of groups) {
        const normalized = explicit.startsWith("grp:") ? explicit.slice(4) : explicit;
        if (await this.groups.isMember(ns, group.groupId, `grp:${normalized}`, { recursive: true })) {
          result.add(`grp:${group.groupId}`);
        }
      }
    }
    return [...result];
  }
}
