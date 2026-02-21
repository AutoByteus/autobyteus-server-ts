export type PersistenceProfile = "sqlite" | "postgresql" | "file";

const SUPPORTED_PERSISTENCE_PROFILES: PersistenceProfile[] = ["sqlite", "postgresql", "file"];
const SQL_PROFILES = new Set<PersistenceProfile>(["sqlite", "postgresql"]);

export const normalizePersistenceProfile = (rawValue: string | null | undefined): PersistenceProfile => {
  const normalized = (rawValue ?? "sqlite").trim().toLowerCase();
  if (normalized === "sqlite" || normalized === "postgresql" || normalized === "file") {
    return normalized;
  }

  throw new Error(
    `PERSISTENCE_PROVIDER must be one of: ${SUPPORTED_PERSISTENCE_PROFILES.join(", ")}. Received: '${rawValue ?? ""}'.`,
  );
};

export const getPersistenceProfile = (env: NodeJS.ProcessEnv = process.env): PersistenceProfile =>
  normalizePersistenceProfile(env.PERSISTENCE_PROVIDER);

export const isSqlPersistenceProfile = (profile: PersistenceProfile): boolean => SQL_PROFILES.has(profile);

export const isFilePersistenceProfile = (profile: PersistenceProfile): boolean => profile === "file";
