const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";

function supportsColor(): boolean {
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

export function toneColor(tone: "info" | "success" | "warning" | "danger" | "accent" | "magic"): string {
  switch (tone) {
    case "success":
      return GREEN;
    case "warning":
      return YELLOW;
    case "danger":
      return RED;
    case "accent":
      return BLUE;
    case "magic":
      return MAGENTA;
    default:
      return CYAN;
  }
}

export function colorize(text: string, tone: "info" | "success" | "warning" | "danger" | "accent" | "magic", bold = false): string {
  if (!supportsColor()) return text;
  return `${bold ? BOLD : ""}${toneColor(tone)}${text}${RESET}`;
}

export function dim(text: string): string {
  if (!supportsColor()) return text;
  return `${DIM}${text}${RESET}`;
}

export function formatPanel(input: {
  title: string;
  tone: "info" | "success" | "warning" | "danger" | "accent" | "magic";
  lines: string[];
}): string {
  const width = Math.max(
    input.title.length + 8,
    ...input.lines.map((line) => line.length + 4),
    36,
  );
  const top = `┌─ ${input.title} ${"─".repeat(Math.max(0, width - input.title.length - 4))}`;
  const bottom = `└${"─".repeat(width - 1)}`;
  const body = input.lines.map((line) => `│ ${line}`);

  return [
    colorize(top, input.tone, true),
    ...body.map((line) => `${colorize("│", input.tone, true)} ${line.slice(2)}`),
    colorize(bottom, input.tone, true),
  ].join("\n");
}
