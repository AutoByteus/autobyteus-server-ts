import "reflect-metadata";
import fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureServerHostEnvVar } from "./utils/env-utils.js";
import { appConfigProvider } from "./config/app-config-provider.js";
import { runMigrations } from "./startup/migrations.js";
import { scheduleBackgroundTasks } from "./startup/background-runner.js";
import { registerRestRoutes } from "./api/rest/index.js";
import { registerGraphql } from "./api/graphql/index.js";
import { registerWebsocketRoutes } from "./api/websocket/index.js";
import { workspaceManager } from "./workspaces/workspace-manager.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

type ServerOptions = {
  host: string;
  port: number;
  dataDir?: string;
};

function parseArgs(argv: string[]): ServerOptions {
  const options: ServerOptions = { host: "0.0.0.0", port: 8000 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      options.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--host" && argv[i + 1]) {
      options.host = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--data-dir" && argv[i + 1]) {
      options.dataDir = argv[i + 1];
      i += 1;
    }
  }

  return options;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: true });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart);
  await app.register(websocket);

  await app.register(registerRestRoutes, { prefix: "/rest" });
  await registerWebsocketRoutes(app);
  await registerGraphql(app);

  return app;
}

export async function startServer(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  ensureServerHostEnvVar(options.host, options.port);

  const config = appConfigProvider.config;
  if (options.dataDir) {
    try {
      config.setCustomAppDataDir(options.dataDir);
    } catch (error) {
      logger.error(`Error setting custom app data directory: ${String(error)}`);
      process.exit(1);
    }
  }

  try {
    config.initialize();
  } catch (error) {
    logger.error(`Failed to initialize AppConfig: ${String(error)}`);
    process.exit(1);
  }

  runMigrations();
  await scheduleBackgroundTasks();
  await workspaceManager.getOrCreateTempWorkspace();

  const app = await buildApp();
  await app.listen({ host: options.host, port: options.port });
  logger.info(`Server listening on ${options.host}:${options.port}`);
}

const modulePath = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === modulePath) {
  startServer().catch((error) => {
    logger.error(`Failed to start server: ${String(error)}`);
    process.exit(1);
  });
}
