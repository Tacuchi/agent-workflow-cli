import { StringDecoder } from "node:string_decoder";
import { MAX_TOOL_TRANSPORT_INPUT_BYTES } from "../domain/database-tools.js";
import { createDatabaseMcpServer } from "./database-mcp-server.js";
import type { DatabaseToolCatalog } from "./database-tool-catalog.js";

// The RPC envelope is allowed a small fixed overhead beyond the canonical 1
// MiB tool input. The shared catalog still makes the exact input decision.
const MAX_MCP_INPUT_FRAME_BYTES = MAX_TOOL_TRANSPORT_INPUT_BYTES;

export interface DatabaseMcpStdioDeps {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  diagnostics: NodeJS.WritableStream;
  catalog: DatabaseToolCatalog;
  connection: string;
  onHostLoadObserved?: () => void | Promise<void>;
}

interface FrameState {
  buffer: string;
  bufferedBytes: number;
  discardingOversizedLine: boolean;
  decoder: StringDecoder;
}

interface FrameConsumption {
  frames: string[];
  oversizedFrames: number;
}

/**
 * Line-framed stdio transport. stdout is exclusively JSON-RPC; malformed input
 * is diagnosed on stderr and cannot corrupt a later valid request.
 */
export function runDatabaseMcpStdio(deps: DatabaseMcpStdioDeps): Promise<void> {
  const server = createDatabaseMcpServer({
    send: (message) => deps.output.write(`${JSON.stringify(message)}\n`),
    catalog: deps.catalog,
    connection: deps.connection,
    ...(deps.onHostLoadObserved === undefined
      ? {}
      : { onHostLoadObserved: deps.onHostLoadObserved }),
  });
  const frames: FrameState = {
    buffer: "",
    bufferedBytes: 0,
    discardingOversizedLine: false,
    decoder: new StringDecoder("utf8"),
  };
  let queue = Promise.resolve();

  function enqueue(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      deps.diagnostics.write("aw mcp serve-db: línea JSON-RPC inválida descartada\n");
      return;
    }
    // Cancellation must not wait behind a running database call in the serial
    // queue. All other frames retain order, including the lifecycle sequence.
    if (isCancellationNotification(message)) {
      void server.handle(message).catch(() => {
        deps.diagnostics.write("aw mcp serve-db: línea JSON-RPC inválida descartada\n");
      });
      return;
    }
    queue = queue.then(async () => {
      try {
        await server.handle(message);
      } catch {
        deps.diagnostics.write("aw mcp serve-db: línea JSON-RPC inválida descartada\n");
      }
    });
  }

  return new Promise((resolve) => {
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      // An unterminated tail is not a JSON-RPC frame. Do not enqueue it, but
      // flush the decoder so no multibyte bytes remain retained by the stream.
      if (!frames.discardingOversizedLine) frames.buffer += frames.decoder.end();
      void queue.then(() => resolve());
    };
    deps.input.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      enqueueConsumption(consumeChunk(frames, bytes), deps, enqueue);
    });
    deps.input.on("end", finish);
    deps.input.on("close", finish);
  });
}

function isCancellationNotification(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    (message as { method?: unknown }).method === "notifications/cancelled"
  );
}

/**
 * Splits raw bytes at newline boundaries before decoding. This matters for an
 * oversized frame already terminated in the same chunk: appending/splitting a
 * decoded 100 MiB string merely to reject it would defeat the input bound.
 */
function consumeChunk(state: FrameState, bytes: Buffer): FrameConsumption {
  const frames: string[] = [];
  let oversizedFrames = 0;
  let offset = 0;

  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    const end = newline < 0 ? bytes.length : newline + 1;
    const segment = bytes.subarray(offset, end);

    if (state.discardingOversizedLine) {
      if (newline >= 0) {
        state.discardingOversizedLine = false;
        state.decoder = new StringDecoder("utf8");
      }
      offset = end;
      continue;
    }

    if (state.bufferedBytes + segment.length > MAX_MCP_INPUT_FRAME_BYTES) {
      state.buffer = "";
      state.bufferedBytes = 0;
      state.decoder = new StringDecoder("utf8");
      state.discardingOversizedLine = newline < 0;
      oversizedFrames += 1;
      offset = end;
      continue;
    }

    state.bufferedBytes += segment.length;
    state.buffer += state.decoder.write(segment);
    if (newline >= 0) consumeCompleteLine(state, frames);
    offset = end;
  }

  return { frames, oversizedFrames };
}

function consumeCompleteLine(state: FrameState, frames: string[]): void {
  const newline = state.buffer.indexOf("\n");
  if (newline < 0) return;
  const trimmed = state.buffer.slice(0, newline).replace(/\r$/, "").trim();
  state.buffer = state.buffer.slice(newline + 1);
  state.bufferedBytes = 0;
  if (trimmed.length > 0) frames.push(trimmed);
}

function reportOversizedFrames(output: NodeJS.WritableStream, count: number): void {
  for (let index = 0; index < count; index += 1) {
    output.write("aw mcp serve-db: frame JSON-RPC demasiado grande descartado\n");
  }
}

function enqueueConsumption(
  consumed: FrameConsumption,
  deps: Pick<DatabaseMcpStdioDeps, "diagnostics">,
  enqueue: (frame: string) => void,
): void {
  reportOversizedFrames(deps.diagnostics, consumed.oversizedFrames);
  for (const frame of consumed.frames) enqueue(frame);
}
