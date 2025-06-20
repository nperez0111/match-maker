import type { Storage } from "unstorage";

import { LowLevelDocumentStorage } from "..";
import { DocMessage, Message, ServerContext } from "match-maker";
import { Document } from "match-maker/server";
import {
  appendFauxUpdateList,
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxUpdateList,
  getEmptyFauxUpdateList,
} from "./encoding";

/**
 * A storage implementation that is backed by unstorage.
 * This is a zero-knowledge storage implementation, which means that it does not inspect the contents of the documents at any point.
 */
export class ZeroKnowledgeDocumentStorage extends LowLevelDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { ttl: number };

  constructor(storage: Storage, options?: { ttl?: number }) {
    super();
    this.storage = storage;
    this.options = { ttl: 5 * 1000, ...options };
  }

  /**
   * Lock a key for 5 seconds
   * @param key - The key to lock
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  private async lock(key: string, cb: () => Promise<void>): Promise<number> {
    const meta = await this.storage.getMeta(key);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.lock(key, cb);
    }
    const ttl = Date.now() + this.options.ttl;
    await this.storage.setMeta(key, { ttl });
    await cb();
    await this.storage.setMeta(key, { ttl: Date.now() });
    return ttl;
  }

  async onMessage<Context extends ServerContext>(
    message: Message<Context>,
    document: Document<Context>,
  ) {
    if (message.type !== "doc") {
      await document.broadcast(message);
      return;
    }

    if (!message.encrypted) {
      throw new Error("Message is not encrypted", {
        cause: {
          message,
        },
      });
    }

    await this.lock(document.id, async () => {
      const content =
        (await this.storage.getItemRaw(document.id)) ??
        getEmptyFauxUpdateList();

      if (message.payload.type === "sync-step-1") {
        const client = document.server.clients.get(message.context.clientId);
        if (!client) {
          throw new Error(`Client not found`, {
            cause: {
              clientId: message.context.clientId,
            },
          });
        }
        const fauxStateVector = decodeFauxStateVector(message.payload.sv);
        const updates = decodeFauxUpdateList(content);
        const updateIndex = updates.findIndex(
          (update) => update.messageId === fauxStateVector.messageId,
        );
        // Pick the updates that the client doesn't have
        const sendUpdates = updates.slice(
          0,
          // Didn't find any? Send them all
          updateIndex === -1 ? updates.length : updateIndex,
        );
        const encodedUpdates = encodeFauxUpdateList(sendUpdates);
        await client.send(
          new DocMessage(document.name, {
            type: "sync-step-2",
            update: encodedUpdates,
          }),
          document,
        );
        // Fetch from storage
        return;
      }

      // Decode, append, and store back the updates
      await this.storage.setItemRaw(
        document.id,
        appendFauxUpdateList(
          content,
          // TODO do we really need to decode the updates?
          decodeFauxUpdateList(message.payload.update),
        ),
      );
    });

    // Broadcast the message to all clients
    await document.broadcast(message);
  }
  async onUnload<Context extends ServerContext>(document: Document<Context>) {
    // TODO: noop
  }
}
