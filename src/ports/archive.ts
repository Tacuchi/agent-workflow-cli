export interface ByteIdentity {
  bytes: number;
  sha256: string;
}

/** Streaming operations, with bounded decompression and exclusive destinations. */
export interface ArchivePort {
  identify(path: string): Promise<ByteIdentity>;
  compress(source: string, destination: string): Promise<ByteIdentity>;
  verify(archive: string, original: ByteIdentity): Promise<void>;
  restore(archive: string, destination: string, original: ByteIdentity): Promise<void>;
  read(archive: string, original: ByteIdentity, maxBytes: number): Promise<Uint8Array>;
}
