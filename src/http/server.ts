import { ServerContext } from "teleportal";
import { Server } from "teleportal/server";
import { getHTTPEndpoint, getSSEHandler } from "./handlers";

/**
 * Callback function type that takes a request and returns a list of documents to subscribe to with optional encryption flag
 */
export type DocumentSubscriptionCallback = (request: Request) => { document: string; encrypted?: boolean }[];

/**
 * Default implementation that extracts document IDs from URL query parameters
 * Supports multiple 'documents' parameters: ?documents=id-1&documents=id-2
 * Also supports comma-separated values: ?documents=id-1,id-2
 * Supports encryption suffix: ?documents=id-1:encrypted,id-2,id-3:encrypted
 * Documents with ":encrypted" suffix will be marked as encrypted
 */
export function getDocumentsFromQueryParams(request: Request): { document: string; encrypted?: boolean }[] {
  const url = new URL(request.url);
  const documentParams = url.searchParams.getAll('documents');
  
  const documents: { document: string; encrypted?: boolean }[] = [];
  
  for (const param of documentParams) {
    // Handle both single IDs and comma-separated lists
    const ids = param.split(',').map(id => id.trim()).filter(id => id.length > 0);
    
    for (const id of ids) {
      // Check if the document has an ":encrypted" suffix
      if (id.endsWith(':encrypted')) {
        const documentName = id.slice(0, -10); // Remove ':encrypted' suffix
        if (documentName.length > 0) {
          documents.push({ document: documentName, encrypted: true });
        }
      } else {
        documents.push({ document: id, encrypted: false });
      }
    }
  }
  
  // Remove duplicates based on document name (keep the one with encryption preference)
  const uniqueDocuments = new Map<string, { document: string; encrypted?: boolean }>();
  for (const doc of documents) {
    const existing = uniqueDocuments.get(doc.document);
    // If document already exists, prefer the encrypted version
    if (!existing || (doc.encrypted && !existing.encrypted)) {
      uniqueDocuments.set(doc.document, doc);
    }
  }
  
  return Array.from(uniqueDocuments.values());
}

export function getHandlers<Context extends ServerContext>({
  server,
  getDocumentsToSubscribe = getDocumentsFromQueryParams,
}: {
  server: Server<Context>;
  getDocumentsToSubscribe?: DocumentSubscriptionCallback;
}): (req: Request) => Response | Promise<Response> {
  const sseEndpoint = getSSEHandler({
    server,
    validateRequest: async (req) => {
      return { 
        userId: "test", 
        room: "test",
      } as Context;
    },
    getDocumentsToSubscribe,
  });
  
  const httpEndpoint = getHTTPEndpoint({
    server,
    validateRequest: async (req) => {
      return { userId: "test", room: "test" } as Context;
    },
  });

  return async (req: Request) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/sse") {
      return await sseEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return await httpEndpoint(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}
