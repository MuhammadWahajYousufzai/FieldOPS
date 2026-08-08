import "server-only";
import { Account, Client, Storage, TablesDB, Users } from "node-appwrite";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function createAdminClient(): Client {
  return new Client()
    .setEndpoint(required("APPWRITE_ENDPOINT"))
    .setProject(required("APPWRITE_PROJECT_ID"))
    .setKey(required("APPWRITE_API_KEY"));
}

export const createAdminTablesDb = (): TablesDB => new TablesDB(createAdminClient());
export const createAdminUsers = (): Users => new Users(createAdminClient());
export const createAdminAccount = (): Account => new Account(createAdminClient());
export const createAdminStorage = (): Storage => new Storage(createAdminClient());

export function createSessionTablesDb(session: string): TablesDB {
  return new TablesDB(createSessionClient(session));
}

export function createSessionClient(session: string, userAgent?: string): Client {
  const client = new Client()
    .setEndpoint(required("APPWRITE_ENDPOINT"))
    .setProject(required("APPWRITE_PROJECT_ID"))
    .setSession(session);
  if (userAgent) client.setForwardedUserAgent(userAgent);
  return client;
}

export const createSessionAccount = (session: string, userAgent?: string): Account =>
  new Account(createSessionClient(session, userAgent));
