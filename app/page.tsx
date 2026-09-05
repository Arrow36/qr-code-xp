'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as QRCode from 'qrcode';
import jsQR, { type QRCode as DecodedQr } from 'jsqr';
import {
  Camera,
  Check,
  Copy,
  Download,
  FlaskConical,
  ImagePlus,
  Pause,
  LogOut,
  Power,
  QrCode,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Ecc = 'L' | 'M' | 'Q' | 'H';
type EncodeMode = 'auto' | 'numeric' | 'alphanumeric' | 'byte';
type MatrixData = { size: number; data: Uint8Array; reserved?: Uint8Array };
type FormatInfo = {
  observedA: number;
  observedB: number;
  corrected: number;
  distance: number;
  ecc: Ecc;
  mask: number;
};
type ScanAnalysis = {
  decoded: DecodedQr;
  width: number;
  height: number;
  matrix?: MatrixData;
  format?: FormatInfo;
};
type ScanHistoryEntry = ScanAnalysis & { id: number };
type WebMcpContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

const FORMAT_TABLE: Array<{ bits: number; ecc: Ecc; mask: number }> = [
  ...[0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0].map(
    (bits, mask) => ({ bits, ecc: 'M' as Ecc, mask }),
  ),
  ...[0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976].map(
    (bits, mask) => ({ bits, ecc: 'L' as Ecc, mask }),
  ),
  ...[0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b].map(
    (bits, mask) => ({ bits, ecc: 'H' as Ecc, mask }),
  ),
  ...[0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed].map(
    (bits, mask) => ({ bits, ecc: 'Q' as Ecc, mask }),
  ),
];
const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function bits(value: number, width: number) {
  return value.toString(2).padStart(width, '0');
}
function hamming(a: number, b: number) {
  let value = a ^ b,
    count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}
function pushBit(current: number, bit: number) {
  return (current << 1) | (bit ? 1 : 0);
}

function readFormat(matrix: MatrixData): FormatInfo | undefined {
  const { size, data } = matrix;
  const get = (row: number, col: number) => data[row * size + col] > 0;
  let a = 0;
  for (let x = 0; x <= 8; x++) if (x !== 6) a = pushBit(a, get(8, x) ? 1 : 0);
  for (let y = 7; y >= 0; y--) if (y !== 6) a = pushBit(a, get(y, 8) ? 1 : 0);
  let b = 0;
  for (let y = size - 1; y >= size - 7; y--) b = pushBit(b, get(y, 8) ? 1 : 0);
  for (let x = size - 8; x < size; x++) b = pushBit(b, get(8, x) ? 1 : 0);
  let best: (typeof FORMAT_TABLE)[number] | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const item of FORMAT_TABLE) {
    const next = Math.min(hamming(a, item.bits), hamming(b, item.bits));
    if (next < distance) {
      best = item;
      distance = next;
    }
  }
  if (!best || distance > 3) return undefined;
  return {
    observedA: a,
    observedB: b,
    corrected: best.bits,
    distance,
    ecc: best.ecc,
    mask: best.mask,
  };
}

function otsu(image: ImageData) {
  const histogram = new Uint32Array(256),
    pixels = image.data;
  for (let i = 0; i < pixels.length; i += 4)
    histogram[
      Math.round(
        pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114,
      )
    ]++;
  const total = pixels.length / 4;
  let weighted = 0;
  for (let i = 0; i < 256; i++) weighted += i * histogram[i];
  let background = 0,
    backgroundWeight = 0,
    bestVariance = -1,
    threshold = 127;
  for (let i = 0; i < 256; i++) {
    backgroundWeight += histogram[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    background += i * histogram[i];
    const variance =
      backgroundWeight *
      foregroundWeight *
      (background / backgroundWeight -
        (weighted - background) / foregroundWeight) **
        2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = i;
    }
  }
  // Pure black-and-white images can make Otsu settle on 0 or 255. Keep the
  // cutoff inside the usable luminance range so boundary pixels are retained.
  return Math.max(1, Math.min(254, threshold));
}

function sampleMatrix(image: ImageData, decoded: DecodedQr): MatrixData {
  const size = 17 + decoded.version * 4;
  const {
    topLeftCorner: tl,
    topRightCorner: tr,
    bottomLeftCorner: bl,
    bottomRightCorner: br,
  } = decoded.location;
  const threshold = otsu(image),
    out = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    const v = (row + 0.5) / size;
    for (let col = 0; col < size; col++) {
      const u = (col + 0.5) / size;
      const x =
        (1 - u) * (1 - v) * tl.x +
        u * (1 - v) * tr.x +
        (1 - u) * v * bl.x +
        u * v * br.x;
      const y =
        (1 - u) * (1 - v) * tl.y +
        u * (1 - v) * tr.y +
        (1 - u) * v * bl.y +
        u * v * br.y;
      const ix = Math.max(0, Math.min(image.width - 1, Math.round(x))),
        iy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
      const index = (iy * image.width + ix) * 4;
      const gray =
        image.data[index] * 0.299 +
        image.data[index + 1] * 0.587 +
        image.data[index + 2] * 0.114;
      out[row * size + col] = gray <= threshold ? 1 : 0;
    }
  }
  if (!out[3 * size + 3]) for (let i = 0; i < out.length; i++) out[i] ^= 1;
  return { size, data: out };
}

function encodeSegments(qr: QRCode.QRCode) {
  const group = qr.version < 10 ? 0 : qr.version < 27 ? 1 : 2;
  return qr.segments.map((segment, index) => {
    const mode = segment.mode.id,
      modeBits = bits(segment.mode.bit, 4),
      count = segment.getLength();
    const countBits = bits(count, segment.mode.ccBits[group]);
    let dataBits = '';
    if (mode === 'Numeric') {
      const value = String(segment.data);
      for (let i = 0; i < value.length; i += 3) {
        const part = value.slice(i, i + 3);
        dataBits += bits(
          Number(part),
          part.length === 3 ? 10 : part.length === 2 ? 7 : 4,
        );
      }
    } else if (mode === 'Alphanumeric') {
      const value = String(segment.data);
      for (let i = 0; i < value.length; i += 2)
        dataBits +=
          i + 1 < value.length
            ? bits(
                ALPHANUM.indexOf(value[i]) * 45 +
                  ALPHANUM.indexOf(value[i + 1]),
                11,
              )
            : bits(ALPHANUM.indexOf(value[i]), 6);
    } else if (mode === 'Byte')
      dataBits = Array.from(segment.data as Uint8Array, (byte) =>
        bits(byte, 8),
      ).join('');
    else dataBits = `[${segment.getBitsLength()} Kanji data bits]`;
    return {
      index,
      mode,
      count,
      modeBits,
      countBits,
      dataBits,
      bitLength: 4 + countBits.length + segment.getBitsLength(),
    };
  });
}

