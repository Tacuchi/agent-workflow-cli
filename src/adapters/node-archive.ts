import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { ArchivePort, ByteIdentity } from "../ports/archive.js";

async function reader(path: string) {
  return (await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)).createReadStream();
}

function same(actual: ByteIdentity, expected: ByteIdentity): void {
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw Object.assign(new Error("El original comprimido no coincide con su hash y tamaño"), {
      code: "COMPACTION_INTEGRITY",
    });
  }
}

function meter(limit = Number.MAX_SAFE_INTEGER) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        callback(
          Object.assign(new Error("El contenido excede el límite declarado"), {
            code: "COMPACTION_SIZE_LIMIT",
          }),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  return { stream, identity: (): ByteIdentity => ({ bytes, sha256: hash.digest("hex") }) };
}

const sink = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

async function exclusiveStream(destination: string, write: (temp: string) => Promise<void>) {
  const temp = join(dirname(destination), `.aw-compaction-${randomUUID()}.tmp`);
  try {
    await write(temp);
    await link(temp, destination);
  } catch (error) {
    await cleanupTemp(temp, error);
    throw error;
  }
  await cleanupTemp(temp);
}

async function cleanupTemp(path: string, primary?: unknown) {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (primary !== undefined)
      throw new AggregateError([primary, error], "Fallaron el archivo y la limpieza temporal");
    throw error;
  }
}

export class NodeArchive implements ArchivePort {
  async identify(path: string): Promise<ByteIdentity> {
    const measured = meter();
    await pipeline(await reader(path), measured.stream, sink());
    return measured.identity();
  }

  async compress(source: string, destination: string): Promise<ByteIdentity> {
    await exclusiveStream(destination, async (temp) =>
      pipeline(
        await reader(source),
        createGzip(),
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      ),
    );
    return this.identify(destination);
  }

  async verify(archive: string, original: ByteIdentity): Promise<void> {
    const measured = meter(original.bytes);
    await pipeline(await reader(archive), createGunzip(), measured.stream, sink());
    same(measured.identity(), original);
  }

  async restore(archive: string, destination: string, original: ByteIdentity): Promise<void> {
    await exclusiveStream(destination, async (temp) => {
      const measured = meter(original.bytes);
      await pipeline(
        await reader(archive),
        createGunzip(),
        measured.stream,
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
      );
      same(measured.identity(), original);
    });
  }

  async read(archive: string, original: ByteIdentity, maxBytes: number): Promise<Uint8Array> {
    if (original.bytes > maxBytes) {
      throw Object.assign(new Error("Usá restore para consultar un original mayor al límite"), {
        code: "COMPACTION_SIZE_LIMIT",
      });
    }
    const measured = meter(Math.min(maxBytes, original.bytes));
    const chunks: Buffer[] = [];
    await pipeline(
      await reader(archive),
      createGunzip(),
      measured.stream,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    same(measured.identity(), original);
    return Buffer.concat(chunks);
  }
}
