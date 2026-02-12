import { execSync } from "node:child_process";
import { getTestDatabaseUrl } from "./prisma-test-config.js";
export default async () => {
    const databaseUrl = getTestDatabaseUrl();
    execSync("./node_modules/.bin/prisma migrate reset --force --skip-generate", {
        stdio: "inherit",
        env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
        },
    });
};