function penalty(matrix: MatrixData) {
  const { size, data } = matrix,
    get = (r: number, c: number) => (data[r * size + c] ? 1 : 0);
  let n1 = 0;
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (get(r, c) === get(r, c - 1)) run++;
      else {
        if (run >= 5) n1 += run - 2;
        run = 1;
      }
    }
    if (run >= 5) n1 += run - 2;
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (get(r, c) === get(r - 1, c)) run++;
      else {
        if (run >= 5) n1 += run - 2;
        run = 1;
      }
    }
    if (run >= 5) n1 += run - 2;
  }
  let n2 = 0;
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = get(r, c);
      if (v === get(r + 1, c) && v === get(r, c + 1) && v === get(r + 1, c + 1))
        n2 += 3;
    }
  const scoreLine = (line: string) => {
    let score = 0;
    for (let i = 0; i <= line.length - 7; i++)
      if (line.slice(i, i + 7) === '1011101') {
        const before = line.slice(Math.max(0, i - 4), i).padStart(4, '0'),
          after = line.slice(i + 7, i + 11).padEnd(4, '0');
        if (before === '0000' || after === '0000') score += 40;
      }
    return score;
  };
  let n3 = 0;
  for (let r = 0; r < size; r++)
    n3 += scoreLine(Array.from({ length: size }, (_, c) => get(r, c)).join(''));
  for (let c = 0; c < size; c++)
    n3 += scoreLine(Array.from({ length: size }, (_, r) => get(r, c)).join(''));
  const dark = data.reduce((sum, value) => sum + (value ? 1 : 0), 0),
    n4 = Math.floor(Math.abs((dark * 100) / data.length - 50) / 5) * 10;
  return { n1, n2, n3, n4, total: n1 + n2 + n3 + n4 };
}

function fileDownload(
  name: string,
  data: Blob | string,
  type = 'application/json',
) {
  const url = URL.createObjectURL(
      typeof data === 'string' ? new Blob([data], { type }) : data,
    ),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function MatrixView({
  matrix,
  selected,
  onSelect,
}: {
  matrix: MatrixData;
  selected?: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <div
      className="matrix"
      style={{
        gridTemplateColumns: `repeat(${matrix.size}, 1fr)`,
        gridTemplateRows: `repeat(${matrix.size}, 1fr)`,
      }}
      role="grid"
      aria-label={`${matrix.size} × ${matrix.size} 二维码矩阵`}
    >
      {Array.from(matrix.data).map((dark, index) => (
        <button
          key={index}
          type="button"
          aria-label={`行 ${Math.floor(index / matrix.size)}，列 ${index % matrix.size}，${dark ? '深色' : '浅色'}`}
          onClick={() => onSelect?.(index)}
          className={`${dark ? 'dark-module' : 'light-module'} ${matrix.reserved?.[index] ? 'reserved-module' : ''} ${selected === index ? 'selected-module' : ''}`}
        />
      ))}
    </div>
  );
}
function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong className={accent ? 'accent-text' : ''}>{value}</strong>
    </div>
  );
}

function DesktopClock() {
  const [clock, setClock] = useState('');
  useEffect(() => {
    const updateClock = () =>
      setClock(
        new Intl.DateTimeFormat('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(new Date()),
      );
    const first = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, []);

  return <span>{clock || '--:--'}</span>;
}

function UploadButton({
  large = false,
  onFile,
}: {
  large?: boolean;
  onFile: (file: File) => Promise<void>;
}) {
  return (
    <label
      className={`zen-button upload-button ${large ? 'large-button' : ''}`}
    >
      <input
        type="file"
        accept="image/*"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void onFile(file);
        }}
      />
      <ImagePlus />
      <span>选择二维码图片</span>
    </label>
  );
}

