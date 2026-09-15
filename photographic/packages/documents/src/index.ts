/**
 * Documents as memory: the parts that do not care where rows live.
 *
 * A document is not a memory and is deliberately not treated as one. Memories are
 * small, curated and injected whole; documents are large, uncurated, and retrieved in
 * pieces. Blurring the two is how a PDF ends up occupying the profile every model reads
 * on every session.
 *
 * Three things live here, and each is here rather than in a storage adapter for the
 * same reason — swapping Supabase Storage for R2, or Postgres for something else, must
 * not change any of them:
 *
 *   - `BlobStore`, the storage port. Content-addressed, so the key is the checksum and
 *     re-uploading a file is idempotent. `LocalBlobStore` for development,
 *     `S3BlobStore` for anything S3-compatible (R2, MinIO, AWS); Supabase Storage is
 *     another implementation, in `@photographic/supabase`, and this package does not
 *     know it exists.
 *   - Extraction and chunking, which turn a file into searchable text without ever
 *     failing the upload.
 *   - The storage limit, counted per person and per distinct object.
 */

export {
  blobKeyFor,
  checksumOf,
  createS3BlobStore,
  createSpooledUpload,
  exportKeyFor,
  LocalBlobStore,
  MULTIPART_PART_BYTES,
  S3BlobStore,
  type BlobStore,
  type BlobUpload,
  type S3BlobStoreConfig,
  type S3BlobStoreOptions,
  type SignedFetcher,
  type StoredBlob,
} from './blob-store.js';

export type { DocumentLlm, StorageLedger } from './deps.js';

export {
  ExtractionError,
  unsupportedType,
  noTextFound,
  tooLarge,
  corrupt,
  type ExtractionFailureReason,
} from './errors.js';

export {
  DEFAULT_EXTRACTION_LIMITS,
  DEFAULT_EXTRACTORS,
  DocxExtractor,
  HtmlExtractor,
  PdfExtractor,
  TextExtractor,
  capCharacters,
  decodeText,
  extensionOf,
  extractText,
  htmlToText,
  inspectArchive,
  normaliseMimeType,
  pickExtractor,
  tidyText,
  NotAnArchiveError,
  type ArchiveSummary,
  type ExtractOptions,
  type ExtractedDocument,
  type ExtractionLimits,
  type ExtractionOutcome,
  type ExtractionRequest,
  type ExtractionResult,
  type Extractor,
} from './extract/index.js';

export {
  CHUNK_CHARS,
  CHUNK_OVERLAP,
  chunkDocument,
  chunkText,
  splitByCharacters,
  type ChunkOptions,
  type DocumentChunk,
} from './chunk.js';

export {
  STORAGE_LIMIT_BYTES,
  StorageLimitError,
  fitsWithinLimit,
  formatBytes,
  storageLimitReached,
  type StorageUsage,
} from './limit.js';

export {
  assertAcceptableUpload,
  ingestDocument,
  type IngestOptions,
  type IngestedDocument,
} from './ingest.js';
