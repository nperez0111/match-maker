import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";

import { Server } from "teleportal/server";
import {
  EncryptedDocumentStorage,
  UnstorageDocumentStorage,
} from "teleportal/storage";
import {
  checkPermissionWithTokenManager,
  createTokenManager,
  TokenPayload,
} from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import homepage from "../src/index.html";
import { logger } from "../src/backend/logger";

const db = createDatabase(
  bunSqlite({
    name: "yjs.db",
  }),
);

const storage = createStorage({
  driver: dbDriver({
    database: db,
    tableName: "yjs",
  }),
});

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server<TokenPayload & { clientId: string }>({
  getStorage: async (ctx) => {
    // In production, use the memory storage, I don't want your files
    const backingStorage =
      Bun.env.NODE_ENV === "production" ? memoryStorage : storage;

    if (ctx.document.includes("encrypted")) {
      return new EncryptedDocumentStorage(backingStorage);
    }
    return new UnstorageDocumentStorage(backingStorage, {
      scanKeys: false,
    });
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  logger: logger,
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
);

const instance = Bun.serve({
  routes: {
    // In development, serve the homepage
    "/": Bun.env.NODE_ENV === "production" ? undefined : homepage,
  },
  websocket: ws.websocket,
  async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const distDir = import.meta.dir + "/../dist";

    // Just serve the index.html file for the root path
    if (pathname === "/") {
      return new Response(Bun.file(distDir + "/index.html"));
    }

    // Look in the dist folder for the file
    const filePath = distDir + pathname;
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    // Otherwise, just return a 404
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running on http://${instance.hostname}:${instance.port}`);
