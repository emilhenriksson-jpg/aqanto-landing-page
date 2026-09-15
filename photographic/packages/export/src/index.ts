/**
 * Export: the event log plus the files, as a zip anyone can open.
 *
 * Built early on purpose. It is the feature that gets deferred until someone asks and
 * then cannot be retrofitted — an export is only portable if the log was kept in a shape
 * that streams out, and discovering otherwise is discovering it about someone who is
 * already leaving.
 *
 * Three things live here and nothing else does. A streaming zip writer, because an
 * archive of a ten-gigabyte account must never be resident. The archive format, with a
 * `format_version` in the manifest, because the reason to export your memory is trusting
 * you can read it in ten years. And the scope rule, which is the only genuinely
 * contested decision — see `EXPORT.md`.
 */

export {
  ARCHIVE_PATHS,
  EXPORT_FORMAT_VERSION,
  archiveDocumentPath,
  archiveFilename,
  ndjsonLine,
  renderReadme,
  safeSegment,
  type ExportManifest,
  type ExportScope,
  type ExportedRoom,
} from './archive.js';

export {
  ZIP32_LIMIT,
  ZipTooLargeError,
  ZipWriter,
  type ZipSink,
} from './zip.js';

export {
  buildExportArchive,
  type BuildRequest,
  type BuildResult,
} from './build.js';

export type {
  BlobStore,
  ExportDeps,
  ExportDocument,
  ExportEvent,
  ExportItem,
  ExportPerson,
  ExportRoom,
  ExportSource,
  Page,
} from './deps.js';
