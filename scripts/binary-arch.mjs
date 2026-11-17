import { Buffer } from "node:buffer";
import fs from "node:fs";

const MACHO_64_LE = 0xfeedfacf;
const MACHO_FAT_BE = 0xcafebabe;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

const PE_MACHINE_AMD64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;
const PE_MACHINE_I386 = 0x014c;

function mapMachoCpuType(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return "x64";
  if (cpuType === CPU_TYPE_ARM64) return "arm64";
  return null;
}

export function detectBinaryArchs(buffer) {
  if (buffer.length < 8) {
    return [];
  }

  const magicLE = buffer.readUInt32LE(0);
  if (magicLE === MACHO_64_LE) {
    const arch = mapMachoCpuType(buffer.readUInt32LE(4));
    return arch ? [arch] : [];
  }

  const magicBE = buffer.readUInt32BE(0);
  if (magicBE === MACHO_64_LE) {
    const arch = mapMachoCpuType(buffer.readUInt32BE(4));
    return arch ? [arch] : [];
  }

  if (magicBE === MACHO_FAT_BE) {
    const nfatArch = buffer.readUInt32BE(4);
    if (nfatArch > 0 && nfatArch <= 16 && buffer.length >= 8 + nfatArch * 20) {
      const archs = [];
      for (let i = 0; i < nfatArch; i += 1) {
        const arch = mapMachoCpuType(buffer.readUInt32BE(8 + i * 20));
        if (arch && !archs.includes(arch)) {
          archs.push(arch);
        }
      }
      if (archs.length > 0) {
        return archs;
      }
    }
  }

  if (buffer.length >= 0x40 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset + 6 <= buffer.length &&
      buffer[peOffset] === 0x50 &&
      buffer[peOffset + 1] === 0x45 &&
      buffer[peOffset + 2] === 0 &&
      buffer[peOffset + 3] === 0
    ) {
      const machine = buffer.readUInt16LE(peOffset + 4);
      if (machine === PE_MACHINE_AMD64) return ["x64"];
      if (machine === PE_MACHINE_ARM64) return ["arm64"];
      if (machine === PE_MACHINE_I386) return ["ia32"];
    }
  }

  return [];
}

export function readBinaryArchs(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    return detectBinaryArchs(header.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }
}

export function assertBinaryArch(filePath, expectedArch, options = {}) {
  const { allowUniversal = false } = options;
  const archs = readBinaryArchs(filePath);
  if (archs.length === 0) {
    throw new Error(`Unable to detect binary architecture for ${filePath}`);
  }
  const matches = allowUniversal
    ? archs.includes(expectedArch)
    : archs.length === 1 && archs[0] === expectedArch;
  if (!matches) {
    throw new Error(
      `Binary architecture mismatch for ${filePath}: expected ${expectedArch}, found [${archs.join(", ")}]`,
    );
  }
  return archs;
}
