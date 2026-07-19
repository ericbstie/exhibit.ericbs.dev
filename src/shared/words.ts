/**
 * Minimal shell-word splitter for SSH_ORIGINAL_COMMAND: honors single/double
 * quotes and backslash escapes — enough to round-trip what `ex` sends.
 */
export function splitWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t") {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      i++;
    } else if (ch === "'") {
      started = true;
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated single quote");
      current += input.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      started = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) i++;
        current += input[i];
        i++;
      }
      if (i >= input.length) throw new Error("unterminated double quote");
      i++;
    } else if (ch === "\\" && i + 1 < input.length) {
      started = true;
      current += input[i + 1];
      i += 2;
    } else {
      started = true;
      current += ch;
      i++;
    }
  }
  if (started) words.push(current);
  return words;
}

/** Quote a word for a POSIX shell (the remote end of the ssh exec). */
export function quoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
