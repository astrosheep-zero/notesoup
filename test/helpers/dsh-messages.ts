import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Behavior = { text: string; inputTokens?: number } | { tool: string; input: unknown; inputTokens?: number } | { error: string };
export type WireRequest = { system?: string | { text: string }[]; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };

/** Same Messages/SSE approach as /tmp/dsh-spike/mock/llm-server.mjs; no credentials or external traffic. */
export async function messagesServer() {
	const requests: WireRequest[] = [];
	const script: Behavior[] = [];
	const server: Server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		if (request.method !== "POST" || !request.url?.endsWith("/messages")) { response.writeHead(404).end(); return; }
		requests.push(JSON.parse(body));
		const behavior = script.shift() ?? { text: "finished" };
		if ("error" in behavior) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: behavior.error } })); return; }
		response.writeHead(200, { "content-type": "text/event-stream" });
		const send = (value: { type: string; [key: string]: unknown }) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
		send({ type: "message_start", message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "mock", content: [], usage: { input_tokens: behavior.inputTokens ?? 10, output_tokens: 0 } } });
		const tool = "tool" in behavior;
		send({ type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: `call-${requests.length}`, name: behavior.tool, input: {} } : { type: "text", text: "" } });
		send({ type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(behavior.input) } : { type: "text_delta", text: behavior.text } });
		send({ type: "content_block_stop", index: 0 });
		send({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		send({ type: "message_stop" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { requests, script, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }) };
}
