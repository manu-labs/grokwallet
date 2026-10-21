import { handleRequest } from "./_lib/_server.js";

export function onRequest(context) {
  return handleRequest(context.request, context.env);
}
