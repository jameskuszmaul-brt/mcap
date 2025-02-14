import { crc32, crc32Final, crc32Init, crc32Update } from "@foxglove/crc";
import Heap from "heap-js";

import { MCAP0_MAGIC } from "../constants";
import { parseMagic, parseRecord } from "../parse";
import { DecompressHandlers, IReadable, TypedMcapRecords } from "../types";
import { ChunkCursor } from "./ChunkCursor";

export default class Mcap0IndexedReader {
  readonly chunkIndexes: readonly TypedMcapRecords["ChunkIndex"][];
  readonly attachmentIndexes: readonly TypedMcapRecords["AttachmentIndex"][];
  readonly metadataIndexes: readonly TypedMcapRecords["MetadataIndex"][] = [];
  readonly channelsById: ReadonlyMap<number, TypedMcapRecords["Channel"]>;
  readonly schemasById: ReadonlyMap<number, TypedMcapRecords["Schema"]>;
  readonly statistics: TypedMcapRecords["Statistics"] | undefined;
  readonly summaryOffsetsByOpcode: ReadonlyMap<number, TypedMcapRecords["SummaryOffset"]>;
  readonly header: TypedMcapRecords["Header"];
  readonly footer: TypedMcapRecords["Footer"];

  private readable: IReadable;
  private decompressHandlers?: DecompressHandlers;

  private startTime: bigint | undefined;
  private endTime: bigint | undefined;

  private constructor({
    readable,
    chunkIndexes,
    attachmentIndexes,
    metadataIndexes,
    statistics,
    decompressHandlers,
    channelsById,
    schemasById,
    summaryOffsetsByOpcode,
    header,
    footer,
  }: {
    readable: IReadable;
    chunkIndexes: readonly TypedMcapRecords["ChunkIndex"][];
    attachmentIndexes: readonly TypedMcapRecords["AttachmentIndex"][];
    metadataIndexes: readonly TypedMcapRecords["MetadataIndex"][];
    statistics: TypedMcapRecords["Statistics"] | undefined;
    decompressHandlers?: DecompressHandlers;
    channelsById: ReadonlyMap<number, TypedMcapRecords["Channel"]>;
    schemasById: ReadonlyMap<number, TypedMcapRecords["Schema"]>;
    summaryOffsetsByOpcode: ReadonlyMap<number, TypedMcapRecords["SummaryOffset"]>;
    header: TypedMcapRecords["Header"];
    footer: TypedMcapRecords["Footer"];
  }) {
    this.readable = readable;
    this.chunkIndexes = chunkIndexes;
    this.attachmentIndexes = attachmentIndexes;
    this.metadataIndexes = metadataIndexes;
    this.statistics = statistics;
    this.decompressHandlers = decompressHandlers;
    this.channelsById = channelsById;
    this.schemasById = schemasById;
    this.summaryOffsetsByOpcode = summaryOffsetsByOpcode;
    this.header = header;
    this.footer = footer;

    for (const chunk of chunkIndexes) {
      if (this.startTime == undefined || chunk.messageStartTime < this.startTime) {
        this.startTime = chunk.messageStartTime;
      }
      if (this.endTime == undefined || chunk.messageEndTime > this.endTime) {
        this.endTime = chunk.messageEndTime;
      }
    }
  }

  private errorWithLibrary(message: string): Error {
    return new Error(`${message} [library=${this.header.library}]`);
  }

