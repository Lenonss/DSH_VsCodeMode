/** Shared logical-line comparison; never rewrites stored patch or file bytes. @author ddj 2026年10月28号 */

/** @public @author ddj 2026年10月28号 @param text Decoded text. @returns Text without one leading Unicode BOM. */
export function stripBom(text: string): string { return text.replace(/^\uFEFF/, '') }

/** @public @author ddj 2026年10月28号 @param line Physical line. @returns Line without one terminal CRLF, CR or LF; other whitespace stays intact. */
export function logicalLine(line: string): string { return line.replace(/(?:\r\n|\r|\n)$/, '') }

/** @public @author ddj 2026年10月28号 @param text Decoded file text. @returns Logical lines excluding BOM, retaining the final empty line after a terminator. */
export function logicalLines(text: string): string[] { return stripBom(text).split(/\r\n|\r|\n/) }
