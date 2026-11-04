import { type BusinessId, newUserId, type UserId } from "@carnet/domain";
import { and, asc, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { type UserRole, users } from "../schema/index";
import type { RepoCtx } from "./context";

export interface User {
  readonly id: UserId;
  readonly businessId: BusinessId;
  readonly email: string;
  readonly name: string | null;
  readonly role: UserRole;
  readonly createdAt: Date;
}

type Row = typeof users.$inferSelect;
const toUser = (r: Row): User => ({
  id: r.id as UserId,
  businessId: r.businessId as BusinessId,
  email: r.email,
  name: r.name,
  role: r.role,
  createdAt: r.createdAt,
});

export interface NewUser {
  id?: UserId;
  email: string;
  name?: string | null;
  role: UserRole;
}

export async function createUser(ctx: RepoCtx, input: NewUser): Promise<User> {
  try {
    const [row] = await ctx.db
      .insert(users)
      .values({
        id: input.id ?? newUserId(),
        businessId: ctx.businessId,
        email: input.email.toLowerCase(),
        name: input.name ?? null,
        role: input.role,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toUser(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getUser(ctx: RepoCtx, id: UserId): Promise<User | null> {
  const [row] = await ctx.db
    .select()
    .from(users)
    .where(and(eq(users.businessId, ctx.businessId), eq(users.id, id)));
  return row ? toUser(row) : null;
}

export async function listUsers(ctx: RepoCtx): Promise<User[]> {
  const rows = await ctx.db
    .select()
    .from(users)
    .where(eq(users.businessId, ctx.businessId))
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(toUser);
}

export async function updateUserRole(
  ctx: RepoCtx,
  id: UserId,
  role: UserRole,
): Promise<User | null> {
  const [row] = await ctx.db
    .update(users)
    .set({ role })
    .where(and(eq(users.businessId, ctx.businessId), eq(users.id, id)))
    .returning();
  return row ? toUser(row) : null;
}

/** Returns true when a row of this business was deleted. */
export async function deleteUser(ctx: RepoCtx, id: UserId): Promise<boolean> {
  const rows = await ctx.db
    .delete(users)
    .where(and(eq(users.businessId, ctx.businessId), eq(users.id, id)))
    .returning({ id: users.id });
  return rows.length > 0;
}