  static async Initialize({
    readable,
    decompressHandlers,
  }: {
    readable: IReadable;

    /**
     * When a compressed chunk is encountered, the entry in `decompressHandlers` corresponding to the
     * compression will be called to decompress the chunk data.
     */
    decompressHandlers?: DecompressHandlers;
  }): Promise<Mcap0IndexedReader> {
    const size = await readable.size();

    let header: TypedMcapRecords["Header"];
    {
      const headerPrefix = await readable.read(
        0n,
        BigInt(MCAP0_MAGIC.length + /* Opcode.HEADER */ 1 + /* record content length */ 8),
      );
      const headerPrefixView = new DataView(
        headerPrefix.buffer,
        headerPrefix.byteOffset,
        headerPrefix.byteLength,
      );
      void parseMagic(headerPrefixView, 0);
      const headerLength = headerPrefixView.getBigUint64(
        MCAP0_MAGIC.length + /* Opcode.HEADER */ 1,
        true,
      );

      const headerRecord = await readable.read(
        BigInt(MCAP0_MAGIC.length),
        /* Opcode.HEADER */ 1n + /* record content length */ 8n + headerLength,
      );
      const headerResult = parseRecord({
        view: new DataView(headerRecord.buffer, headerRecord.byteOffset, headerRecord.byteLength),
        startOffset: 0,
        validateCrcs: true,
      });
      if (headerResult.record?.type !== "Header") {
        throw new Error(
          `Unable to read header at beginning of file; found ${
            headerResult.record?.type ?? "nothing"
          }`,
        );
      }
      if (headerResult.usedBytes !== headerRecord.byteLength) {
        throw new Error(
          `${
            headerRecord.byteLength - headerResult.usedBytes
          } bytes remaining after parsing header`,
        );
      }
      header = headerResult.record;
    }

    function errorWithLibrary(message: string): Error {
      return new Error(`${message} [library=${header.library}]`);
    }

    let footerOffset: bigint;
    let footerAndMagicView: DataView;
    {
      const headerLengthLowerBound = BigInt(
        MCAP0_MAGIC.length +
          /* Opcode.HEADER */ 1 +
          /* record content length */ 8 +
          /* profile length */ 4 +
          /* library length */ 4,
      );
      const footerAndMagicReadLength = BigInt(
        /* Opcode.FOOTER */ 1 +
          /* record content length */ 8 +
          /* summaryStart */ 8 +
          /* summaryOffsetStart */ 8 +
          /* crc */ 4 +
          MCAP0_MAGIC.length,
      );
      if (size < headerLengthLowerBound + footerAndMagicReadLength) {
        throw errorWithLibrary(`File size (${size}) is too small to be valid MCAP`);
      }
      footerOffset = size - footerAndMagicReadLength;
      const footerBuffer = await readable.read(footerOffset, footerAndMagicReadLength);

      footerAndMagicView = new DataView(
        footerBuffer.buffer,
        footerBuffer.byteOffset,
        footerBuffer.byteLength,
      );
    }

    try {
      void parseMagic(footerAndMagicView, footerAndMagicView.byteLength - MCAP0_MAGIC.length);
    } catch (error) {
      throw errorWithLibrary((error as Error).message);
    }

    let footer: TypedMcapRecords["Footer"];
    {
      const footerResult = parseRecord({
        view: footerAndMagicView,
        startOffset: 0,
        validateCrcs: true,
      });
      if (footerResult.record?.type !== "Footer") {
        throw errorWithLibrary(
          `Unable to read footer from end of file (offset ${footerOffset}); found ${
            footerResult.record?.type ?? "nothing"
          }`,
        );
      }
      if (footerResult.usedBytes !== footerAndMagicView.byteLength - MCAP0_MAGIC.length) {
        throw errorWithLibrary(
          `${
            footerAndMagicView.byteLength - MCAP0_MAGIC.length - footerResult.usedBytes
          } bytes remaining after parsing footer`,
        );
      }
      footer = footerResult.record;
    }
    if (footer.summaryStart === 0n) {
      throw errorWithLibrary("File is not indexed");
    }

    // Copy the footer prefix before reading the summary because calling readable.read() may reuse the buffer.
    const footerPrefix = new Uint8Array(
      /* Opcode.FOOTER */ 1 +
        /* record content length */ 8 +
        /* summary start */ 8 +
        /* summary offset start */ 8,
    );
    footerPrefix.set(
      new Uint8Array(
        footerAndMagicView.buffer,
        footerAndMagicView.byteOffset,
        footerPrefix.byteLength,
      ),
    );

    // Future optimization: avoid holding whole summary blob in memory at once
    const allSummaryData = await readable.read(
      footer.summaryStart,
      footerOffset - footer.summaryStart,
    );
    if (footer.summaryCrc !== 0) {
      let summaryCrc = crc32Init();
      summaryCrc = crc32Update(summaryCrc, allSummaryData);
      summaryCrc = crc32Update(summaryCrc, footerPrefix);
      summaryCrc = crc32Final(summaryCrc);
      if (summaryCrc !== footer.summaryCrc) {
        throw errorWithLibrary(
          `Incorrect summary CRC ${summaryCrc} (expected ${footer.summaryCrc})`,
        );
      }
    }

    const indexView = new DataView(
      allSummaryData.buffer,
      allSummaryData.byteOffset,
      allSummaryData.byteLength,
    );

    const channelsById = new Map<number, TypedMcapRecords["Channel"]>();
    const schemasById = new Map<number, TypedMcapRecords["Schema"]>();
    const chunkIndexes: TypedMcapRecords["ChunkIndex"][] = [];
    const attachmentIndexes: TypedMcapRecords["AttachmentIndex"][] = [];
    const metadataIndexes: TypedMcapRecords["MetadataIndex"][] = [];
    const summaryOffsetsByOpcode = new Map<number, TypedMcapRecords["SummaryOffset"]>();
    let statistics: TypedMcapRecords["Statistics"] | undefined;

    let offset = 0;
    for (
      let result;
      (result = parseRecord({ view: indexView, startOffset: offset, validateCrcs: true })),
        result.record;
      offset += result.usedBytes
    ) {
      switch (result.record.type) {
        case "Schema":
          schemasById.set(result.record.id, result.record);
          break;
        case "Channel":
          channelsById.set(result.record.id, result.record);
          break;
        case "ChunkIndex":
          chunkIndexes.push(result.record);
          break;
        case "AttachmentIndex":
          attachmentIndexes.push(result.record);
          break;
        case "MetadataIndex":
          metadataIndexes.push(result.record);
          break;
        case "Statistics":
          if (statistics) {
            throw errorWithLibrary("Duplicate Statistics record");
          }
          statistics = result.record;
          break;
        case "SummaryOffset":
          summaryOffsetsByOpcode.set(result.record.groupOpcode, result.record);
          break;
        case "Header":
        case "Footer":
        case "Message":
        case "Chunk":
        case "MessageIndex":
        case "Attachment":
        case "Metadata":
        case "DataEnd":
          throw errorWithLibrary(`${result.record.type} record not allowed in index section`);
        case "Unknown":
          break;
      }
    }
    if (offset !== indexView.byteLength) {
      throw errorWithLibrary(`${indexView.byteLength - offset} bytes remaining in index section`);
    }

    return new Mcap0IndexedReader({
      readable,
      chunkIndexes,
      attachmentIndexes,
      metadataIndexes,
      statistics,
      decompressHandlers,
      channelsById,
      schemasById,
      summaryOffsetsByOpcode,
      header,
      footer,
    });
  }

