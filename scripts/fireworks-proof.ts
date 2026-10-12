/** Synthetic-only live provider check. Never logs a credential or provider response body. */
import { loadEnvConfig } from "@next/env";
import { z } from "zod";
import { fireworksProvider } from "../lib/llm/providers/fireworks";
import { FIREWORKS_DEFAULT_MODEL } from "../lib/llm/fireworks-config";
import { assistantMessage, toolResultMessage, userMessage } from "../lib/llm/messages";
loadEnvConfig(process.cwd());
async function main() {
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) throw new Error("FIREWORKS_API_KEY is not configured");
  const model = process.env.FIREWORKS_MODEL || FIREWORKS_DEFAULT_MODEL;
  const result = await fireworksProvider.complete({ apiKey, model, maxTokens: 2048,
    systemPrompt: "You are checking synthetic finance data. Respond in JSON.",
    messages: [{role:"user",content:'Invoice amount is 12500 cents and purchase order is 12000 cents. Return {"differenceCents":500,"requiresReview":true}.'}],
    responseFormat:"json", jsonSchema:{type:"object",properties:{differenceCents:{type:"integer"},requiresReview:{type:"boolean"}},required:["differenceCents","requiresReview"],additionalProperties:false},
  });
  const parsed=z.object({differenceCents:z.literal(500),requiresReview:z.literal(true)}).parse(JSON.parse(result.content));
  console.log(JSON.stringify({check:"structured finance output",passed:!!parsed,model:result.modelUsed,tokens:result.tokensIn+result.tokensOut}));
  const tool=await fireworksProvider.complete({apiKey,model,maxTokens:4096,systemPrompt:"Use the lookup_invoice tool to inspect the synthetic invoice. Do not invent invoice data.",messages:[{role:"user",content:"Look up invoice DEMO-42."}],tools:[{name:"lookup_invoice",description:"Read a synthetic invoice by id",parameters:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}}],toolChoice:"required"});
  const call=tool.toolCalls?.find(c=>c.name==="lookup_invoice");
  if(call?.arguments.id!=="DEMO-42") throw new Error("Tool call did not match the synthetic invoice");
  console.log(JSON.stringify({check:"native tool calling",passed:true,model:tool.modelUsed,tokens:tool.tokensIn+tool.tokensOut}));
  const answer = await fireworksProvider.complete({
    apiKey, model, maxTokens: 2048, messages: [],
    systemPrompt: "Use only the synthetic invoice returned by the tool. Report its ID and the invoice minus purchase-order amount, in integer cents. Respond in JSON.",
    conversation: [
      userMessage("Look up invoice DEMO-42."),
      assistantMessage(tool.content, tool.toolCalls, tool.sidecar),
      toolResultMessage([{ toolCallId: call.id, name: call.name, content: JSON.stringify({ id: "DEMO-42", amountCents: 48765, purchaseOrderCents: 48200 }) }]),
      userMessage("Return the invoice ID and differenceCents."),
    ],
    responseFormat: "json",
    jsonSchema: { type: "object", properties: { invoiceId: { type: "string" }, differenceCents: { type: "integer" } }, required: ["invoiceId", "differenceCents"], additionalProperties: false },
    signal: AbortSignal.timeout(60_000),
  });
  z.object({ invoiceId: z.literal("DEMO-42"), differenceCents: z.literal(565) }).parse(JSON.parse(answer.content));
  console.log(JSON.stringify({ check: "tool result to structured answer", passed: true, model: answer.modelUsed, tokens: answer.tokensIn + answer.tokensOut, replayedReasoning: !!tool.sidecar }));
}
main().catch(e=>{console.error(e instanceof Error ? e.message : "Fireworks validation failed");process.exitCode=1});
