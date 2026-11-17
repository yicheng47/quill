export type BinaryArch = "arm64" | "x64" | "ia32";

export function detectBinaryArchs(buffer: Uint8Array): BinaryArch[];
export function readBinaryArchs(filePath: string): BinaryArch[];
export function assertBinaryArch(
  filePath: string,
  expectedArch: BinaryArch,
  options?: { allowUniversal?: boolean },
): BinaryArch[];
