import Surreal from "surrealdb";
import {
  readSurrealConnectionEnv,
  surrealEnvMissingMessage,
} from "@/lib/surreal-env";

let db: Surreal | null = null;

export async function getDB(): Promise<Surreal> {
  if (db) {
    return db;
  }

  db = new Surreal();

  try {
    const { url, namespace, database, username, password } =
      readSurrealConnectionEnv();

    if (!url || !namespace || !database || !username || !password) {
      throw new Error(surrealEnvMissingMessage());
    }

    // Connect to the database
    await db.connect(url, { reconnect: true });

    // Select a specific namespace / database
    await db.use({
      namespace,
      database,
    });

    // Signin as root user
    await db.signin({
      username,
      password,
    });

    console.log("Connected to SurrealDB");
    return db;
  } catch (error) {
    console.error("Failed to connect to SurrealDB:", error);
    db = null;
    throw error;
  }
}

export default getDB;