  async *readMessages({
    topics,
    startTime = this.startTime,
    endTime = this.endTime,
  }: {
    topics?: readonly string[];
    startTime?: bigint;
    endTime?: bigint;
  } = {}): AsyncGenerator<TypedMcapRecords["Message"], void, void> {
    if (startTime == undefined || endTime == undefined) {
      return;
    }

    let relevantChannels: Set<number> | undefined;
    if (topics) {
      relevantChannels = new Set();
      for (const channel of this.channelsById.values()) {
        if (topics.includes(channel.topic)) {
          relevantChannels.add(channel.id);
        }
      }
    }

    const chunkCursors = new Heap<ChunkCursor>((a, b) => a.compare(b));
    for (const chunkIndex of this.chunkIndexes) {
      if (chunkIndex.messageStartTime <= endTime && chunkIndex.messageEndTime >= startTime) {
        chunkCursors.push(new ChunkCursor({ chunkIndex, relevantChannels, startTime, endTime }));
      }
    }

    // Holds the decompressed chunk data for "active" chunks. Items are added below when a chunk
    // cursor becomes active (i.e. when we first need to access messages from the chunk) and removed
    // when the cursor is removed from the heap.
    const chunkViewCache = new Map<bigint, DataView>();
    const loadChunkData = async (chunkIndex: TypedMcapRecords["ChunkIndex"]): Promise<DataView> => {
      const chunkData = await this.readable.read(
        chunkIndex.chunkStartOffset,
        chunkIndex.chunkLength,
      );
      const chunkResult = parseRecord({
        view: new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength),
        startOffset: 0,
        validateCrcs: true,
      });
      if (chunkResult.record?.type !== "Chunk") {
        throw this.errorWithLibrary(
          `Chunk start offset ${
            chunkIndex.chunkStartOffset
          } does not point to chunk record (found ${String(chunkResult.record?.type)})`,
        );
      }

      const chunk = chunkResult.record;
      let buffer = chunk.records;
      if (chunk.compression !== "" && buffer.byteLength > 0) {
        const decompress = this.decompressHandlers?.[chunk.compression];
        if (!decompress) {
          throw this.errorWithLibrary(`Unsupported compression ${chunk.compression}`);
        }
        buffer = decompress(buffer, chunk.uncompressedSize);
      }
      if (chunk.uncompressedCrc !== 0) {
        const chunkCrc = crc32(buffer);
        if (chunkCrc !== chunk.uncompressedCrc) {
          throw this.errorWithLibrary(
            `Incorrect chunk CRC ${chunkCrc} (expected ${chunk.uncompressedCrc})`,
          );
        }
      }

      return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    };

