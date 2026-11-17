export interface MacUpdateFileEntry {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
}

export interface MacUpdateManifest {
  version: string;
  files: MacUpdateFileEntry[];
  path: string;
  sha512: string;
  releaseDate: string;
  releaseName?: string;
  releaseNotes?: string | Array<{ version: string; note: string }>;
  minimumSystemVersion?: string;
}

export function mergeMacUpdateYml(arm64YamlText: string, x64YamlText: string): string;
export function verifyMergedMacUpdateYml(
  yamlText: string,
  expectedVersion?: string,
): MacUpdateManifest;
