export type FormatErrorCode =
  | 'bad-magic' | 'unsupported-version' | 'truncated' | 'crc-mismatch' | 'invalid-manifest' | 'limit-exceeded'
  | 'unsupported-feature' | 'corrupt-tile';

export class PsFormatError extends Error {
  constructor(public code: FormatErrorCode, message: string) { super(message); this.name = 'PsFormatError'; }
}