    for (let cursor; (cursor = chunkCursors.peek()); ) {
      if (!cursor.hasMessageIndexes()) {
        // If we encounter a chunk whose message indexes have not been loaded yet, load them and re-organize the heap.
        await cursor.loadMessageIndexes(this.readable);
        if (cursor.hasMoreMessages()) {
          chunkCursors.replace(cursor);
        } else {
          chunkCursors.pop();
        }
        continue;
      }

      let chunkView = chunkViewCache.get(cursor.chunkIndex.chunkStartOffset);
      if (!chunkView) {
        chunkView = await loadChunkData(cursor.chunkIndex);
        chunkViewCache.set(cursor.chunkIndex.chunkStartOffset, chunkView);
      }

      const [logTime, offset] = cursor.popMessage();
      if (offset >= BigInt(chunkView.byteLength)) {
        throw this.errorWithLibrary(
          `Message offset beyond chunk bounds (log time ${logTime}, offset ${offset}, chunk data length ${chunkView.byteLength}) in chunk at offset ${cursor.chunkIndex.chunkStartOffset}`,
        );
      }
      const result = parseRecord({
        view: chunkView,
        startOffset: Number(offset),
        validateCrcs: true,
      });
      if (!result.record) {
        throw this.errorWithLibrary(
          `Unable to parse record at offset ${offset} in chunk at offset ${cursor.chunkIndex.chunkStartOffset}`,
        );
      }
      if (result.record.type !== "Message") {
        throw this.errorWithLibrary(
          `Unexpected record type ${result.record.type} in message index (time ${logTime}, offset ${offset} in chunk at offset ${cursor.chunkIndex.chunkStartOffset})`,
        );
      }
      if (result.record.logTime !== logTime) {
        throw this.errorWithLibrary(
          `Message log time ${result.record.logTime} did not match message index entry (${logTime} at offset ${offset} in chunk at offset ${cursor.chunkIndex.chunkStartOffset})`,
        );
      }
      yield result.record;

      if (cursor.hasMoreMessages()) {
        chunkCursors.replace(cursor);
      } else {
        chunkCursors.pop();
        chunkViewCache.delete(cursor.chunkIndex.chunkStartOffset);
      }
    }
  }
}