export default function Home() {
  const [text, setText] = useState(''),
    [ecc, setEcc] = useState<Ecc>('M');
  const [version, setVersion] = useState('auto'),
    [mask, setMask] = useState('auto'),
    [mode, setMode] = useState<EncodeMode>('auto');
  const [experience, setExperience] = useState<'simple' | 'advanced'>('simple');
  const [activeTab, setActiveTab] = useState('generate');
  const [outputSize, setOutputSize] = useState('1024');
  const [desktopPower, setDesktopPower] = useState<
    'on' | 'logout' | 'shutdown'
  >('on');
  const [selectedModule, setSelectedModule] = useState<number>(),
    [scan, setScan] = useState<ScanAnalysis>(),
    [scanHistory, setScanHistory] = useState<ScanHistoryEntry[]>([]),
    [scanError, setScanError] = useState('');
  const [dragging, setDragging] = useState(false),
    [cameraOn, setCameraOn] = useState(false);
  const [windowMinimized, setWindowMinimized] = useState(false),
    [windowMaximized, setWindowMaximized] = useState(false),
    [windowClosed, setWindowClosed] = useState(false),
    [startOpen, setStartOpen] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null),
    videoRef = useRef<HTMLVideoElement>(null),
    resultRef = useRef<HTMLElement>(null),
    streamRef = useRef<MediaStream | undefined>(undefined);
  const scanIdRef = useRef(0);
  const cameraTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebMcpContext })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'configure_qr_generation',
          title: '配置二维码生成',
          description:
            '设置 QR Lab 中可见的二维码内容、纠错等级、版本、Mask 和编码模式。',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              ecc: { enum: ['L', 'M', 'Q', 'H'] },
              version: {
                anyOf: [
                  { const: 'auto' },
                  { type: 'integer', minimum: 1, maximum: 40 },
                ],
              },
              mask: {
                anyOf: [
                  { const: 'auto' },
                  { type: 'integer', minimum: 0, maximum: 7 },
                ],
              },
              mode: { enum: ['auto', 'numeric', 'alphanumeric', 'byte'] },
            },
            required: ['text'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input) {
            if (!input || typeof input !== 'object')
              throw new Error('输入必须是对象');
            const value = input as {
              text?: unknown;
              ecc?: unknown;
              version?: unknown;
              mask?: unknown;
              mode?: unknown;
            };
            if (typeof value.text !== 'string')
              throw new Error('text 必须是字符串');
            if (
              value.ecc !== undefined &&
              !['L', 'M', 'Q', 'H'].includes(String(value.ecc))
            )
              throw new Error('ecc 无效');
            if (
              value.mode !== undefined &&
              !['auto', 'numeric', 'alphanumeric', 'byte'].includes(
                String(value.mode),
              )
            )
              throw new Error('mode 无效');
            if (
              value.version !== undefined &&
              value.version !== 'auto' &&
              (!Number.isInteger(value.version) ||
                Number(value.version) < 1 ||
                Number(value.version) > 40)
            )
              throw new Error('version 无效');
            if (
              value.mask !== undefined &&
              value.mask !== 'auto' &&
              (!Number.isInteger(value.mask) ||
                Number(value.mask) < 0 ||
                Number(value.mask) > 7)
            )
              throw new Error('mask 无效');
            setText(value.text);
            if (value.ecc !== undefined) setEcc(value.ecc as Ecc);
            if (value.mode !== undefined) setMode(value.mode as EncodeMode);
            if (value.version !== undefined) setVersion(String(value.version));
            if (value.mask !== undefined) setMask(String(value.mask));
            return {
              applied: true,
              textBytes: new TextEncoder().encode(value.text).length,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  const generated = useMemo(() => {
    try {
      if (!text) return { qr: undefined, error: '' };
      const options: QRCode.QRCodeOptions = {
        errorCorrectionLevel: ecc,
        ...(version === 'auto' ? {} : { version: Number(version) }),
        ...(mask === 'auto'
          ? {}
          : { maskPattern: Number(mask) as QRCode.QRCodeMaskPattern }),
      };
      let input: string | QRCode.QRCodeSegment[] = text;
      if (mode !== 'auto') {
        if (mode === 'numeric' && !/^\d+$/.test(text))
          throw new Error('Numeric 模式只允许数字 0–9');
        if (
          mode === 'alphanumeric' &&
          [...text].some((char) => !ALPHANUM.includes(char))
        )
          throw new Error('Alphanumeric 模式包含不支持的字符');
        input =
          mode === 'byte'
            ? [{ mode: 'byte', data: new TextEncoder().encode(text) }]
            : [{ mode, data: text } as QRCode.QRCodeSegment];
      }
      return { qr: QRCode.create(input, options), error: '' };
    } catch (error) {
      return {
        qr: undefined,
        error: error instanceof Error ? error.message : '无法生成二维码',
      };
    }
  }, [text, ecc, version, mask, mode]);
  const matrix = useMemo<MatrixData | undefined>(
    () =>
      generated.qr
        ? {
            size: generated.qr.modules.size,
            data: generated.qr.modules.data,
            reserved: generated.qr.modules.reservedBit,
          }
        : undefined,
    [generated.qr],
  );
  const segments = useMemo(
    () => (generated.qr ? encodeSegments(generated.qr) : []),
    [generated.qr],
  );
  const payloadBits = segments
    .map((segment) => segment.modeBits + segment.countBits + segment.dataBits)
    .join('');
  const maskScores = useMemo(() => {
    if (!generated.qr) return [];
    try {
      const input: string | QRCode.QRCodeSegment[] =
        mode === 'auto'
          ? text || ' '
          : mode === 'byte'
            ? [{ mode: 'byte', data: new TextEncoder().encode(text || ' ') }]
            : [{ mode, data: text || ' ' } as QRCode.QRCodeSegment];
      return Array.from({ length: 8 }, (_, candidate) => {
        const qr = QRCode.create(input, {
          version: generated.qr!.version,
          errorCorrectionLevel: ecc,
          maskPattern: candidate as QRCode.QRCodeMaskPattern,
        });
        return {
          mask: candidate,
          ...penalty({ size: qr.modules.size, data: qr.modules.data }),
        };
      });
    } catch {
      return [];
    }
  }, [generated.qr, text, ecc, mode]);

  const setQrCanvas = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      canvasRef.current = canvas;
      if (!canvas || !matrix) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      const margin = 4,
        moduleSize = 16,
        actual = (matrix.size + margin * 2) * moduleSize;
      canvas.width = actual;
      canvas.height = actual;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, actual, actual);
      ctx.fillStyle = '#000000';
      matrix.data.forEach((value, index) => {
        if (value) {
          const row = Math.floor(index / matrix.size),
            col = index % matrix.size;
          ctx.fillRect(
            (col + margin) * moduleSize,
            (row + margin) * moduleSize,
            moduleSize,
            moduleSize,
          );
        }
      });
    },
    [matrix],
  );

  const analyzeImageData = useCallback((image: ImageData) => {
    let decoded = jsQR(image.data, image.width, image.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!decoded) {
      const threshold = otsu(image);
      const enhanced = new Uint8ClampedArray(image.data.length);
      for (let index = 0; index < image.data.length; index += 4) {
        const gray = Math.round(
          image.data[index] * 0.299 +
            image.data[index + 1] * 0.587 +
            image.data[index + 2] * 0.114,
        );
        const value = gray <= threshold ? 0 : 255;
        enhanced[index] = value;
        enhanced[index + 1] = value;
        enhanced[index + 2] = value;
        enhanced[index + 3] = 255;
      }
      decoded = jsQR(enhanced, image.width, image.height, {
        inversionAttempts: 'attemptBoth',
      });
    }
    if (!decoded) {
      setScanError('没有识别到二维码。请尝试更清晰、对比度更高的图片。');
      return false;
    }
    const sampled = sampleMatrix(image, decoded);
    const analysis: ScanAnalysis = {
      decoded,
      width: image.width,
      height: image.height,
      matrix: sampled,
      format: readFormat(sampled),
    };
    setScan(analysis);
    setScanHistory((history) => [
      { ...analysis, id: ++scanIdRef.current },
      ...history,
    ]);
    setScanError('');
    return true;
  }, []);
  const analyzeFile = useCallback(
    async (file: File) => {
      if (file.type && !file.type.startsWith('image/')) {
        setScanError('请选择图片文件。');
        return;
      }
      let objectUrl = '';
      let bitmap: ImageBitmap | undefined;
      try {
        let source: CanvasImageSource;
        let sourceWidth: number;
        let sourceHeight: number;

        if (typeof createImageBitmap === 'function') {
          try {
            bitmap = await createImageBitmap(file);
            source = bitmap;
            sourceWidth = bitmap.width;
            sourceHeight = bitmap.height;
          } catch {
            objectUrl = URL.createObjectURL(file);
            const image = document.createElement('img');
            image.src = objectUrl;
            await image.decode();
            source = image;
            sourceWidth = image.naturalWidth;
            sourceHeight = image.naturalHeight;
          }
        } else {
          objectUrl = URL.createObjectURL(file);
          const image = document.createElement('img');
          image.src = objectUrl;
          await image.decode();
          source = image;
          sourceWidth = image.naturalWidth;
          sourceHeight = image.naturalHeight;
        }

        if (!sourceWidth || !sourceHeight) throw new Error('empty image');

        // Very large phone screenshots are expensive for jsQR, while very
        // small symbols benefit from an integer upscale. Try a few practical
        // target sizes and stop as soon as one decodes successfully.
        const longestSide = Math.max(sourceWidth, sourceHeight);
        const targetSides = Array.from(
          new Set([
            Math.min(longestSide, 1000),
            Math.min(longestSide, 1600),
            Math.min(longestSide, 2400),
            longestSide < 700
              ? Math.min(1400, longestSide * 2)
              : Math.min(longestSide, 2400),
          ]),
        );

        for (const targetSide of targetSides) {
          const scale = targetSide / longestSide;
          const width = Math.max(1, Math.round(sourceWidth * scale));
          const height = Math.max(1, Math.round(sourceHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('canvas unavailable');
          ctx.imageSmoothingEnabled = scale < 1;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(source, 0, 0, width, height);
          if (analyzeImageData(ctx.getImageData(0, 0, width, height))) return;
        }
      } catch {
        setScanError('图片读取失败，请换一张图片重试。');
      } finally {
        bitmap?.close();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    },
    [analyzeImageData],
  );
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith('image/'),
      );
      if (file) analyzeFile(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [analyzeFile]);
  const stopCamera = useCallback(() => {
    if (cameraTimer.current) window.clearInterval(cameraTimer.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
    setCameraOn(false);
  }, []);
  const startCamera = useCallback(async () => {
    try {
      setScanError('');
      if (!navigator.mediaDevices?.getUserMedia) {
        setScanError('当前浏览器不支持摄像头，请用 Safari 或 Chrome 打开本站，或选择二维码图片。');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      cameraTimer.current = window.setInterval(() => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return;
        const width = Math.min(960, video.videoWidth),
          height = Math.round(video.videoHeight * (width / video.videoWidth)),
          canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, width, height);
        if (analyzeImageData(ctx.getImageData(0, 0, width, height)))
          stopCamera();
      }, 350);
    } catch {
      setScanError('无法打开摄像头。请确认权限，并使用 localhost 或 HTTPS。');
      stopCamera();
    }
  }, [analyzeImageData, stopCamera]);
  const attachCamera = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (!video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    void video.play().catch(() => {
      setScanError('摄像头视频无法播放，请检查浏览器权限后重试。');
      stopCamera();
    });
  }, [stopCamera]);
  useEffect(() => () => stopCamera(), [stopCamera]);
  useEffect(() => {
    if (scan && experience === 'advanced')
      requestAnimationFrame(() =>
        resultRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        }),
      );
  }, [scan, experience]);
  const minOutputSize = Math.max(128, ((matrix?.size ?? 21) + 8) * 2);
  const outputPixels = Number(outputSize);
  const outputSizeValid =
    Number.isInteger(outputPixels) &&
    outputPixels >= minOutputSize &&
    outputPixels <= 4096;
  const downloadPng = () => {
    if (!matrix) return;
    if (experience === 'simple') {
      canvasRef.current?.toBlob(
        (blob) => blob && fileDownload('qr-lab.png', blob),
      );
      return;
    }
    if (!outputSizeValid) return;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = outputPixels;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const moduleSize = Math.floor(outputPixels / (matrix.size + 8));
    const offset = Math.floor((outputPixels - matrix.size * moduleSize) / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outputPixels, outputPixels);
    ctx.fillStyle = '#000000';
    matrix.data.forEach((value, index) => {
      if (value)
        ctx.fillRect(
          offset + (index % matrix.size) * moduleSize,
          offset + Math.floor(index / matrix.size) * moduleSize,
          moduleSize,
          moduleSize,
        );
    });
    canvas.toBlob(
      (blob) => blob && fileDownload(`qr-lab-${outputPixels}px.png`, blob),
    );
  };
  const downloadJson = () => {
    if (!generated.qr || !matrix) return;
    fileDownload(
      'qr-lab-analysis.json',
      JSON.stringify(
        {
          schemaVersion: 1,
          standard: 'QR Code Model 2',
          payload: text,
          version: generated.qr.version,
          dimension: matrix.size,
          ecc,
          mask: generated.qr.maskPattern,
          segments,
          matrix: { order: 'row-major', dark: Array.from(matrix.data) },
          maskScores,
        },
        null,
        2,
      ),
    );
  };
  const selectedInfo =
    matrix && selectedModule !== undefined
      ? {
          row: Math.floor(selectedModule / matrix.size),
          col: selectedModule % matrix.size,
          dark: Boolean(matrix.data[selectedModule]),
          reserved: Boolean(matrix.reserved?.[selectedModule]),
        }
      : undefined;

  const CameraButton = ({ large = false }: { large?: boolean }) => (
    <Button
      className={`zen-button ${large ? 'large-button' : ''}`}
      variant="outline"
      onClick={cameraOn ? stopCamera : startCamera}
    >
      {cameraOn ? (
        <>
          <Pause />
          停止摄像头
        </>
      ) : (
        <>
          <Camera />
          打开摄像头
        </>
      )}
    </Button>
  );
  const ScanResult = ({ advanced = false }: { advanced?: boolean }) => {
    if (advanced ? !scan : scanHistory.length === 0) return null;
    const clearResults = () => {
      setScan(undefined);
      setScanHistory([]);
    };
    return (
      <section
        ref={resultRef}
        className={`scan-result ${advanced ? 'advanced-result' : ''}`}
      >
        <div className="result-header">
          <div>
            <span>识别完成</span>
            <h2>
              {advanced ? '扫码结果' : `扫码记录（${scanHistory.length}）`}
            </h2>
          </div>
          <Button variant="ghost" onClick={clearResults}>
            <X />
            清除全部
          </Button>
        </div>
        {advanced && scan ? (
          <>
            <div className="decoded-text">
              <span>二维码内容</span>
              <pre>{scan.decoded.data || '(二进制内容)'}</pre>
              <Button
                variant="outline"
                onClick={() =>
                  navigator.clipboard?.writeText(scan.decoded.data)
                }
              >
                <Copy />
                复制
              </Button>
            </div>
            <div className="scan-columns">
              <div className="scan-matrix-card">
                {scan.matrix && <MatrixView matrix={scan.matrix} />}
                <span>采样矩阵 · {17 + scan.decoded.version * 4}²</span>
              </div>
              <div className="scan-details">
                <div className="info-grid">
                  <Stat label="SYMBOL" value="QR MODEL 2" />
                  <Stat
                    label="VERSION"
                    value={`V${scan.decoded.version}`}
                    accent
                  />
                  <Stat
                    label="DIMENSION"
                    value={`${17 + scan.decoded.version * 4}×${17 + scan.decoded.version * 4}`}
                  />
                  <Stat label="ECC" value={scan.format?.ecc ?? '未恢复'} />
                  <Stat
                    label="MASK"
                    value={scan.format?.mask ?? '未恢复'}
                    accent
                  />
                  <Stat
                    label="RAW BYTES"
                    value={scan.decoded.binaryData.length}
                  />
                  <Stat label="IMAGE" value={`${scan.width}×${scan.height}`} />
                  <Stat label="SEGMENTS" value={scan.decoded.chunks.length} />
                </div>
                <div className="tech-block">
                  <span>RAW BYTES · HEX</span>
                  <code>
                    {scan.decoded.binaryData
                      .map((byte) =>
                        byte.toString(16).padStart(2, '0').toUpperCase(),
                      )
                      .join(' ') || '—'}
                  </code>
                </div>
                {scan.format && (
                  <div className="tech-block">
                    <span>FORMAT INFORMATION</span>
                    <code>
                      A {bits(scan.format.observedA, 15)}
                      {`\n`}B {bits(scan.format.observedB, 15)}
                      {`\n`}↳ {bits(scan.format.corrected, 15)} · distance{' '}
                      {scan.format.distance}
                    </code>
                  </div>
                )}
                <div className="tech-block">
                  <span>SEGMENTS</span>
                  <div className="chunk-list">
                    {scan.decoded.chunks.map((chunk, i) => (
                      <div key={i}>
                        <b>
                          {String((chunk as { type?: string }).type ?? 'data')}
                        </b>
                        <span>
                          {'text' in chunk
                            ? String(chunk.text).length
                            : 'bytes' in chunk
                              ? chunk.bytes.length
                              : '—'}{' '}
                          units
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="geometry-strip">
              <Stat
                label="TOP LEFT"
                value={`${Math.round(scan.decoded.location.topLeftCorner.x)}, ${Math.round(scan.decoded.location.topLeftCorner.y)}`}
              />
              <Stat
                label="TOP RIGHT"
                value={`${Math.round(scan.decoded.location.topRightCorner.x)}, ${Math.round(scan.decoded.location.topRightCorner.y)}`}
              />
              <Stat
                label="BOTTOM LEFT"
                value={`${Math.round(scan.decoded.location.bottomLeftCorner.x)}, ${Math.round(scan.decoded.location.bottomLeftCorner.y)}`}
              />
              <Stat
                label="ALIGNMENT"
                value={
                  scan.decoded.location.bottomRightAlignmentPattern
                    ? 'DETECTED'
                    : 'INFERRED'
                }
              />
            </div>
          </>
        ) : (
          <div className="scan-history" aria-label="扫码历史记录">
            {scanHistory.map((entry, index) => (
              <div className="decoded-text scan-history-item" key={entry.id}>
                <span>
                  {index === 0
                    ? '最新结果'
                    : `扫码记录 ${scanHistory.length - index}`}
                  <small>V{entry.decoded.version}</small>
                </span>
                <pre>{entry.decoded.data || '(二进制内容)'}</pre>
                <Button
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard?.writeText(entry.decoded.data)
                  }
                >
                  <Copy />
                  复制
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  if (desktopPower !== 'on')
    return (
      <main className={`xp-session-screen ${desktopPower}`}>
        <div className="xp-session-card">
          {desktopPower === 'logout' ? (
            <LogOut size={44} />
          ) : (
            <Power size={44} />
          )}
          <h1>
            {desktopPower === 'logout' ? '已注销 QR Lab' : 'QR Lab 已关机'}
          </h1>
          <p>当前内容已保留，可随时返回。</p>
          <Button
            onClick={() => {
              setDesktopPower('on');
              setWindowClosed(false);
              setWindowMinimized(false);
            }}
          >
            {desktopPower === 'logout' ? '重新登录' : '启动 QR Lab'}
          </Button>
        </div>
      </main>
    );

  return (
    <main className={`app-shell ${experience} scheme-luna`}>
      <div className="desktop-area">
        {!windowClosed && (
          <section
            className={`app-window ${windowMaximized ? 'maximized' : ''} ${windowMinimized ? 'minimized' : ''}`}
          >
            <header className="topbar">
              <div className="brand">
                <div className="brand-mark">
                  <img src="/qr-code-xp/xp/icon-qr.svg" alt="" aria-hidden="true" />
                </div>
                <div>
                  <b>QR Lab</b>
                </div>
              </div>
              <div className="window-title">QR Lab — 二维码实验台</div>
              <div className="window-controls">
                <button
                  onClick={() => setWindowMinimized(true)}
                  aria-label="最小化"
                >
                  —
                </button>
                <button
                  onClick={() => setWindowMaximized((value) => !value)}
                  aria-label={windowMaximized ? '还原' : '最大化'}
                >
                  {windowMaximized ? '❐' : '□'}
                </button>
                <button
                  className="close-control"
                  onClick={() => setWindowClosed(true)}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
            </header>
            <nav className="xp-app-menubar" aria-label="应用菜单">
              <span>文件(F)</span>
              <span>编辑(E)</span>
              <span>查看(V)</span>
              <span>帮助(H)</span>
            </nav>
            <Tabs
              value={activeTab}
              onValueChange={(value) => {
                setActiveTab(value);
                if (value === 'scan') setScanError('');
              }}
              className="workspace-tabs"
            >
              <div className="xp-toolbar">
                <TabsList variant="line" className="main-tabs">
                  <TabsTrigger value="generate">
                    <img
                      className="xp-toolbar-icon"
                      src="/qr-code-xp/xp/icon-generate.svg"
                      alt=""
                      aria-hidden="true"
                    />
                    生成二维码
                  </TabsTrigger>
                  <TabsTrigger value="scan">
                    <img
                      className="xp-toolbar-icon"
                      src="/qr-code-xp/xp/icon-scan.svg"
                      alt=""
                      aria-hidden="true"
                    />
                    扫描二维码
                  </TabsTrigger>
                </TabsList>
                <span className="toolbar-spacer" />
                {experience === 'advanced' && (
                  <span className="build-tag">QR MODEL 2 · V1–40</span>
                )}
                <div className="privacy-pill">
                  <ShieldCheck /> 本地处理
                </div>
              </div>

              <TabsContent value="generate">
                {experience === 'simple' ? (
                  <section className="simple-generate zen-surface">
                    <div className="sand-rings rings-a" />
                    <div className="sand-current current-a" />
                    <fieldset className="simple-copy xp-group">
                      <legend>输入内容</legend>
                      <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="输入文字或网址…"
                        rows={4}
                        spellCheck={false}
                      />
                      {generated.error && (
                        <div className="error-box">
                          <X />
                          {generated.error}
                        </div>
                      )}
                      <div className="simple-actions">
                        <Button onClick={downloadPng} disabled={!matrix}>
                          <Download />
                          下载二维码
                        </Button>
                        <small>
                          {text
                            ? `${new TextEncoder().encode(text).length} 字节`
                            : '输入后自动生成'}
                        </small>
                      </div>
                    </fieldset>
                    <fieldset className="simple-qr xp-group preview-group">
                      <legend>二维码预览</legend>
                      <div
                        className={`stone-frame ${matrix ? '' : 'empty'} ${matrix && matrix.size >= 97 ? 'dense' : ''}`}
                      >
                        {matrix ? (
                          <canvas
                            ref={setQrCanvas}
                            width={348}
                            height={348}
                            aria-label="生成的二维码"
                          />
                        ) : (
                          <QrCode aria-label="等待输入内容" />
                        )}
                      </div>
                    </fieldset>
                  </section>
                ) : (
                  <section className="workspace-grid">
                    <section className="panel controls-panel">
                      <div className="panel-heading">
                        <span>一</span>
                        <div>
                          <h2>编码输入</h2>
                          <p>选择内容与编码约束</p>
                        </div>
                      </div>
                      <label className="field-label" htmlFor="payload">
                        内容
                      </label>
                      <textarea
                        id="payload"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        className="payload-input"
                        rows={5}
                        placeholder="输入文字或网址…"
                        spellCheck={false}
                      />
                      <div className="byte-count">
                        <span>
                          {new TextEncoder().encode(text).length} BYTES
                        </span>
                        <span>{text.length} UTF-16 UNITS</span>
                      </div>
                      <div className="control-grid">
                        <label>
                          <span>编码模式</span>
                          <NativeSelect
                            value={mode}
                            onChange={(e) =>
                              setMode(e.target.value as EncodeMode)
                            }
                          >
                            <NativeSelectOption value="auto">
                              自动分段
                            </NativeSelectOption>
                            <NativeSelectOption value="numeric">
                              Numeric
                            </NativeSelectOption>
                            <NativeSelectOption value="alphanumeric">
                              Alphanumeric
                            </NativeSelectOption>
                            <NativeSelectOption value="byte">
                              Byte / UTF-8
                            </NativeSelectOption>
                          </NativeSelect>
                        </label>
                        <label>
                          <span>纠错等级</span>
                          <NativeSelect
                            value={ecc}
                            onChange={(e) => setEcc(e.target.value as Ecc)}
                          >
                            <NativeSelectOption value="L">
                              L · 约 7%
                            </NativeSelectOption>
                            <NativeSelectOption value="M">
                              M · 约 15%
                            </NativeSelectOption>
                            <NativeSelectOption value="Q">
                              Q · 约 25%
                            </NativeSelectOption>
                            <NativeSelectOption value="H">
                              H · 约 30%
                            </NativeSelectOption>
                          </NativeSelect>
                        </label>
                        <label>
                          <span>Version</span>
                          <NativeSelect
                            value={version}
                            onChange={(e) => setVersion(e.target.value)}
                          >
                            <NativeSelectOption value="auto">
                              Auto · 最小适配
                            </NativeSelectOption>
                            {Array.from({ length: 40 }, (_, i) => (
                              <NativeSelectOption
                                key={i + 1}
                                value={String(i + 1)}
                              >
                                Version {i + 1}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </label>
                        <label>
                          <span>Mask</span>
                          <NativeSelect
                            value={mask}
                            onChange={(e) => setMask(e.target.value)}
                          >
                            <NativeSelectOption value="auto">
                              Auto · 最低罚分
                            </NativeSelectOption>
                            {Array.from({ length: 8 }, (_, i) => (
                              <NativeSelectOption key={i} value={String(i)}>
                                Mask {i}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </label>
                      </div>
                      {generated.error && (
                        <div className="error-box">
                          <X />
                          {generated.error}
                        </div>
                      )}
                      <div className="section-rule">
                        <span>SEGMENTS</span>
                      </div>
                      <div className="segment-list">
                        {segments.map((segment) => (
                          <div className="segment-card" key={segment.index}>
                            <span
                              className={`mode-dot mode-${segment.mode.toLowerCase()}`}
                            />
                            <div>
                              <b>{segment.mode}</b>
                              <small>
                                {segment.count} units · {segment.bitLength} bits
                              </small>
                            </div>
                            <code>{segment.modeBits}</code>
                          </div>
                        ))}
                      </div>
                      <div className="output-resolution">
                        <label htmlFor="output-resolution">
                          输出分辨率（像素）
                        </label>
                        <div className="resolution-input-row">
                          <Input
                            id="output-resolution"
                            type="number"
                            min={minOutputSize}
                            max={4096}
                            step={1}
                            value={outputSize}
                            onChange={(event) =>
                              setOutputSize(event.target.value)
                            }
                            aria-invalid={!outputSizeValid}
                            aria-describedby="resolution-help"
                          />
                          <span>
                            × {outputSizeValid ? outputPixels : '—'} px
                          </span>
                        </div>
                        <small
                          id="resolution-help"
                          role={outputSizeValid ? undefined : 'alert'}
                        >
                          {outputSizeValid
                            ? `PNG 尺寸 ${outputPixels} × ${outputPixels}，保留白边与清晰像素。`
                            : `请输入 ${minOutputSize}–4096 之间的整数。`}
                        </small>
                      </div>
                      <div className="action-row">
                        <Button
                          onClick={downloadPng}
                          disabled={!matrix || !outputSizeValid}
                        >
                          <Download /> PNG
                        </Button>
                        <Button
                          variant="outline"
                          onClick={downloadJson}
                          disabled={!matrix}
                        >
                          <FlaskConical /> Analysis JSON
                        </Button>
                      </div>
                    </section>
                    <section className="visual-panel">
                      <div className={`qr-stage ${matrix ? '' : 'empty'}`}>
                        {matrix ? (
                          <canvas
                            ref={setQrCanvas}
                            width={348}
                            height={348}
                            aria-label="生成的二维码"
                          />
                        ) : (
                          <>
                            <QrCode />
                            <span>输入内容后生成</span>
                          </>
                        )}
                      </div>
                      {generated.qr && matrix && (
                        <div className="primary-stats">
                          <Stat
                            label="VERSION"
                            value={`V${generated.qr.version}`}
                            accent
                          />
                          <Stat
                            label="DIMENSION"
                            value={`${matrix.size}×${matrix.size}`}
                          />
                          <Stat label="ECC" value={ecc} />
                          <Stat
                            label="MASK"
                            value={generated.qr.maskPattern ?? '—'}
                            accent
                          />
                        </div>
                      )}
                      <div className="bitstream-card">
                        <div className="card-title">
                          <span>DATA BIT STREAM</span>
                          <span>
                            {payloadBits.replace(/\[[^\]]+\]/g, '').length}{' '}
                            VISIBLE BITS
                          </span>
                        </div>
                        <code>
                          {payloadBits.slice(0, 360) || '—'}
                          {payloadBits.length > 360 ? '…' : ''}
                        </code>
                      </div>
                    </section>
                    <aside className="panel inspector-panel">
                      <div className="panel-heading">
                        <span>二</span>
                        <div>
                          <h2>技术检查器</h2>
                          <p>点击矩阵模块查看来源</p>
                        </div>
                      </div>
                      {matrix && (
                        <MatrixView
                          matrix={matrix}
                          selected={selectedModule}
                          onSelect={setSelectedModule}
                        />
                      )}
                      <div className="legend">
                        <span>
                          <i className="legend-function" />
                          功能模块
                        </span>
                        <span>
                          <i className="legend-data" />
                          数据 / ECC
                        </span>
                      </div>
                      <div className="module-readout">
                        <span className="readout-label">SELECTED MODULE</span>
                        {selectedInfo ? (
                          <>
                            <div className="coords">
                              R{selectedInfo.row}
                              <i>/</i>C{selectedInfo.col}
                            </div>
                            <div className="readout-grid">
                              <Stat
                                label="VALUE"
                                value={selectedInfo.dark ? 'DARK' : 'LIGHT'}
                              />
                              <Stat
                                label="ROLE"
                                value={
                                  selectedInfo.reserved
                                    ? 'FUNCTION'
                                    : 'DATA / ECC'
                                }
                              />
                            </div>
                          </>
                        ) : (
                          <p>选择任意模块，检查它的坐标、颜色和结构角色。</p>
                        )}
                      </div>
                      <div className="section-rule">
                        <span>MASK PENALTY</span>
                      </div>
                      <div className="mask-list">
                        {maskScores.map((score) => (
                          <div
                            key={score.mask}
                            className={
                              score.mask === generated.qr?.maskPattern
                                ? 'active-mask'
                                : ''
                            }
                          >
                            <span>M{score.mask}</span>
                            <div>
                              <i
                                style={{
                                  width: `${Math.min(100, score.total / 7)}%`,
                                }}
                              />
                            </div>
                            <b>{score.total}</b>
                            {score.mask === generated.qr?.maskPattern && (
                              <Check />
                            )}
                          </div>
                        ))}
                      </div>
                      {generated.qr && (
                        <p className="explanation">
                          {version === 'auto'
                            ? `自动选择 Version ${generated.qr.version}。`
                            : `使用指定的 Version ${generated.qr.version}。`}
                          {mask === 'auto'
                            ? `Mask ${generated.qr.maskPattern} 由标准罚分自动选出。`
                            : `使用指定的 Mask ${generated.qr.maskPattern}。`}
                        </p>
                      )}
                    </aside>
                  </section>
                )}
              </TabsContent>

              <TabsContent value="scan">
                {experience === 'simple' ? (
                  <section
                    className={`simple-scan zen-surface ${scan ? 'has-result' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      const file = e.dataTransfer.files[0];
                      if (file) analyzeFile(file);
                    }}
                  >
                    <div className="sand-rings rings-b" />
                    <div className="sand-current current-b" />
                    <div className="simple-scan-heading">
                      <h1>扫描一枚二维码</h1>
                      <p>选择图片、拖入页面，或打开摄像头。</p>
                    </div>
                    <div
                      className={`scan-buttons ${dragging ? 'dragging' : ''} ${scan ? 'has-result' : ''}`}
                    >
                      <UploadButton large={!scan} onFile={analyzeFile} />
                      <CameraButton large={!scan} />
                    </div>
                    {cameraOn && (
                      <div className="camera-box compact">
                        <video ref={attachCamera} autoPlay muted playsInline />
                      </div>
                    )}
                    {scanError && (
                      <div className="error-box" role="alert">
                        <X />
                        <span>{scanError}</span>
                        <button
                          onClick={() => setScanError('')}
                          aria-label="关闭错误提示"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    <ScanResult />
                  </section>
                ) : (
                  <section className="advanced-scan">
                    <div className="scan-toolbar">
                      <div>
                        <span className="eyebrow">图像来源</span>
                        <h1>扫描与技术分析</h1>
                      </div>
                      <div className="toolbar-buttons">
                        <UploadButton onFile={analyzeFile} />
                        <CameraButton />
                      </div>
                    </div>
                    {cameraOn && (
                      <div className="camera-box compact">
                        <video ref={attachCamera} autoPlay muted playsInline />
                      </div>
                    )}
                    {scanError && (
                      <div className="error-box" role="alert">
                        <X />
                        <span>{scanError}</span>
                        <button
                          onClick={() => setScanError('')}
                          aria-label="关闭错误提示"
                        >
                          ×
                        </button>
                      </div>
                    )}
                    {!scan && (
                      <div className="empty-scan">
                        <ScanLine />
                        <h2>等待二维码</h2>
                        <p>选择图片、拖入页面，或直接粘贴截图。</p>
                      </div>
                    )}
                    <ScanResult advanced />
                  </section>
                )}
              </TabsContent>
              <div className="window-statusbar" aria-label="窗口状态">
                <span className="status-ready">
                  <i /> {activeTab === 'generate' ? '就绪' : '等待扫描'}
                </span>
                <span>{experience === 'simple' ? '简易模式' : '高级模式'}</span>
                <span>
                  {activeTab === 'generate'
                    ? `${new TextEncoder().encode(text).length} 字节`
                    : scan
                      ? `已识别 · V${scan.decoded.version}`
                      : '尚无结果'}
                </span>
                <i className="status-gripper" aria-hidden="true" />
              </div>
            </Tabs>
          </section>
        )}
        {windowClosed && (
          <div className="closed-desktop">
            <QrCode />
            <h1>QR Lab 已关闭</h1>
            <p>点击任务栏中的 QR Lab 图标重新打开。</p>
          </div>
        )}
      </div>
      {startOpen && (
        <>
          <div
            className="start-menu-backdrop"
            onPointerDown={() => setStartOpen(false)}
            aria-hidden="true"
          />
          <aside className="start-menu">
            <div className="start-owner">
              <div className="owner-avatar">
                <img src="/qr-code-xp/momo-avatar.jpg" alt="momo" />
              </div>
              <b>momo</b>
            </div>
            <div className="start-menu-body">
              <div className="start-items">
                <button
                  onClick={() => {
                    setWindowClosed(false);
                    setWindowMinimized(false);
                    setStartOpen(false);
                  }}
                >
                  <span className="start-app-icon">
                    <img src="/qr-code-xp/xp/icon-qr.svg" alt="" aria-hidden="true" />
                  </span>
                  <span>
                    <b>QR Lab</b>
                    <small>二维码实验台</small>
                  </span>
                </button>
                <div className="start-program-separator">
                  <span>程序模式</span>
                </div>
                <button
                  className={experience === 'simple' ? 'selected-mode' : ''}
                  onClick={() => {
                    setExperience('simple');
                    setStartOpen(false);
                  }}
                >
                  <span className="start-app-icon mode-icon">
                    <img
                      src="/qr-code-xp/xp/icon-generate.svg"
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  <span>
                    <b>简易模式</b>
                  </span>
                </button>
                <button
                  className={experience === 'advanced' ? 'selected-mode' : ''}
                  onClick={() => {
                    setExperience('advanced');
                    setStartOpen(false);
                  }}
                >
                  <span className="start-app-icon mode-icon">
                    <img
                      src="/qr-code-xp/xp/icon-settings.svg"
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  <span>
                    <b>高级模式</b>
                  </span>
                </button>
              </div>
              <div className="start-links" aria-label="系统位置">
                <span>
                  <i className="start-link-icon folder-icon" />
                  <b>我的文档</b>
                </span>
                <span>
                  <i className="start-link-icon computer-icon" />
                  <b>我的电脑</b>
                </span>
                <span className="start-link-divider" />
                <span>
                  <i className="start-link-icon control-icon" />
                  <b>控制面板</b>
                </span>
                <span>
                  <i className="start-link-icon help-icon">?</i>
                  <b>帮助和支持</b>
                </span>
              </div>
            </div>
            <div className="start-power-footer">
              <button
                onClick={() => {
                  stopCamera();
                  setStartOpen(false);
                  setDesktopPower('logout');
                }}
              >
                <span className="xp-power-icon logout-icon">
                  <LogOut aria-hidden="true" />
                </span>
                注销
              </button>
              <button
                onClick={() => {
                  stopCamera();
                  setStartOpen(false);
                  setDesktopPower('shutdown');
                }}
              >
                <span className="xp-power-icon shutdown-icon">
                  <Power aria-hidden="true" />
                </span>
                关机
              </button>
            </div>
          </aside>
        </>
      )}
      <footer className="xp-taskbar">
        <button
          className={`start-button ${startOpen ? 'active' : ''}`}
          onClick={() => setStartOpen((value) => !value)}
        >
          <b>开始</b>
        </button>
        <button
          className={`task-app ${!windowClosed && !windowMinimized ? 'active' : ''}`}
          aria-label="QR Lab 窗口"
          onClick={() => {
            if (windowClosed) {
              setWindowClosed(false);
              setWindowMinimized(false);
            } else {
              setWindowMinimized((value) => !value);
            }
          }}
        >
          <span className="task-app-icon">
            <img src="/qr-code-xp/xp/icon-qr.svg" alt="" aria-hidden="true" />
          </span>
          <b className="task-app-label">QR Lab</b>
        </button>
        <span className="taskbar-space" />
        <div className="system-tray">
          <a
            className="tray-potato"
            href="https://www.xiaohongshu.com/user/profile/62be9d5500000000190283a7"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="打开小红书主页"
            title="打开小红书主页"
          >
            🍠
          </a>
          <DesktopClock />
        </div>
      </footer>
    </main>
  );
}
