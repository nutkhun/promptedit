// Minimal typings for the parts of mp4box.js (0.5.x, BSD-3) the demuxer uses.
declare module "mp4box" {
  export interface MP4ArrayBuffer extends ArrayBuffer { fileStart: number }
  export interface Mp4Sample {
    number: number;
    offset: number;
    size: number;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    is_sync: boolean;
  }
  export interface Mp4Box { type: string; write(stream: DataStream): void; [k: string]: unknown }
  export interface Mp4SampleEntry extends Mp4Box {
    width: number;
    height: number;
    getCodec(): string;
    avcC?: Mp4Box;
    hvcC?: Mp4Box;
    vpcC?: Mp4Box;
    av1C?: Mp4Box;
  }
  export interface Mp4Trak {
    tkhd: { track_id: number; matrix: number[]; width: number; height: number };
    mdia: {
      mdhd: { timescale: number; duration: number };
      hdlr: { handler: string };
      minf: { stbl: { stsd: { entries: Mp4SampleEntry[] } } };
    };
    edts?: { elst: { entries: { segment_duration: number; media_time: number; media_rate_integer: number }[] } };
    samples: Mp4Sample[];
  }
  export interface ISOFile {
    appendBuffer(ab: MP4ArrayBuffer, last?: boolean): number;
    flush(): void;
    moov?: { mvhd: { timescale: number; duration: number }; traks: Mp4Trak[] };
    onError?: (e: string) => void;
  }
  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }
  export const Log: { setLogLevel(level: unknown): void; error: unknown };
  export function createFile(keepMdatData?: boolean): ISOFile;
}
