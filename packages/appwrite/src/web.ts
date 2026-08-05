import { Account, Client, TablesDB } from "appwrite";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;
if (!endpoint || !projectId) throw new Error("Missing public Appwrite configuration");

export const webClient = new Client().setEndpoint(endpoint).setProject(projectId);
export const account = new Account(webClient);
export const tablesDb = new TablesDB(webClient);

