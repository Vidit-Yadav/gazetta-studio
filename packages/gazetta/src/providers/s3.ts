import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { Readable } from 'node:stream'
import { Agent as HttpAgent } from 'node:http'
import type { ByteRange, DirEntry, StorageProvider } from '../types.js'
import { nodeReadableToWeb, webReadableToNode } from './_stream-interop.js'

export interface S3ProviderOptions {
  endpoint: string
  region?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export function createS3Provider(options: S3ProviderOptions): StorageProvider & { init(): Promise<void> } {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region ?? 'auto',
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    forcePathStyle: options.forcePathStyle ?? true,
    // EXPERIMENT ONLY (exp/minio-flake-probe): fresh connection per request.
    ...(process.env.GAZETTA_S3_NO_KEEPALIVE ? { requestHandler: { httpAgent: new HttpAgent({ keepAlive: false }) } } : {}),
  })
  const bucket = options.bucket

  return {
    async init() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }))
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
          // Ignore — bucket may already exist
        }
      }
    },

    async readFile(path: string): Promise<string> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalizePath(path) }))
        return await response.Body!.transformToString('utf-8')
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code === 'NoSuchKey') throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read ${path}: ${(err as Error).message}`)
      }
    },

    async readDir(path: string): Promise<DirEntry[]> {
      const prefix = normalizePath(path)
      const prefixWithSlash = prefix ? `${prefix}/` : ''
      const entries = new Map<string, boolean>()

      // Paginate — S3/R2 returns max 1000 keys per call
      let continuationToken: string | undefined
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefixWithSlash,
            ContinuationToken: continuationToken,
          }),
        )

        for (const obj of response.Contents ?? []) {
          const relativeName = obj.Key!.slice(prefixWithSlash.length)
          const firstSegment = relativeName.split('/')[0]
          if (!firstSegment) continue
          const isDirectory = relativeName.includes('/')
          if (entries.has(firstSegment) && entries.get(firstSegment)) continue
          entries.set(firstSegment, isDirectory)
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)

      return [...entries.entries()].map(([name, isDirectory]) => ({ name, isDirectory }))
    },

    async exists(path: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: normalizePath(path) }))
        return true
      } catch {
        // Check if it's a "directory"
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: normalizePath(path) + '/',
            MaxKeys: 1,
          }),
        )
        return (response.Contents?.length ?? 0) > 0
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      // Encode to Buffer so the SDK sees a known length and skips the
      // "Stream of unknown length" warning. Same wire bytes either way —
      // strings get UTF-8-encoded by the SDK on the way out, we're just
      // doing it ourselves to make the length explicit.
      const body = Buffer.from(content, 'utf-8')
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: normalizePath(path),
          Body: body,
          ContentLength: body.length,
          ContentType: 'text/plain; charset=utf-8',
        }),
      )
    },

    async readBytes(path: string): Promise<Uint8Array> {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: normalizePath(path) }))
        if (!response.Body) throw new Error(`Empty body for ${path}`)
        // SDK's transformToByteArray is the canonical bytes accessor —
        // single round-trip, no manual stream collection.
        return await (response.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code === 'NoSuchKey') throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read bytes from ${path}: ${(err as Error).message}`)
      }
    },

    async writeBytes(path: string, content: Uint8Array): Promise<void> {
      // Single-PUT for bounded bytes. No multipart — that's writeStream's
      // job for unbounded uploads. ContentLength is set explicitly so the
      // SDK skips the "unknown length" warning.
      const body = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: normalizePath(path),
          Body: body,
          ContentLength: body.length,
        }),
      )
    },

    async mkdir(_path: string): Promise<void> {
      // S3 has no directories — implicit from key prefixes
    },

    async rm(path: string): Promise<void> {
      const key = normalizePath(path)
      // The path as a single object (a file)…
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
      } catch {
        /* ignore */
      }
      // …and as a "directory": every key UNDER it. The trailing '/' is the
      // folder boundary — listing by the bare key also matched siblings that
      // merely share the prefix ('home' → 'homepage/…', '.hash' → '.hash.fr')
      // and deleted them. Paginate: one listing returns at most 1000 keys.
      if (!key) return // never treat rm('') as "delete the whole bucket"
      let continuationToken: string | undefined
      do {
        const response = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: `${key}/`, ContinuationToken: continuationToken }),
        )
        // One batch per listing page (both cap at 1000 keys): two requests
        // for 1005 objects instead of 1005. Surface per-key failures — a
        // partial delete must not look like success.
        const keys = (response.Contents ?? []).map(o => ({ Key: o.Key! }))
        if (keys.length > 0) {
          const result = await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
          )
          if (result.Errors?.length) {
            const first = result.Errors[0]
            throw new Error(
              `Cannot delete ${result.Errors.length} object(s) under ${key}/: ${first.Key} — ${first.Message}`,
            )
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
    },

    async readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
      const Key = normalizePath(path)
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key,
            // RFC 9110 §14.1.2 — inclusive bytes range. Same semantics as `ByteRange`.
            Range: range ? `bytes=${range.start}-${range.end}` : undefined,
          }),
        )
        if (!response.Body) throw new Error(`Empty body for ${path}`)
        // In Node runtime the SDK returns Body as a Node Readable. The
        // browser/edge build returns a web ReadableStream. We only run
        // server-side (publish, dev-server, gazetta serve) — Node Readable
        // is the deterministic path. Bridge to the lib-dom global so
        // callers see one type regardless of provider.
        return nodeReadableToWeb(response.Body as Readable)
      } catch (err: unknown) {
        const code = (err as { name?: string }).name
        if (code === 'NoSuchKey') throw new Error(`File not found: ${path}`)
        throw new Error(`Cannot read stream from ${path}: ${(err as Error).message}`)
      }
    },

    async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
      const Key = normalizePath(path)
      try {
        // `Upload` is a hybrid — single-PUT below `partSize` (default 5 MiB),
        // multipart above. Memory bound is `partSize × queueSize` (default
        // 5 MiB × 4 = 20 MiB) regardless of total bytes, so a 4 GB video
        // upload doesn't OOM. `abortOnFailure: true` (default) calls
        // AbortMultipartUpload on error so we don't leak orphan parts.
        const upload = new Upload({
          client,
          params: {
            Bucket: bucket,
            Key,
            Body: webReadableToNode(stream),
          },
        })
        await upload.done()
      } catch (err) {
        throw new Error(`Cannot write stream to ${path}: ${(err as Error).message}`)
      }
    },
  }
}

function normalizePath(path: string): string {
  return path.replace(/^(\.\/|\/)+/, '')
}
