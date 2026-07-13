import neo4j, { type Driver, type Session } from "neo4j-driver";

let driver: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI?.trim() || "bolt://127.0.0.1:7687";
    const user = process.env.NEO4J_USER?.trim() || "neo4j";
    const password = process.env.NEO4J_PASSWORD?.trim() || "clientgraph";

    driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      disableLosslessIntegers: true,
    });
  }

  return driver;
}

export function openSession(): Session {
  return getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE });
}

export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const session = openSession();

  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

export async function verifyNeo4jConnectivity(): Promise<boolean> {
  try {
    await getNeo4jDriver().verifyConnectivity();
    return true;
  } catch {
    return false;
  }
}

export async function closeNeo4jDriver(): Promise<void> {
  if (!driver) {
    return;
  }

  await driver.close();
  driver = null;
}
