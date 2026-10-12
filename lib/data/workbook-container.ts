import { inflateRawSync } from "node:zlib";
import { DATA_LIMITS, DataSourceError } from "./types";

/** Shared preflight: bound real ZIP expansion before either spreadsheet parser sees bytes. */
export function validateWorkbookContainer(bytes: Uint8Array, format: "xls" | "xlsx"): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "xls") {
    if (buffer.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1") throw new DataSourceError("The file does not appear to be an XLS workbook. Save it as XLSX or CSV rather than renaming its extension.");
    return;
  }
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0x4b50) throw new DataSourceError("The file does not appear to be an XLSX workbook.");
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new DataSourceError("The XLSX archive is incomplete or invalid.");
  const entries = buffer.readUInt16LE(end + 10);
  if (entries > 2000) limit("The workbook archive contains too many entries. Split the workbook into smaller files.");
  let offset = buffer.readUInt32LE(end + 16);
  if (entries === 0xffff || offset === 0xffffffff) limit("ZIP64 workbooks are not supported. Export smaller workbooks or CSV.");
  let expanded = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new DataSourceError("The XLSX archive directory is invalid.");
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) limit("ZIP64 workbooks are not supported.");
    expanded += size;
    if (expanded > DATA_LIMITS.maxLoadedBytes) limit("The XLSX archive expands beyond 40 MiB. Split the workbook before uploading.");
    const method = buffer.readUInt16LE(offset + 10);
    const flags = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const localOffset = buffer.readUInt32LE(offset + 42);
    if (flags & 1) throw new DataSourceError("Encrypted spreadsheet archives are not supported. Export an unencrypted workbook.");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new DataSourceError("The spreadsheet archive contains an invalid entry.");
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) throw new DataSourceError("A spreadsheet archive entry is incomplete.");
    let decodedSize: number;
    try {
      if (method === 0) decodedSize = compressedSize;
      else if (method === 8) decodedSize = inflateRawSync(buffer.subarray(start, start + compressedSize), { maxOutputLength: DATA_LIMITS.maxLoadedBytes }).length;
      else throw new DataSourceError("The workbook uses an unsupported archive compression method.");
    } catch (error) {
      if (error instanceof DataSourceError) throw error;
      throw new DataSourceError("The spreadsheet archive could not be safely expanded. It is invalid or exceeds the 40 MiB expansion limit.", "limit_exceeded");
    }
    if (decodedSize !== size) throw new DataSourceError("The workbook archive reports inconsistent expanded sizes. Re-save it before uploading.");
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
}


function limit(message: string): never { throw new DataSourceError(message, "limit_exceeded"); }
