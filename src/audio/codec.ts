/**
 * Minimal WAV/AIFF reader and WAV writer.
 *
 * The SDK renders to whatever Live's "Record File Type" preference says (WAV or
 * AIFF), so both have to be readable. Rolling our own avoids pulling a decoder
 * dependency into the bundle for what amounts to a few chunk headers.
 */

export interface DecodedAudio {
  sampleRate: number;
  /** One Float32Array per channel, each `length` samples long, nominally in [-1, 1]. */
  channels: Float32Array[];
  length: number;
}

const ascii = (view: DataView, offset: number): string =>
  String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );

/** Interleaved integer/float PCM → per-channel Float32Array. */
function deinterleave(
  view: DataView,
  dataOffset: number,
  dataLength: number,
  channelCount: number,
  bitDepth: number,
  isFloat: boolean,
  littleEndian: boolean,
): { channels: Float32Array[]; length: number } {
  const bytesPerSample = bitDepth >> 3;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channelCount));
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame++) {
    for (let c = 0; c < channelCount; c++) {
      const at = dataOffset + (frame * channelCount + c) * bytesPerSample;
      let value: number;

      if (isFloat) {
        value =
          bitDepth === 64
            ? view.getFloat64(at, littleEndian)
            : view.getFloat32(at, littleEndian);
      } else if (bitDepth === 8) {
        // 8-bit WAV is unsigned; 8-bit AIFF is signed. WAV is the common case here.
        value = (view.getUint8(at) - 128) / 128;
      } else if (bitDepth === 16) {
        value = view.getInt16(at, littleEndian) / 32768;
      } else if (bitDepth === 24) {
        const b0 = view.getUint8(at);
        const b1 = view.getUint8(at + 1);
        const b2 = view.getUint8(at + 2);
        let raw = littleEndian
          ? (b2 << 16) | (b1 << 8) | b0
          : (b0 << 16) | (b1 << 8) | b2;
        if (raw & 0x800000) raw |= ~0xffffff; // sign-extend
        value = raw / 8388608;
      } else if (bitDepth === 32) {
        value = view.getInt32(at, littleEndian) / 2147483648;
      } else {
        throw new Error(`Unsupported bit depth: ${bitDepth}`);
      }

      channels[c]![frame] = value;
    }
  }

  return { channels, length: frameCount };
}

function decodeWav(view: DataView): DecodedAudio {
  let format = 1;
  let channelCount = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= view.byteLength) {
    const id = ascii(view, cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;

    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format tag lives in the GUID's first word.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, view.byteLength - body);
    }

    cursor = body + size + (size % 2); // chunks are word-aligned
  }

  if (dataOffset < 0 || !channelCount || !sampleRate) {
    throw new Error("Malformed WAV: missing fmt or data chunk.");
  }

  const { channels, length } = deinterleave(
    view,
    dataOffset,
    dataLength,
    channelCount,
    bitDepth,
    format === 3,
    true,
  );
  return { sampleRate, channels, length };
}

/** AIFF stores the sample rate as an 80-bit IEEE 754 extended float. */
function readExtendedFloat(view: DataView, offset: number): number {
  const exponent = view.getUint16(offset);
  const hi = view.getUint32(offset + 2);
  const lo = view.getUint32(offset + 6);
  const sign = exponent & 0x8000 ? -1 : 1;
  const e = (exponent & 0x7fff) - 16383;
  return sign * (hi * 2 ** (e - 31) + lo * 2 ** (e - 63));
}

function decodeAiff(view: DataView): DecodedAudio {
  let channelCount = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let compression = "NONE";
  let dataOffset = -1;
  let dataLength = 0;

  let cursor = 12;
  while (cursor + 8 <= view.byteLength) {
    const id = ascii(view, cursor);
    const size = view.getUint32(cursor + 4);
    const body = cursor + 8;

    if (id === "COMM") {
      channelCount = view.getUint16(body);
      bitDepth = view.getUint16(body + 6);
      sampleRate = readExtendedFloat(view, body + 8);
      if (size >= 22) compression = ascii(view, body + 18);
    } else if (id === "SSND") {
      const offsetField = view.getUint32(body);
      dataOffset = body + 8 + offsetField;
      dataLength = Math.min(size - 8 - offsetField, view.byteLength - dataOffset);
    }

    cursor = body + size + (size % 2);
  }

  if (dataOffset < 0 || !channelCount || !sampleRate) {
    throw new Error("Malformed AIFF: missing COMM or SSND chunk.");
  }

  // "sowt" is little-endian PCM; "fl32"/"FL32" are floats. Everything else we
  // treat as big-endian PCM, which is plain AIFF.
  const isFloat = compression === "fl32" || compression === "FL32";
  const littleEndian = compression === "sowt";

  const { channels, length } = deinterleave(
    view,
    dataOffset,
    dataLength,
    channelCount,
    bitDepth,
    isFloat,
    littleEndian,
  );
  return { sampleRate: Math.round(sampleRate), channels, length };
}

export function decodeAudioFile(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) throw new Error("Audio file is too short to be valid.");

  const container = ascii(view, 0);
  if (container === "RIFF") return decodeWav(view);
  if (container === "FORM") return decodeAiff(view);
  throw new Error(`Unrecognised audio container: "${container}".`);
}

/** Writes 32-bit float WAV — no quantisation on the way back into Live. */
export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  const dataLength = frameCount * channelCount * 4;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 4, true);
  view.setUint16(32, channelCount * 4, true);
  view.setUint16(34, 32, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);

  let at = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let c = 0; c < channelCount; c++) {
      view.setFloat32(at, channels[c]![frame]!, true);
      at += 4;
    }
  }

  return new Uint8Array(buffer);
}

/** Channel mixdown used for analysis — detection runs on a single signal. */
export function toMono(audio: DecodedAudio): Float32Array {
  if (audio.channels.length === 1) return audio.channels[0]!;
  const mono = new Float32Array(audio.length);
  for (const channel of audio.channels) {
    for (let i = 0; i < audio.length; i++) mono[i]! += channel[i]!;
  }
  const scale = 1 / audio.channels.length;
  for (let i = 0; i < audio.length; i++) mono[i]! *= scale;
  return mono;
}
